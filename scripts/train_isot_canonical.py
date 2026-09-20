#!/usr/bin/env python3
"""Canonical real-data training pipeline for TruthLens AI Phase 9.

Training produces a versioned candidate only. It NEVER writes the production
runtime artifact data/saved_model_artifacts.json.
"""
import argparse, hashlib, json, os, platform, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, average_precision_score,
    brier_score_loss, confusion_matrix, f1_score, precision_score,
    recall_score, roc_auc_score)
from sklearn.svm import LinearSVC

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/"data"
PREP=DATA/"isot_prepared"
DEFAULT_OUT=ROOT/"artifacts"/"models"
SEED=42
TFIDF_CONFIG={"ngram_range":(1,2),"max_features":100000,"min_df":2,
              "sublinear_tf":True,"strip_accents":"unicode","stop_words":"english"}
REUTERS_RE=__import__("re").compile(r"^[A-Z][A-Za-z\.\s,]{2,40}\(Reuters\)\s*-\s*")

def sha256(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""): h.update(chunk)
    return h.hexdigest()

def git_sha():
    try: return subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
    except Exception: return "unknown"

def fingerprint(config):
    payload={"fake_sha256":sha256(DATA/"Fake.csv"),
             "true_sha256":sha256(DATA/"True.csv"),
             "schema":["title","text","subject","date"],
             "preparation":config}
    return hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(",",":")).encode()).hexdigest(),payload

def load_articles():
    rows=[]
    for fn,label,prefix in [("True.csv",0,"REAL"),("Fake.csv",1,"FAKE")]:
        with open(DATA/fn,encoding="utf-8",newline="") as f:
            for i,r in enumerate(pd.read_csv(f,dtype=str,keep_default_na=False).to_dict("records")):
                rows.append({"id":f"{prefix}-{i}","title":r["title"].strip(),
                             "text":r["text"].strip(),"label":label})
    return {r["id"]:r for r in rows}

def ids(name):
    p=PREP/"splits"/f"{name}_ids.txt"
    if not p.exists(): raise FileNotFoundError(f"Missing {p}; run Phase 2 preparation first.")
    return [x for x in p.read_text().splitlines() if x.strip()]

def clean(x,reuters=False):
    import re
    s=f"{x['title']} {x['text']}".strip()
    if reuters: s=REUTERS_RE.sub("",s,count=1).strip()
    return s

def metrics(y,p):
    pred=(p>=.5).astype(int)
    return {"accuracy":float(accuracy_score(y,pred)),
      "precision":float(precision_score(y,pred,zero_division=0)),
      "recall":float(recall_score(y,pred,zero_division=0)),
      "f1":float(f1_score(y,pred,zero_division=0)),
      "macro_f1":float(f1_score(y,pred,average="macro",zero_division=0)),
      "roc_auc":float(roc_auc_score(y,p)),
      "pr_auc":float(average_precision_score(y,p)),
      "brier":float(brier_score_loss(y,p)),
      "confusion_matrix":confusion_matrix(y,pred).tolist()}

