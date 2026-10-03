#!/usr/bin/env python3
"""Explicit, auditable TruthLens candidate -> production promotion."""
import argparse, hashlib, json, shutil, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
PROD=ROOT/"data"/"saved_model_artifacts.json"
BACKUPS=ROOT/"artifacts"/"production_backups"
CANDIDATES=ROOT/"artifacts"/"models"

def sha256(p):
    h=hashlib.sha256()
    with open(p,"rb") as f:
        for c in iter(lambda:f.read(1024*1024),b""): h.update(c)
    return h.hexdigest()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--model-version",required=True)
    ap.add_argument("--yes",action="store_true",help="required explicit promotion confirmation")
    ap.add_argument("--approve",action="store_true",help="explicit human approval after reviewing candidate evidence")
    args=ap.parse_args()
    if not args.yes or not args.approve:
        raise SystemExit("Promotion is intentionally blocked: explicit confirmation is required. Review the candidate first, then re-run with both --approve and --yes.")
    d=CANDIDATES/args.model_version
    artifact=d/"model_artifact.json"; manifest=d/"manifest.json"; liar=d/"external_validation.json"
    for p in (artifact,manifest,liar):
        if not p.exists(): raise SystemExit(f"Promotion blocked: missing {p}")
    m=json.loads(manifest.read_text()); ext=json.loads(liar.read_text())
    if m.get("model_version")!=args.model_version: raise SystemExit("Promotion blocked: manifest/model version mismatch.")
    if not m.get("dataset_fingerprint"): raise SystemExit("Promotion blocked: missing dataset fingerprint.")

    candidate = json.loads(artifact.read_text())
    selected = candidate.get("selected_model", {})
    inference_mode = selected.get("inference_mode")
    if inference_mode not in ("single_calibrated_svm", "calibrated_ensemble"):
        raise SystemExit(
            "Promotion blocked: candidate runtime inference mode is not an exact calibrated contract."
        )
    if not (isinstance(selected.get("weights"), list) and isinstance(candidate.get("vocabulary"), dict)
            and isinstance(candidate.get("idf"), list)
            and len(selected["weights"]) == len(candidate["vocabulary"]) == len(candidate["idf"])):
        raise SystemExit("Promotion blocked: candidate vocabulary / IDF / weight dimensions do not match.")
    candidate_metrics = candidate.get("metrics", {})
    if not candidate_metrics.get("test") or not candidate_metrics.get("temporal_test"):
        raise SystemExit("Promotion blocked: untouched test and temporal-test metrics are required.")
    ext_metrics = ext.get("metrics", {})
    balanced = ext_metrics.get("balanced_accuracy")
    if not isinstance(balanced, (int, float)):
        raise SystemExit("Promotion blocked: LIAR balanced accuracy is required.")
    if balanced <= 0.50:
        raise SystemExit(
            f"Promotion blocked: out-of-domain LIAR balanced accuracy {balanced:.4f} is not above chance."
        )
    # NOTE: the unconditional gate above already guarantees args.approve is
    # True by this point (execution cannot reach here otherwise), which
    # makes this specific check currently unreachable. Kept intentionally
    # as defense-in-depth in case the gate above is ever relaxed to accept
    # --yes alone -- do not delete this without re-verifying the gate above
    # still enforces both --approve and --yes unconditionally.
    if not args.approve and m.get("production_eligible") is not True: raise SystemExit("Promotion blocked: explicit human approval is required.")
    if ext.get("status")!="COMPLETED": raise SystemExit("Promotion blocked: LIAR validation is not COMPLETED.")
    if ext.get("eligible_binary_samples",0)<=0: raise SystemExit("Promotion blocked: no LIAR samples were evaluated.")
    if sha256(artifact)!=m.get("artifact_sha256"): raise SystemExit("Promotion blocked: candidate artifact hash mismatch.")
    BACKUPS.mkdir(parents=True,exist_ok=True)
    stamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    old_hash=sha256(PROD) if PROD.exists() else None
    backup=None
    if PROD.exists():
        backup=BACKUPS/f"{stamp}-{old_hash[:12]}.json"
        shutil.copy2(PROD,backup)
    tmp=PROD.with_suffix(".json.tmp")
    shutil.copy2(artifact,tmp)
    tmp.replace(PROD)
    new_hash=sha256(PROD)
    m["production_eligible"]=True
    m["promotion_status"]="PROMOTED"
    (d/"manifest.json").write_text(json.dumps(m,indent=2),encoding="utf-8")
    event={"timestamp":datetime.now(timezone.utc).isoformat(),"model_version":args.model_version,
           "previous_artifact_sha256":old_hash,"new_artifact_sha256":new_hash,
           "backup":str(backup) if backup else None}
    (BACKUPS/f"{stamp}-promotion.json").write_text(json.dumps(event,indent=2),encoding="utf-8")
    print(json.dumps(event,indent=2))

if __name__=="__main__": main()
