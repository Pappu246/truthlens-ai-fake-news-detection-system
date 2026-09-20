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
    args=ap.parse_args()
    if not args.yes:
        raise SystemExit("Promotion is intentionally blocked. Re-run with --yes after reviewing validation evidence.")
    d=CANDIDATES/args.model_version
    artifact=d/"model_artifact.json"; manifest=d/"manifest.json"; liar=d/"external_validation.json"
    for p in (artifact,manifest,liar):
        if not p.exists(): raise SystemExit(f"Promotion blocked: missing {p}")
    m=json.loads(manifest.read_text()); ext=json.loads(liar.read_text())
    if m.get("model_version")!=args.model_version: raise SystemExit("Promotion blocked: manifest/model version mismatch.")
    if not m.get("dataset_fingerprint"): raise SystemExit("Promotion blocked: missing dataset fingerprint.")
    if m.get("production_eligible") is not True: raise SystemExit("Promotion blocked: candidate is not marked production_eligible.")
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
    event={"timestamp":datetime.now(timezone.utc).isoformat(),"model_version":args.model_version,
           "previous_artifact_sha256":old_hash,"new_artifact_sha256":new_hash,
           "backup":str(backup) if backup else None}
    (BACKUPS/f"{stamp}-promotion.json").write_text(json.dumps(event,indent=2),encoding="utf-8")
    print(json.dumps(event,indent=2))

if __name__=="__main__": main()