def ece(y,p,bins=10):
    edges=np.linspace(0,1,bins+1); out=0.0
    for lo,hi in zip(edges[:-1],edges[1:]):
        m=(p>=lo)&(p<=hi if hi==1 else p<hi)
        if m.any(): out += m.mean()*abs(float(p[m].mean())-float(y[m].mean()))
    return float(out)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--variant",choices=["raw","reuters_debiased"],default="raw")
    ap.add_argument("--output-dir",default=str(DEFAULT_OUT))
    args=ap.parse_args()

    if not (DATA/"Fake.csv").exists() or not (DATA/"True.csv").exists():
        raise SystemExit("Real ISOT CSVs are required; refusing to train on demo data.")
    if not (PREP/"stats.json").exists():
        raise SystemExit("Phase 2 preparation output missing: data/isot_prepared/stats.json")

    prep_config={"random_seed":SEED,"group_split":[.70,.15,.15],
                 "temporal_cutoff":"2017-01-01","near_duplicate_jaccard":.7,
                 "shingle_size":5,"vector_input":"title + text",
                 "variant":args.variant,"tfidf":TFIDF_CONFIG}
    fp,source_fingerprint=fingerprint(prep_config)
    version=f"isot-svm-{fp[:12]}"
    out=Path(args.output_dir)/version
    out.mkdir(parents=True,exist_ok=False)

    articles=load_articles()
    split={k:ids(k) for k in ["train","val","test","temporal_test"]}
    transform=lambda i: clean(articles[i],args.variant=="reuters_debiased")
    train_x=[transform(i) for i in split["train"]]; train_y=np.array([articles[i]["label"] for i in split["train"]])
    val_x=[transform(i) for i in split["val"]]; val_y=np.array([articles[i]["label"] for i in split["val"]])
    test_x=[transform(i) for i in split["test"]]; test_y=np.array([articles[i]["label"] for i in split["test"]])
    temp_x=[transform(i) for i in split["temporal_test"]]; temp_y=np.array([articles[i]["label"] for i in split["temporal_test"]])

    vec=TfidfVectorizer(**TFIDF_CONFIG)
    Xtr=vec.fit_transform(train_x); Xv=vec.transform(val_x); Xt=vec.transform(test_x); Xtemp=vec.transform(temp_x)

    lr=LogisticRegression(C=1.0,max_iter=1500,solver="liblinear",random_state=SEED)
    svm=LinearSVC(C=1.0,max_iter=3000,random_state=SEED,dual="auto")
    lr.fit(Xtr,train_y); svm.fit(Xtr,train_y)

    lr_val=lr.predict_proba(Xv)[:,1]
    svm_val_raw=svm.decision_function(Xv)
    lr_val_m=metrics(val_y,lr_val)
    svm_val_m=metrics(val_y,1/(1+np.exp(-np.clip(svm_val_raw,-50,50))))

    # Platt sigmoid is fit ONLY on the disjoint validation split.
    calibrator=LogisticRegression(C=1e6,max_iter=2000,solver="lbfgs",random_state=SEED)
    calibrator.fit(svm_val_raw.reshape(-1,1),val_y)
    cal_coef=float(calibrator.coef_[0,0]); cal_intercept=float(calibrator.intercept_[0])
    plattA=-cal_coef; plattB=-cal_intercept

    svm_test_p=calibrator.predict_proba(svm.decision_function(Xt).reshape(-1,1))[:,1]
    svm_temp_p=calibrator.predict_proba(svm.decision_function(Xtemp).reshape(-1,1))[:,1]
    lr_test_p=lr.predict_proba(Xt)[:,1]; lr_temp_p=lr.predict_proba(Xtemp)[:,1]

    # Selection uses validation F1; test and temporal test remain untouched until now.
    selected="linear_svm_calibrated" if svm_val_m["f1"]>=lr_val_m["f1"] else "logistic_regression"
    selected_test=metrics(test_y,svm_test_p if selected=="linear_svm_calibrated" else lr_test_p)
    selected_temp=metrics(temp_y,svm_temp_p if selected=="linear_svm_calibrated" else lr_temp_p)
    selected_val=metrics(val_y,calibrator.predict_proba(svm_val_raw.reshape(-1,1))[:,1] if selected=="linear_svm_calibrated" else lr_val)

    vocab={k:int(v) for k,v in vec.vocabulary_.items()}
    if selected=="linear_svm_calibrated":
        weights=svm.coef_[0].astype(float).tolist(); bias=float(svm.intercept_[0])
        model_name="Linear SVM (Calibrated)"
        platt_a,platt_b=plattA,plattB
    else:
        weights=lr.coef_[0].astype(float).tolist(); bias=float(lr.intercept_[0])
        model_name="Logistic Regression"
        platt_a,platt_b=-1.0,0.0

    artifact={
      "model_name":model_name,"model_type":selected,"model_version":version,
      "trained_at":datetime.now(timezone.utc).isoformat(),
      "dataset_info":{"source_path":"data/True.csv & data/Fake.csv",
        "total_samples":len(articles),"train_samples":len(train_x),"test_samples":len(test_x),
        "real_samples":sum(a["label"]==0 for a in articles.values()),
        "fake_samples":sum(a["label"]==1 for a in articles.values()),
        "vocabulary_size":len(vocab),"is_demo":False,
        "dataset_status":"ISOT CANDIDATE","evaluation_status":"Phase 9 candidate; not promoted"},
      "preprocessing":{"lowercase":True,"strip_urls":True,"strip_html":True,
        "strip_punctuation":True,"remove_stopwords":True,"min_token_length":3,
        "ngram_range":[1,2],"sublinear_tf":True},
      "vocabulary":vocab,"idf":vec.idf_.astype(float).tolist(),
      "selected_model":{"name":model_name,"weights":weights,"bias":bias,
                        "plattA":platt_a,"plattB":platt_b},
      "logistic_regression":{"weights":lr.coef_[0].astype(float).tolist(),"bias":float(lr.intercept_[0])},
      "metrics":{"validation":selected_val,"test":selected_test,"temporal_test":selected_temp,
        "candidates":{"logistic_regression":{"validation":lr_val_m},
                      "linear_svm_calibrated":{"validation":svm_val_m}}},
      "thresholds":{"fake_threshold":0.65,"real_threshold":0.35,"min_text_length":60}
    }
    artifact_path=out/"model_artifact.json"
    artifact_path.write_text(json.dumps(artifact,separators=(",",":")),encoding="utf-8")
    ah=sha256(artifact_path)
    manifest={
      "schema_version":1,"model_version":version,"created_at":artifact["trained_at"],
      "git_commit":git_sha(),"dataset_name":"ISOT Fake News Dataset",
      "dataset_fingerprint":fp,"source_file_hashes":source_fingerprint,
      "preparation_config":prep_config,"split_counts":{k:len(v) for k,v in split.items()},
      "software":{"python":platform.python_version(),"platform":platform.platform(),
                  "numpy":np.__version__,"pandas":pd.__version__},
      "model":{"family":selected,"name":model_name,"seed":SEED,
               "calibration":"Platt sigmoid on disjoint validation split",
               "tfidf":TFIDF_CONFIG},
      "metrics":{"validation":selected_val,"test":selected_test,"temporal_test":selected_temp,
                 "ece_10_test":ece(test_y,svm_test_p if selected=="linear_svm_calibrated" else lr_test_p),
                 "ece_10_temporal":ece(temp_y,svm_temp_p if selected=="linear_svm_calibrated" else lr_temp_p)},
      "artifact_sha256":ah,"external_validation":{"status":"PENDING","path":"external_validation.json"},
      "production_eligible":False,"promotion_status":"CANDIDATE_ONLY",
      "production_artifact":"data/saved_model_artifacts.json"
    }
    (out/"manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    (out/"metrics.json").write_text(json.dumps(manifest["metrics"],indent=2),encoding="utf-8")
    print(json.dumps({"model_version":version,"candidate":str(out),"dataset_fingerprint":fp,
                      "selected_model":model_name,"test_f1":selected_test["f1"],
                      "temporal_f1":selected_temp["f1"],"production_artifact_modified":False},indent=2))

if __name__=="__main__": main()
