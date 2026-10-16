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
    artifact=d/"model_artifact.json"; manifest=d/"manifest.json"
    liar=d/"external_validation.json"; article_ood=d/"article_ood_validation.json"
    for p in (artifact,manifest,liar,article_ood):
        if not p.exists(): raise SystemExit(f"Promotion blocked: missing {p}")
    m=json.loads(manifest.read_text()); ext=json.loads(liar.read_text()); article_report=json.loads(article_ood.read_text())
    if m.get("model_version")!=args.model_version: raise SystemExit("Promotion blocked: manifest/model version mismatch.")
    if not m.get("dataset_fingerprint"): raise SystemExit("Promotion blocked: missing dataset fingerprint.")
    if m.get("production_eligible") is not True: raise SystemExit("Promotion blocked: manifest does not mark candidate production_eligible after all automated gates.")
    if m.get("article_external_validation", {}).get("release_gate_passed") is not True: raise SystemExit("Promotion blocked: task-matched article-level external gate did not pass.")

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
    # Primary gate is task-matched full-article external validation.
    article_metrics = article_report.get("metrics", {})
    expected_md5 = "73c9675a4b3d09f86a6933d0b8d7d908"
    if article_report.get("status") != "COMPLETED":
        raise SystemExit("Promotion blocked: WELFake full-article validation is not COMPLETED.")
    if article_report.get("dataset_md5") != expected_md5:
        raise SystemExit("Promotion blocked: WELFake dataset checksum does not match the approved evaluation corpus.")
    if article_report.get("candidate_artifact_sha256") != sha256(artifact):
        raise SystemExit("Promotion blocked: WELFake report is not bound to this exact candidate artifact.")
    if article_report.get("eligible_samples", 0) < 10000:
        raise SystemExit("Promotion blocked: fewer than 10,000 eligible non-overlap full articles were evaluated.")
    article_balanced = article_metrics.get("balanced_accuracy")
    fake_recall = article_metrics.get("fake_recall")
    real_recall = article_metrics.get("real_recall")
    if not isinstance(article_balanced, (int, float)) or article_balanced < 0.70:
        raise SystemExit("Promotion blocked: WELFake full-article balanced accuracy must be at least 0.70.")
    if not isinstance(fake_recall, (int, float)) or fake_recall < 0.70:
        raise SystemExit("Promotion blocked: WELFake full-article fake recall must be at least 0.70.")
    if not isinstance(real_recall, (int, float)) or real_recall < 0.70:
        raise SystemExit("Promotion blocked: WELFake full-article real recall must be at least 0.70.")
    if article_report.get("release_gate", {}).get("passed") is not True:
        raise SystemExit("Promotion blocked: WELFake release-gate decision is not PASS.")
    runtime_policy = article_report.get("runtime_decision_policy", {})
    runtime_metrics = runtime_policy.get("metrics", {})
    if runtime_policy.get("passed") is not True:
        raise SystemExit("Promotion blocked: actual runtime decision/abstention policy did not pass.")
    if runtime_metrics.get("coverage", 0) < 0.50:
        raise SystemExit("Promotion blocked: actual runtime policy coverage must be at least 0.50.")
    if runtime_metrics.get("operational_balanced_accuracy_abstentions_count_as_not_correct", 0) < 0.70:
        raise SystemExit("Promotion blocked: actual runtime policy operational balanced accuracy must be at least 0.70.")
    if runtime_metrics.get("fake_recall_all_fake_samples", 0) < 0.70:
        raise SystemExit("Promotion blocked: runtime policy fake recall must be at least 0.70.")
    if runtime_metrics.get("real_recall_all_real_samples", 0) < 0.70:
        raise SystemExit("Promotion blocked: runtime policy real recall must be at least 0.70.")
    ablation = article_report.get("source_attribution_ablation", {})
    ablation_metrics = ablation.get("metrics", {})
    if ablation.get("passed") is not True:
        raise SystemExit("Promotion blocked: publisher-byline ablation did not pass.")
    if ablation_metrics.get("balanced_accuracy", 0) < 0.65:
        raise SystemExit("Promotion blocked: byline-ablation balanced accuracy must be at least 0.65.")
    if ablation_metrics.get("fake_recall", 0) < 0.65:
        raise SystemExit("Promotion blocked: byline-ablation fake recall must be at least 0.65.")
    if ablation_metrics.get("real_recall", 0) < 0.65:
        raise SystemExit("Promotion blocked: byline-ablation real recall must be at least 0.65.")
    ablation_runtime_policy = ablation.get("runtime_decision_policy", {})
    ablation_runtime_metrics = ablation_runtime_policy.get("metrics", {})
    if ablation_runtime_policy.get("passed") is not True:
        raise SystemExit("Promotion blocked: runtime decision policy failed the publisher-byline ablation.")
    if ablation_runtime_metrics.get("coverage", 0) < 0.50:
        raise SystemExit("Promotion blocked: byline-ablation runtime-policy coverage must be at least 0.50.")
    if ablation_runtime_metrics.get("operational_balanced_accuracy_abstentions_count_as_not_correct", 0) < 0.65:
        raise SystemExit("Promotion blocked: byline-ablation runtime-policy balanced accuracy must be at least 0.65.")
    if ablation_runtime_metrics.get("fake_recall_all_fake_samples", 0) < 0.65:
        raise SystemExit("Promotion blocked: byline-ablation runtime-policy fake recall must be at least 0.65.")
    if ablation_runtime_metrics.get("real_recall_all_real_samples", 0) < 0.65:
        raise SystemExit("Promotion blocked: byline-ablation runtime-policy real recall must be at least 0.65.")

    # LIAR is a sentence/claim benchmark, not a full-article benchmark. Keep
    # its result mandatory and auditable, but do not use it as the primary
    # metric gate for the different article-classification task.
    if ext.get("status") != "COMPLETED":
        raise SystemExit("Promotion blocked: LIAR claim-level diagnostic is not COMPLETED.")
    if ext.get("eligible_binary_samples", 0) <= 0:
        raise SystemExit("Promotion blocked: no LIAR claim samples were evaluated.")
    ext_metrics = ext.get("metrics", {})
    print(json.dumps({
        "candidate_model_version": args.model_version,
        "article_external_validation": {
            "dataset": article_report.get("dataset"),
            "eligible_samples": article_report.get("eligible_samples"),
            "balanced_accuracy": article_balanced,
            "fake_recall": fake_recall,
            "real_recall": real_recall,
            "runtime_policy_coverage": runtime_metrics.get("coverage"),
            "runtime_policy_operational_balanced_accuracy": runtime_metrics.get("operational_balanced_accuracy_abstentions_count_as_not_correct"),
            "runtime_policy_fake_recall": runtime_metrics.get("fake_recall_all_fake_samples"),
            "runtime_policy_real_recall": runtime_metrics.get("real_recall_all_real_samples"),
            "byline_ablation_balanced_accuracy": ablation_metrics.get("balanced_accuracy"),
            "byline_ablation_fake_recall": ablation_metrics.get("fake_recall"),
            "byline_ablation_real_recall": ablation_metrics.get("real_recall"),
            "byline_ablation_runtime_policy_coverage": ablation_runtime_metrics.get("coverage"),
            "byline_ablation_runtime_policy_operational_balanced_accuracy": ablation_runtime_metrics.get("operational_balanced_accuracy_abstentions_count_as_not_correct")
        },
        "liar_claim_diagnostic": {
            "eligible_binary_samples": ext.get("eligible_binary_samples"),
            "accuracy": ext_metrics.get("accuracy"),
            "balanced_accuracy": ext_metrics.get("balanced_accuracy"),
            "macro_f1": ext_metrics.get("macro_f1")
        },
        "explicit_human_approval": True
    }, indent=2))
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
