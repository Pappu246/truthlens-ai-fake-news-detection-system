#!/usr/bin/env python3
"""Candidate-only publisher-held-out runtime model; never promotion eligible."""
from __future__ import annotations
import argparse, hashlib, json, math, platform, re, sys, zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
import numpy as np
import pandas as pd
from publicsuffix2 import get_sld
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, average_precision_score, balanced_accuracy_score, brier_score_loss, confusion_matrix, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.svm import LinearSVC
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
from isot_data_pipeline import near_duplicate_groups
DATASET="PolyglotFakeFacts v2.0"
ARCHIVE_SHA="06762bfccc55c3236e51bab2d8907218c4c2705e84e3932a5587d29f9879016e"
SEED=42; FAKE_THRESHOLD=.98; REAL_THRESHOLD=.35; MIN_CHARS=300; MIN_WORDS=50; MIN_EXTERNAL_SAMPLES=10000
SHORTENERS={"bit.ly","t.co","tinyurl.com","goo.gl","ow.ly","is.gd","buff.ly","trib.al","sptnkne.ws"}
STOPWORDS=set("""a about above after again against all am an and any are aren't as at be because been before being below between both but by can cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves""".split())
PUNCT_RE=re.compile(r"""[.,/#!$%\^&\*;:{}=\-_\x60~()?"'\[\]]""")
URL_RE=re.compile(r"https?://\S+|www\.\S+"); HTML_RE=re.compile(r"<.*?>")
LABELS={1:{"fake","fake news","false","misinformation","disinformation","non credible","noncredible"},0:{"real","true","non fake","nonfake","genuine","credible","factual"}}

def sha(b): return hashlib.sha256(b).hexdigest()
def clean_text(s):
    s=URL_RE.sub(" ",str(s or "").lower()); s=HTML_RE.sub(" ",s); s=PUNCT_RE.sub(" ",s); s=re.sub(r"\s+"," ",s).strip()
    return " ".join(w for w in s.split() if w not in STOPWORDS and len(w)>=3)
def runtime_analyzer(doc):
    words=doc.split(); terms=[w for w in words if len(w)>=3]
    terms.extend(f"{words[i]} {words[i+1]}" for i in range(len(words)-1) if len(words[i])>=3 and len(words[i+1])>=3)
    return terms
def normalize_domain(value):
    if value is None or (isinstance(value,float) and math.isnan(value)): return None
    raw=str(value).strip().lower()
    if not raw: return None
    if "://" not in raw: raw="https://"+raw
    try: host=(urlsplit(raw).hostname or "").lower().rstrip(".").encode("idna").decode("ascii")
    except (ValueError,UnicodeError): return None
    if host.startswith("www."): host=host[4:]
    if host in SHORTENERS or "." not in host: return None
    try: sld=get_sld(host,strict=True)
    except Exception: sld=None
    sld=str(sld or "").lower().rstrip(".")
    return sld if sld and sld not in SHORTENERS else None
def source_domain(row):
    return normalize_domain(row.get("url")) or normalize_domain(row.get("domain"))
def publisher_domain_fingerprints(domains):
    """Return stable, unsalted SHA-256 fingerprints of canonical registrable domains."""
    fingerprints = {
        sha(canonical.encode("utf-8"))
        for raw in domains
        if (canonical := normalize_domain(raw)) is not None
    }
    return sorted(fingerprints)

