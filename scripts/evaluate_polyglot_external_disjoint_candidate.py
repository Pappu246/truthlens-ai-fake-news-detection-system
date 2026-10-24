#!/usr/bin/env python3
"""Score a publisher-disjoint candidate against an independent full-article corpus."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from train_polyglot_source_heldout_candidate import (
    clean_text, load_external_publisher_exclusions, policy_metrics,
    raw_metrics, score_runtime, sha, with_coverage,
)

MIN_EXTERNAL_SAMPLES = 10000
FAKE_THRESHOLD = 0.98
REAL_THRESHOLD = 0.35

def read_jsonl(path: Path):
    records = []
    with path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            item = json.loads(line)
            if item.get("y") not in (0, 1) or not isinstance(item.get("text"), str) or not item["text"].strip():
                raise SystemExit(f"Malformed external evaluation row at line {line_number}")
            if not item.get("source_fingerprints"):
                raise SystemExit(f"Missing source fingerprints at line {line_number}")
            records.append(item)
    return records

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-dir", required=True)
    parser.add_argument("--external-jsonl", required=True)
    parser.add_argument("--source-exclusions", required=True)
    parser.add_argument("--preparation-summary", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    candidate_dir = Path(args.candidate_dir)
    artifact_path = candidate_dir / "model_artifact.json"
    manifest_path = candidate_dir / "manifest.json"
    source_report_path = candidate_dir / "source_holdout_validation.json"
    artifact_bytes, manifest_bytes = artifact_path.read_bytes(), manifest_path.read_bytes()
    artifact, manifest = json.loads(artifact_bytes), json.loads(manifest_bytes)
    source_report = json.loads(source_report_path.read_text(encoding="utf-8"))
    exclusions, exclusion_metadata = load_external_publisher_exclusions(args.source_exclusions)
    preparation = json.loads(Path(args.preparation_summary).read_text(encoding="utf-8"))
    evaluation_path = Path(args.external_jsonl)
    records = read_jsonl(evaluation_path)
    evaluation_file_sha256 = sha(evaluation_path.read_bytes())
    candidate_domain_fingerprints = set(
        source_report.get("publisher_separation", {}).get("domain_fingerprints", {}).get("candidate_development_corpus", [])
    )
    external_domain_fingerprints = {
        fingerprint for record in records for fingerprint in record.get("source_fingerprints", [])
    }
    source_overlap = candidate_domain_fingerprints & external_domain_fingerprints
    contract = artifact.get("training_contract", {})
    training_exclusion = contract.get("external_publisher_exclusion", {})
    manifest_exclusion = manifest.get("training_contract", {}).get("external_publisher_exclusion", {})

    structural_errors = []
    if manifest.get("artifact_sha256") != hashlib.sha256(artifact_bytes).hexdigest():
        structural_errors.append("candidate manifest does not bind the candidate model artifact")
    if manifest.get("production_eligible") is not False or manifest.get("promotion_status") != "CANDIDATE_ONLY":
        structural_errors.append("candidate is not explicitly marked candidate-only")
    if artifact.get("thresholds", {}).get("fake_threshold") != FAKE_THRESHOLD or artifact.get("thresholds", {}).get("real_threshold") != REAL_THRESHOLD:
        structural_errors.append("candidate thresholds differ from the frozen policy")
    if training_exclusion != manifest_exclusion:
        structural_errors.append("artifact and manifest disagree on external-publisher exclusion contract")
    if training_exclusion.get("applied") is not True:
        structural_errors.append("candidate was not trained with external publisher exclusions")
    if training_exclusion.get("source_archive_sha256") != preparation.get("source_archive_sha256"):
        structural_errors.append("candidate exclusion contract does not match the evaluated external archive")
    if training_exclusion.get("publisher_fingerprint_set_sha256") != exclusion_metadata.get("publisher_fingerprint_set_sha256"):
        structural_errors.append("candidate exclusion contract does not match the external publisher fingerprint set")
    if training_exclusion.get("exclusion_input_sha256") != exclusion_metadata.get("exclusion_input_sha256"):
        structural_errors.append("candidate exclusion input hash mismatch")
    if training_exclusion.get("publisher_fingerprint_count") != len(exclusions):
        structural_errors.append("candidate exclusion publisher count mismatch")
    if preparation.get("external_evaluation_jsonl_sha256") != evaluation_file_sha256:
        structural_errors.append("prepared external evaluation data hash mismatch")
    if preparation.get("independent_external_evaluation_count") != len(records):
        structural_errors.append("prepared external evaluation denominator mismatch")
    if preparation.get("external_publisher_fingerprint_count") != len(exclusions):
        structural_errors.append("external publisher fingerprint count mismatch")
    if preparation.get("protocol_version") != "truthlens-external-publisher-disjoint-v1":
        structural_errors.append("unknown external corpus preparation protocol")
    if len({record.get("text_hash") for record in records}) != len(records):
        structural_errors.append("external evaluation rows contain repeated exact article fingerprints")

    if len(records) and len({record["y"] for record in records}) == 2:
        y = np.asarray([record["y"] for record in records], dtype=int)
        probabilities = np.asarray([score_runtime(record["text"], artifact)[0] for record in records], dtype=float)
        scored_rows = with_coverage(
            [{**record, "clean": clean_text(record["text"])} for record in records],
            artifact["vocabulary"],
        )
        raw = raw_metrics(y, probabilities)
        policy = policy_metrics(scored_rows, probabilities)
    else:
        y = np.asarray([], dtype=int)
        probabilities = np.asarray([], dtype=float)
        raw = {"error": "external evaluation set must contain both labels"}
        policy = {
            "sample_count": len(records), "coverage": 0.0,
            "operational_balanced_accuracy_abstentions_count_as_not_correct": 0.0,
            "fake_recall_all_fake_samples": 0.0, "real_recall_all_real_samples": 0.0,
        }

    internal_policy_gate = artifact.get("metrics", {}).get("policy_selection", {}).get("passed_internal_frozen_policy_gate") is True
    external_quality_gate = (
        len(set(y.tolist())) == 2
        and policy.get("coverage", 0.0) >= 0.50
        and policy.get("operational_balanced_accuracy_abstentions_count_as_not_correct", 0.0) >= 0.70
        and policy.get("fake_recall_all_fake_samples", 0.0) >= 0.70
        and policy.get("real_recall_all_real_samples", 0.0) >= 0.70
    )
    data_independence_gate = (
        len(records) >= MIN_EXTERNAL_SAMPLES
        and not source_overlap
        and preparation.get("protocol_version") == "truthlens-external-publisher-disjoint-v1"
    )
    screening_passed = not structural_errors and internal_policy_gate and data_independence_gate and external_quality_gate
    report = {
        "protocol_version": "truthlens-external-publisher-disjoint-evaluation-v1",
        "benchmark": False,
        "task": "Candidate-only external full-article validation; not production release authorization.",
        "dataset": {
            "name": preparation.get("dataset"),
            "doi": preparation.get("dataset_doi"),
            "license": preparation.get("license"),
            "source_archive_sha256": preparation.get("source_archive_sha256"),
            "external_full_article_samples": len(records),
            "publisher_fingerprint_count": len(external_domain_fingerprints),
            "publisher_fingerprint_set_sha256": preparation.get("external_publisher_fingerprint_set_sha256"),
            "preparation_protocol": preparation.get("protocol_version"),
        },
        "candidate": {
            "model_version": artifact.get("model_version"),
            "artifact_sha256": hashlib.sha256(artifact_bytes).hexdigest(),
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "training_contract_sha256": sha(json.dumps(contract, sort_keys=True, separators=(",", ":")).encode("utf-8")),
            "production_eligible": False,
            "promotion_status": "CANDIDATE_ONLY",
        },
        "provenance": {
            "external_archive_sha256": preparation.get("source_archive_sha256"),
            "publisher_exclusion_set_sha256": preparation.get("external_publisher_fingerprint_set_sha256"),
            "publisher_fingerprint_exclusion_input_sha256": exclusion_metadata.get("exclusion_input_sha256"),
            "candidate_development_publisher_count": len(candidate_domain_fingerprints),
            "external_evaluation_publisher_count": len(external_domain_fingerprints),
            "publisher_overlap_count": len(source_overlap),
            "external_eval_jsonl_sha256": evaluation_file_sha256,
            "external_raw_articles_uploaded": False,
            "source_independence_method": "Eligible external source domains are excluded from candidate development; any external article sharing a repository-defined near-duplicate cluster with candidate-development text is removed.",
        },
        "metrics": {"raw_binary": raw, "frozen_runtime_policy": policy},
        "gates": {
            "candidate_integrity_errors": structural_errors,
            "internal_frozen_policy_gate_passed": internal_policy_gate,
            "external_sample_count_gate_passed": len(records) >= MIN_EXTERNAL_SAMPLES,
            "publisher_independence_gate_passed": not source_overlap,
            "external_quality_gate_passed": bool(external_quality_gate),
            "external_screening_gate_passed": bool(screening_passed),
        },
        "release_gate": {
            "passed": False,
            "production_promotion_authorized": False,
            "reason": "A candidate-only screening pass cannot satisfy the remaining human review, source-provenance review, runtime-policy/byline ablation and exact-head end-to-end fact-verification gates.",
        },
        "interpretation": [
            "Publisher exclusion is based on source metadata, not external performance.",
            "The external set is not used for model, feature, calibration or threshold selection.",
            "The frozen 0.98 fake and 0.35 real thresholds are unchanged.",
            "Raw article text remains in a temporary local file and is not included in this report.",
            "An external screening pass is not global real-world accuracy and does not authorize production promotion.",
        ],
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"candidate": report["candidate"], "dataset": report["dataset"], "gates": report["gates"], "release_gate": report["release_gate"]}, indent=2))
    if not screening_passed:
        raise SystemExit("External candidate screening gate failed; inspect the saved report. Production remains unchanged.")

if __name__ == "__main__":
    main()
