#!/usr/bin/env python3
"""LIAR out-of-domain validation for a versioned TruthLens candidate."""
import argparse,csv,json,math,re
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.metrics import accuracy_score,precision_score,recall_score,f1_score,confusion_matrix,brier_score_loss

STOPWORDS=set("""a about above after again against all am an and any are as at be because been before being below between both but by can cannot could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself me more most my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why with would you your yours yourself yourselves""".split())
def clean(s):
    s=(s or "").lower()
    s=re.sub(r"https?://\S+|www\.\S+"," ",s)
    s=re.sub(r"<.*?>"," ",s)
    s=re.sub(r"[^a-z0-9\s]"," ",s)
    toks=[t for t in re.sub(r"\s+"," ",s).strip().split() if t not in STOPWORDS and len(t)>=3]
    return " ".join(toks)
def vectorize(text,a):
    words=text.split() if text else []; counts=Counter(words)
    counts.update(" ".join(words[i:i+2]) for i in range(len(words)-1))
    vals=[]; norm=0.0
    for term,n in counts.items():
        if term in a["vocabulary"]:
            idx=a["vocabulary"][term]; v=(1+math.log(n))*a["idf"][idx]; vals.append((idx,v)); norm+=v*v
    norm=math.sqrt(norm) or 1.0
    return vals,norm
def prob(text,a):
    vals,norm=vectorize(clean(text),a); z=a["selected_model"]["bias"]
    for i,v in vals:z+=a["selected_model"]["weights"][i]*(v/norm)
    A=a["selected_model"]["plattA"]; B=a["selected_model"]["plattB"]
    return 1/(1+math.exp(max(-60,min(60,A*z+B))))
def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--model-version",required=True); ap.add_argument("--test-file",default="data/test.tsv"); args=ap.parse_args()
    root=Path(__file__).resolve().parents[1]; d=root/"artifacts"/"models"/args.model_version
    a=json.loads((d/"model_artifact.json").read_text())
    rows=list(csv.reader((root/args.test_file).open(encoding="utf-8"),delimiter="\t"))
    mapping={"pants-fire":"FAKE","false":"FAKE","mostly-true":"REAL","true":"REAL"}
    excluded={"barely-true","half-true"}
    y=[]; p=[]
    counts=Counter(r[1].strip().lower() for r in rows)
    for r in rows:
        label=r[1].strip().lower(); statement=r[2].strip()
        if label in excluded or label not in mapping: continue
        y.append(1 if mapping[label]=="FAKE" else 0); p.append(prob(statement,a))
    y=np.array(y); p=np.array(p); pred=(p>=.5).astype(int)
    result={"status":"COMPLETED","evaluation_type":"OUT-OF-DOMAIN VALIDATION",
      "model_version":args.model_version,"file_used":args.test_file,"total_test_samples":len(rows),
      "eligible_binary_samples":len(y),"excluded_samples":len(rows)-len(y),
      "label_mapping":mapping,"excluded_labels":sorted(excluded),
      "raw_label_counts":dict(counts),
      "metrics":{"accuracy":float(accuracy_score(y,pred)),"precision":float(precision_score(y,pred,zero_division=0)),
                 "recall":float(recall_score(y,pred,zero_division=0)),"f1":float(f1_score(y,pred,zero_division=0)),
                 "macro_f1":float(f1_score(y,pred,average="macro",zero_division=0)),
                 "brier":float(brier_score_loss(y,p))},
      "confusion_matrix":confusion_matrix(y,pred).tolist()}
    (d/"external_validation.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
    m=json.loads((d/"manifest.json").read_text()); m["external_validation"]={"status":"COMPLETED","path":"external_validation.json","eligible_binary_samples":len(y)}
    # No automatic production eligibility decision: human review remains required.
    m["production_eligible"]=False
    (d/"manifest.json").write_text(json.dumps(m,indent=2),encoding="utf-8")
    print(json.dumps(result,indent=2))
if __name__=="__main__": main()