def load_external_publisher_exclusions(path):
    raw = Path(path).read_bytes()
    payload = json.loads(raw.decode("utf-8"))
    if payload.get("schema_version") != 1:
        raise SystemExit("Unsupported external publisher exclusion schema")
    fingerprints = payload.get("publisher_domain_fingerprints")
    if not isinstance(fingerprints, list) or not fingerprints:
        raise SystemExit("External publisher exclusion list is empty or malformed")
    if any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value) for value in fingerprints):
        raise SystemExit("External publisher exclusions must be lowercase SHA-256 fingerprints")
    normalized = sorted(set(fingerprints))
    if len(normalized) != len(fingerprints):
        raise SystemExit("External publisher exclusion set contains duplicates")
    set_sha = sha(json.dumps(normalized, separators=(",", ":")).encode("utf-8"))
    if payload.get("publisher_fingerprint_set_sha256") != set_sha:
        raise SystemExit("External publisher fingerprint-set SHA-256 mismatch")
    source_archive_sha = payload.get("source_archive_sha256")
    if not isinstance(source_archive_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", source_archive_sha):
        raise SystemExit("Missing or malformed external source archive SHA-256")
    return set(normalized), {
        "applied": True,
        "source_archive_sha256": source_archive_sha,
        "publisher_fingerprint_set_sha256": set_sha,
        "publisher_fingerprint_count": len(normalized),
        "exclusion_input_sha256": sha(raw),
    }

def exclude_external_publishers(records, external_fingerprints):
    excluded = [record for record in records if sha(record["domain"].encode("utf-8")) in external_fingerprints]
    kept = [record for record in records if sha(record["domain"].encode("utf-8")) not in external_fingerprints]
    return kept, {
        "candidate_rows_before_source_exclusion": len(records),
        "candidate_rows_excluded_for_external_publisher_overlap": len(excluded),
        "candidate_rows_after_source_exclusion": len(kept),
    }

def label_ok(v,expected):
    if v is None or (isinstance(v,float) and math.isnan(v)): return True
    raw=re.sub(r"[^a-z0-9]+"," ",str(v).strip().lower()).strip()
    return not raw or raw in {"0","1"} or raw in LABELS[expected]
def load_records(dataset_dir):
    out=[]; workbook_stats={}
    for filename,label in (("Fake.xlsx",1),("Real.xlsx",0)):
        paths=[p for p in dataset_dir.rglob("*") if p.is_file() and p.name.lower()==filename.lower()]
        if len(paths)!=1: raise SystemExit(f"Expected exactly one {filename}, found {len(paths)}.")
        wb=paths[0]; sheets=pd.read_excel(wb,sheet_name=None,dtype=object,engine="openpyxl"); sheet_stats={}
        for sheet,frame in sheets.items():
            frame.columns=[str(c).strip().lower() for c in frame.columns]
            required={"news headline","english translated version","url","domain","label"}
            if not required.issubset(frame.columns): raise SystemExit(f"{filename}/{sheet} missing columns {sorted(required-set(frame.columns))}")
            counts=Counter()
            for idx,row in frame.iterrows():
                title="" if pd.isna(row["news headline"]) else str(row["news headline"]).strip()
                body="" if row["english translated version"] is None or pd.isna(row["english translated version"]) else str(row["english translated version"]).strip()
                if not body: counts["empty_body"]+=1; continue
                if not label_ok(row.get("label"),label): counts["explicit_label_conflict"]+=1; continue
                text=(title+" "+body).strip()
                if len(text)<MIN_CHARS or len(text.split())<MIN_WORDS: counts["short_or_partial"]+=1; continue
                domain=source_domain(row)
                if not domain: counts["unusable_publisher"]+=1; continue
                cleaned=clean_text(text)
                if not cleaned: counts["empty_after_cleaning"]+=1; continue
                counts["eligible_before_dedup"]+=1
                out.append({"id":f"{Path(filename).stem}:{sheet}:{idx}","title":title,"body":body,"text":text,"clean":cleaned,"y":label,"domain":domain,"text_hash":sha(cleaned.encode())})
            sheet_stats[str(sheet)]={"input_rows":int(len(frame)),**dict(counts)}
        workbook_stats[filename]={"sha256":sha(wb.read_bytes()),"sheets":sheet_stats}
    if not out: raise SystemExit("No full-text rows with source metadata passed the filters.")
    return out,workbook_stats
def dedup_exact(records):
    groups=defaultdict(list)
    for r in records: groups[r["text_hash"]].append(r)
    kept=[]; duplicates=conflicts=0
    for _,group in sorted(groups.items()):
        if len({r["y"] for r in group})!=1: conflicts+=len(group); continue
        kept.append(sorted(group,key=lambda r:r["id"])[0]); duplicates+=len(group)-1
    return kept,{"same_label_exact_duplicates_removed":duplicates,"conflicting_label_exact_duplicate_rows_removed":conflicts}
def dedup_near(records):
    if not records: return [],{"near_duplicate_groups":0,"near_duplicate_rows_removed":0,"conflicting_label_near_duplicate_rows_removed":0}
    _,groups=near_duplicate_groups([{"_id":r["id"],"text":r["text"]} for r in records]); byid={r["id"]:r for r in records}
    kept=[]; removed=conflicts=cluster_count=0
    for members in groups.values():
        items=[byid[m] for m in members]
        if len(items)==1: kept.extend(items); continue
        cluster_count+=1
        if len({r["y"] for r in items})!=1: conflicts+=len(items); continue
        kept.append(sorted(items,key=lambda r:(r["domain"],r["id"]))[0]); removed+=len(items)-1
    return kept,{"near_duplicate_groups":cluster_count,"near_duplicate_rows_removed":removed,"conflicting_label_near_duplicate_rows_removed":conflicts,"method":"Phase 2 MinHash/LSH, 5-word shingles, 128 permutations, Jaccard 0.70"}
def exclude_mixed_publishers(records):
    labels=defaultdict(set)
    for r in records: labels[r["domain"]].add(r["y"])
    mixed={d for d,ys in labels.items() if len(ys)>1}; removed=[r for r in records if r["domain"] in mixed]
    return [r for r in records if r["domain"] not in mixed],{"mixed_label_publishers_excluded":len(mixed),"rows_from_mixed_label_publishers_excluded":len(removed),"mixed_publisher_domain_hash":sha("\n".join(sorted(mixed)).encode())}
def publisher_split(records):
    domains_by_label={y:sorted({r["domain"] for r in records if r["y"]==y},key=lambda d:sha(f"truthlens:{SEED}:{y}:{d}".encode())) for y in (0,1)}
    splits={"train":set(),"validation":set(),"test":set()}
    for y,domains in domains_by_label.items():
        if len(domains)<10: raise SystemExit(f"Too few publisher domains for label {y}: {len(domains)}")
        nt=max(1,round(.2*len(domains))); nv=max(1,round(.15*len(domains)))
        if nt+nv>=len(domains): raise SystemExit(f"Cannot split domains for label {y}")
        splits["test"].update(domains[:nt]); splits["validation"].update(domains[nt:nt+nv]); splits["train"].update(domains[nt+nv:])
    overlap={f"{a}_{b}":sorted(splits[a]&splits[b]) for a,b in (("train","validation"),("train","test"),("validation","test"))}
    if any(overlap.values()): raise SystemExit(f"Publisher leakage: {overlap}")
    rows={name:[r for r in records if r["domain"] in ds] for name,ds in splits.items()}
    for name,values in rows.items():
        if {r["y"] for r in values}!={0,1}: raise SystemExit(f"Split {name} does not include both classes.")
    return rows,splits
def score_runtime(text,artifact):
    words=clean_text(text).split(); counts=Counter(words)
    for i in range(len(words)-1):
        if len(words[i])>=3 and len(words[i+1])>=3: counts[f"{words[i]} {words[i+1]}"]+=1
    vals=[]; norm_sq=0.
    for term,count in counts.items():
        ix=artifact["vocabulary"].get(term)
        if ix is None: continue
        value=(1+math.log(count))*artifact["idf"][ix]; vals.append((ix,value)); norm_sq+=value*value
    norm=math.sqrt(norm_sq) or 1.; model=artifact["selected_model"]; z=model["bias"]
    for ix,value in vals: z+=model["weights"][ix]*(value/norm)
    exp=max(-50.,min(50.,model["plattA"]*z+model["plattB"]))
    return 1/(1+math.exp(exp)),len(counts),len(vals)
def raw_metrics(y,p):
    pred=(p>=.5).astype(int)
    return {"sample_count":int(len(y)),"accuracy":float(accuracy_score(y,pred)),"balanced_accuracy":float(balanced_accuracy_score(y,pred)),"precision_fake":float(precision_score(y,pred,zero_division=0)),"fake_recall":float(recall_score(y,pred,zero_division=0)),"real_recall":float(recall_score(y,pred,pos_label=0,zero_division=0)),"macro_f1":float(f1_score(y,pred,average="macro",zero_division=0)),"roc_auc":float(roc_auc_score(y,p)),"average_precision_fake":float(average_precision_score(y,p)),"brier":float(brier_score_loss(y,p)),"confusion_matrix_real_fake":confusion_matrix(y,pred,labels=[0,1]).tolist()}
def policy_metrics(rows,p):
    y=np.asarray([r["y"] for r in rows],dtype=int); covr=np.asarray([r["coverage_ratio"] for r in rows]); terms=np.asarray([r["candidate_term_count"] for r in rows])
    abstain=(covr<.10)|((terms<100)&(covr<.35)); decision=np.full(len(rows),-1,dtype=int); valid=~abstain
    decision[valid&(p<=REAL_THRESHOLD)]=0; decision[valid&(p>=FAKE_THRESHOLD)]=1
    fake=y==1; real=y==0; fr=float(np.sum(fake&(decision==1))/max(1,int(fake.sum()))); rr=float(np.sum(real&(decision==0))/max(1,int(real.sum())))
    coverage=float(np.mean(decision>=0))
    return {"sample_count":len(rows),"coverage":coverage,"abstention_rate":1-coverage,"operational_balanced_accuracy_abstentions_count_as_not_correct":(fr+rr)/2,"fake_recall_all_fake_samples":fr,"real_recall_all_real_samples":rr,"frozen_thresholds":{"fake":FAKE_THRESHOLD,"real":REAL_THRESHOLD}}
def with_coverage(rows,vocab):
    out=[]
    for r in rows:
        words=r["clean"].split(); terms=set(words); terms.update(f"{words[i]} {words[i+1]}" for i in range(len(words)-1) if len(words[i])>=3 and len(words[i+1])>=3)
        out.append({**r,"candidate_term_count":len(terms),"coverage_ratio":sum(t in vocab for t in terms)/max(1,len(terms))})
    return out
def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--dataset-dir",required=True); ap.add_argument("--archive",required=True); ap.add_argument("--output-dir",default=str(ROOT/"artifacts"/"models")); ap.add_argument("--max-features",type=int,default=16000); ap.add_argument("--min-df",type=int,default=2); ap.add_argument("--exclude-publisher-fingerprints")
    args=ap.parse_args(); archive=Path(args.archive)
    if not archive.is_file(): raise SystemExit(f"Inner dataset archive missing: {archive}")
    archive_sha=sha(archive.read_bytes())
    if archive_sha!=ARCHIVE_SHA: raise SystemExit(f"Archive SHA-256 mismatch: {archive_sha}")
    with zipfile.ZipFile(archive) as z:
        if z.testzip(): raise SystemExit("Pinned archive has a corrupt ZIP member")
        names={Path(n).name.lower() for n in z.namelist() if not n.endswith("/")}
    if not {"fake.xlsx","real.xlsx"}.issubset(names): raise SystemExit("Pinned ZIP missing Fake.xlsx/Real.xlsx")
    if args.max_features<1000 or args.min_df<1: raise SystemExit("Require --max-features >=1000 and --min-df >=1")
    records,workbook_stats=load_records(Path(args.dataset_dir)); eligible_before=len(records)
    source_exclusion={"applied":False,"records_excluded_from_development":0}
    if args.exclude_publisher_fingerprints:
        excluded_fingerprints, exclusion_contract = load_external_publisher_exclusions(args.exclude_publisher_fingerprints)
        records, exclusion_counts = exclude_external_publishers(records, excluded_fingerprints)
        source_exclusion={**exclusion_contract,**exclusion_counts,"records_excluded_from_development":exclusion_counts["candidate_rows_excluded_for_external_publisher_overlap"]}
        if not records:
            raise SystemExit("External publisher exclusion removed every candidate training record.")
    records,exact_stats=dedup_exact(records); records,near_stats=dedup_near(records); records,mixed_stats=exclude_mixed_publishers(records)
    sets,domain_sets=publisher_split(records); train,val,test=sets["train"],sets["validation"],sets["test"]
    # Calibration and policy selection use disjoint publisher groups within validation.
    # The test publishers are never used to select feature/model hyperparameters.
    yv=np.asarray([r["y"] for r in val],dtype=int); yte=np.asarray([r["y"] for r in test],dtype=int)
    cal_domains=set(); pol_domains=set()
    for label in (0,1):
        val_domains=sorted({r["domain"] for r in val if r["y"]==label},key=lambda d:sha(f"truthlens-val-half:{SEED}:{label}:{d}".encode()))
        ncal=max(1,len(val_domains)//2)
        if len(val_domains)-ncal<1: raise SystemExit(f"Too few validation publishers for label {label}.")
        cal_domains.update(val_domains[:ncal]); pol_domains.update(val_domains[ncal:])
    cal_ix=np.asarray([i for i,r in enumerate(val) if r["domain"] in cal_domains],dtype=int)
    pol_ix=np.asarray([i for i,r in enumerate(val) if r["domain"] in pol_domains],dtype=int)
    if {val[int(i)]["y"] for i in cal_ix}!={0,1} or {val[int(i)]["y"] for i in pol_ix}!={0,1}:
        raise SystemExit("Calibration and policy-selection publisher groups must each contain both classes.")
    if cal_domains & pol_domains: raise SystemExit("Publisher overlap between calibration and policy selection.")
    ycal_all=yv[cal_ix]; ypol=yv[pol_ix]
    # Test a small, predeclared feature grid using validation policy publishers only.
    # This is not a sweep over the final held-out test set.
    feature_configs=list(dict.fromkeys([
        (args.max_features,args.min_df),(16000,1),(32000,2),(32000,1),(48000,1)
    ]))
    config_best=[]; config_sweeps={}; feature_search=[]
    for max_features,min_df in feature_configs:
        vec_candidate=TfidfVectorizer(analyzer=runtime_analyzer,lowercase=False,token_pattern=None,max_features=max_features,min_df=min_df,sublinear_tf=True,norm="l2")
        Xtr_candidate=vec_candidate.fit_transform([r["clean"] for r in train])
        Xv_candidate=vec_candidate.transform([r["clean"] for r in val])
        Xte_candidate=vec_candidate.transform([r["clean"] for r in test])
        ytr_candidate=np.asarray([r["y"] for r in train],dtype=int)
        Xcal_candidate=Xv_candidate[cal_ix]; Xpol_candidate=Xv_candidate[pol_ix]
        polrows_candidate=with_coverage([val[int(i)] for i in pol_ix],vec_candidate.vocabulary_)
        sweeps_candidate=[]
        for cw in (None,"balanced"):
          for C in (.1,.25,.5,1.,2.):
            svm=LinearSVC(C=C,class_weight=cw,max_iter=10000,random_state=SEED).fit(Xtr_candidate,ytr_candidate)
            cal=LogisticRegression(C=1e6,max_iter=2000,solver="lbfgs",random_state=SEED).fit(svm.decision_function(Xcal_candidate).reshape(-1,1),ycal_all)
            pbase=np.clip(cal.predict_proba(svm.decision_function(Xpol_candidate).reshape(-1,1))[:,1],1e-8,1-1e-8); logits=np.log(pbase/(1-pbase))
            for scale in (1.,2.,4.,8.,16.,32.):
              for offset in (-3.,-2.,-1.,0.,1.,2.,3.):
                adjusted=1/(1+np.exp(-np.clip(scale*logits+offset,-50,50))); pm=policy_metrics(polrows_candidate,adjusted)
                passed=pm["coverage"]>=.5 and pm["operational_balanced_accuracy_abstentions_count_as_not_correct"]>=.7 and pm["fake_recall_all_fake_samples"]>=.7 and pm["real_recall_all_real_samples"]>=.7
                sweeps_candidate.append({"svm":svm,"cal":cal,"C":C,"class_weight":cw,"scale":scale,"offset":offset,"p":adjusted,"pm":pm,"passed":passed,"max_features":max_features,"min_df":min_df})
        best_candidate=max(sweeps_candidate,key=lambda s:(s["passed"],s["pm"]["operational_balanced_accuracy_abstentions_count_as_not_correct"],min(s["pm"]["fake_recall_all_fake_samples"],s["pm"]["real_recall_all_real_samples"]),s["pm"]["coverage"]))
        best_candidate.update({"vec":vec_candidate,"Xtr":Xtr_candidate,"Xv":Xv_candidate,"Xte":Xte_candidate,"ytr":ytr_candidate})
        config_best.append(best_candidate)
        config_sweeps[(max_features,min_df)]=sweeps_candidate
        feature_search.append({
            "max_features":max_features,"min_df":min_df,"vocabulary_size":len(vec_candidate.vocabulary_),
            "selected_C":best_candidate["C"],"selected_class_weight":best_candidate["class_weight"],
            "calibration_scale":best_candidate["scale"],"calibration_offset":best_candidate["offset"],
            "passed_internal_frozen_policy_gate":best_candidate["passed"],
            **best_candidate["pm"],
        })
    chosen=max(config_best,key=lambda s:(s["passed"],s["pm"]["operational_balanced_accuracy_abstentions_count_as_not_correct"],min(s["pm"]["fake_recall_all_fake_samples"],s["pm"]["real_recall_all_real_samples"]),s["pm"]["coverage"]))
    vec,Xtr,Xv,Xte=chosen["vec"],chosen["Xtr"],chosen["Xv"],chosen["Xte"]
    ytr=chosen["ytr"]
    svm,cal,scale,offset=chosen["svm"],chosen["cal"],float(chosen["scale"]),float(chosen["offset"])
    max_features,min_df=chosen["max_features"],chosen["min_df"]
    sweeps=config_sweeps[(max_features,min_df)]
    def predict(X):
        p=np.clip(cal.predict_proba(svm.decision_function(X).reshape(-1,1))[:,1],1e-8,1-1e-8); logit=np.log(p/(1-p)); return 1/(1+np.exp(-np.clip(scale*logit+offset,-50,50)))
    pval,ptest=predict(Xv),predict(Xte); valscored=with_coverage(val,vec.vocabulary_); testscored=with_coverage(test,vec.vocabulary_); vocab={t:int(i) for t,i in vec.vocabulary_.items()}
    vpayload={"dataset":DATASET,"archive_sha256":archive_sha,"seed":SEED,"split":"publisher-disjoint within same dataset; deterministic 65/15/20 domain split by class","train_domain_sha256":sha("\n".join(sorted(domain_sets["train"])).encode()),"validation_domain_sha256":sha("\n".join(sorted(domain_sets["validation"])).encode()),"calibration_domain_sha256":sha("\n".join(sorted(cal_domains)).encode()),"policy_selection_domain_sha256":sha("\n".join(sorted(pol_domains)).encode()),"test_domain_sha256":sha("\n".join(sorted(domain_sets["test"])).encode()),"max_features":max_features,"min_df":min_df,"feature_search":feature_search,"external_publisher_exclusion":source_exclusion,"selected_C":chosen["C"],"selected_class_weight":chosen["class_weight"],"calibration_scale":scale,"calibration_offset":offset,"fake_threshold":FAKE_THRESHOLD,"real_threshold":REAL_THRESHOLD,"independent_external_validation":False}
    version="polyglot-source-svm-"+sha(json.dumps(vpayload,sort_keys=True,separators=(",",":")).encode())[:12]; out=Path(args.output_dir).resolve()/version; out.mkdir(parents=True,exist_ok=False)
    artifact={"model_name":"Linear SVM (Calibrated; Publisher-Held-Out Research Candidate)","model_type":"linear_svm_calibrated","model_version":version,"trained_at":datetime.now(timezone.utc).isoformat(),"is_demo":False,"dataset_status":"SOURCE-HELD-OUT RESEARCH CANDIDATE","dataset_info":{"name":DATASET+" publisher-held-out split","source_path":"official Fake.xlsx + Real.xlsx English-translated body/title","total_samples":len(records),"train_samples":len(train),"validation_samples":len(val),"test_samples":len(test),"holdout_samples":len(test),"real_samples":int(np.sum(ytr==0)),"fake_samples":int(np.sum(ytr==1)),"vocabulary_size":len(vocab),"is_demo":False,"dataset_status":"SOURCE-HELD-OUT RESEARCH CANDIDATE","evaluation_status":"Publisher domains disjoint inside same corpus; external release gate remains blocked."},"preprocessing":{"lowercase":True,"strip_urls":True,"strip_html":True,"strip_punctuation":True,"remove_stopwords":True,"min_token_length":3,"ngram_range":[1,2],"sublinear_tf":True},"vocabulary":vocab,"idf":vec.idf_.astype(float).tolist(),"selected_model":{"name":"Linear SVM (Calibrated)","inference_mode":"single_calibrated_svm","weights":svm.coef_[0].astype(float).tolist(),"bias":float(svm.intercept_[0]),"plattA":-float(cal.coef_[0,0])*scale,"plattB":-float(cal.intercept_[0])*scale-offset},"logistic_regression":{"weights":svm.coef_[0].astype(float).tolist(),"bias":float(svm.intercept_[0])},"metrics":{"validation_raw":raw_metrics(yv,pval),"publisher_heldout_test_raw":raw_metrics(yte,ptest),"validation_frozen_policy":policy_metrics(valscored,pval),"publisher_heldout_test_frozen_policy":policy_metrics(testscored,ptest),"policy_selection":{"selected_C":chosen["C"],"class_weight":chosen["class_weight"],"calibration_scale":scale,"calibration_offset":offset,"selection_metrics":chosen["pm"],"passed_internal_frozen_policy_gate":chosen["passed"],"feature_search":feature_search,"sweep":[{"C":s["C"],"class_weight":s["class_weight"],"scale":s["scale"],"offset":s["offset"],"passed":s["passed"],**s["pm"]} for s in sweeps]}},"thresholds":{"fake_threshold":FAKE_THRESHOLD,"real_threshold":REAL_THRESHOLD,"min_text_length":60,"min_word_count":20},"training_contract":vpayload}
    apath=out/"model_artifact.json"; apath.write_text(json.dumps(artifact,separators=(",",":")),encoding="utf8"); fixtures=[]
    for item in test[:30]:
        probability,terms,matched=score_runtime(item["text"],artifact); Xone=vec.transform([item["clean"]]); base=float(cal.predict_proba(svm.decision_function(Xone).reshape(-1,1))[0,1]); base=min(1-1e-8,max(1e-8,base)); oracle=1/(1+math.exp(-max(-50,min(50,scale*math.log(base/(1-base))+offset))))
        if abs(probability-oracle)>1e-12: raise SystemExit(f"Artifact serialization drift on {item['id']}")
        fixtures.append({"id":item["id"],"text":item["text"],"expected_fake_probability":oracle,"candidate_terms":terms,"matched_terms":matched})
    (out/"runtime_parity_fixtures.json").write_text(json.dumps(fixtures,indent=2),encoding="utf8")
    overlaps={f"{a}_{b}":sorted(domain_sets[a]&domain_sets[b]) for a,b in (("train","validation"),("train","test"),("validation","test"))}
    report={"schema_version":1,"status":"COMPLETED","task":"Same-dataset publisher-held-out diagnostic; not independent external release validation.","dataset":{"name":DATASET,"doi":"10.17632/8yfrm6z9dx.1","version":"1","license":"CC BY 4.0","archive_sha256":archive_sha,"workbooks":workbook_stats},"data_flow":{"eligible_before_dedup":eligible_before,"external_publisher_exclusion":source_exclusion,"after_exact_near_and_mixed_publisher_filters":len(records),"split_counts":{k:len(v) for k,v in sets.items()},"domain_counts":{k:len(domain_sets[k]) for k in domain_sets},"class_counts":{k:{"real":sum(r["y"]==0 for r in v),"fake":sum(r["y"]==1 for r in v)} for k,v in sets.items()},**exact_stats,**near_stats,**mixed_stats},"publisher_separation":{"status":"PASS_WITHIN_DATASET","method":"publicsuffix2 pinned public suffix list","overlap":overlaps,"split_domain_sha256":{k:vpayload[f"{k}_domain_sha256"] for k in ("train","validation","test")},"domain_fingerprint_algorithm":"SHA-256 of canonical registrable-domain UTF-8; unsalted equality fingerprints, not anonymization","domain_fingerprints":{"candidate_development_corpus":publisher_domain_fingerprints([r["domain"] for r in records]),"train":publisher_domain_fingerprints([r["domain"] for r in train]),"validation":publisher_domain_fingerprints([r["domain"] for r in val]),"test":publisher_domain_fingerprints([r["domain"] for r in test])},"validation_subgroups":{"calibration_publisher_sha256":vpayload["calibration_domain_sha256"],"policy_selection_publisher_sha256":vpayload["policy_selection_domain_sha256"],"calibration_policy_publisher_overlap":sorted(cal_domains & pol_domains)}},"candidate":{"model_version":version,"artifact_sha256":sha(apath.read_bytes()),"production_eligible":False,"promotion_status":"CANDIDATE_ONLY"},"metrics":artifact["metrics"],"release_gate":{"passed":False,"required_independent_full_articles":MIN_EXTERNAL_SAMPLES,"publisher_heldout_articles":len(test),"independent_external_dataset":False,"publisher_disjoint_within_dataset":True,"reason":"Same-dataset publisher holdout does not satisfy the independent external full-article release gate."},"limits":["All partitions come from one dataset release; publisher holdout is not a separate independent corpus.","Mixed-label publishers are excluded, reducing sample count and potentially biasing the subset.","Near duplicates are removed before partitioning; this does not establish source independence from ISOT/WELFake.","Candidate remains non-promotable; canonical production model and thresholds are unchanged."]}
    (out/"source_holdout_validation.json").write_text(json.dumps(report,indent=2),encoding="utf8")
    manifest={"schema_version":1,"model_version":version,"created_at":artifact["trained_at"],"dataset_name":DATASET,"dataset_fingerprint":vpayload,"training_contract":vpayload,"software":{"python":platform.python_version(),"numpy":np.__version__,"pandas":pd.__version__},"metrics":artifact["metrics"],"report":"source_holdout_validation.json","artifact_sha256":sha(apath.read_bytes()),"parity_fixture_count":len(fixtures),"production_artifact":"data/saved_model_artifacts.json","production_eligible":False,"promotion_status":"CANDIDATE_ONLY"}
    (out/"manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf8")
    print(json.dumps({"model_version":version,"candidate_dir":str(out),"split_counts":report["data_flow"]["split_counts"],"domain_counts":report["data_flow"]["domain_counts"],"test_raw":artifact["metrics"]["publisher_heldout_test_raw"],"test_frozen_policy":artifact["metrics"]["publisher_heldout_test_frozen_policy"],"internal_gate_passed":chosen["passed"],"selected_max_features":max_features,"selected_min_df":min_df,"release_gate_passed":False,"production_artifact_modified":False},indent=2))
if __name__=="__main__": main()
