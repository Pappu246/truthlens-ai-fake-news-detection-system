#!/usr/bin/env python3
"""Evaluate a candidate only on its untouched WELFake full-article holdout.

WELFake has train/validation/holdout partitions from the same corpus. This
evaluator validates the hash-only split manifest and scores only the held-out
partition. It removes normalized exact-text overlap with ISOT and verifies the
dataset checksum. Article text is never written into the report. This is a
same-corpus split test, not source-independent external validation.
"""
import argparse
import csv
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_isot_runtime_candidate import article_text, clean_text, read_isot, score_runtime, sha256

WELFAKE_URL = "https://zenodo.org/records/4561253/files/WELFake_Dataset.csv?download=1"
WELFAKE_MD5 = "73c9675a4b3d09f86a6933d0b8d7d908"
MIN_ARTICLE_CHARS = 300
MIN_ARTICLE_WORDS = 50
MIN_GATE_SAMPLES = 10_000


def md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def text_hash(text: str) -> str | None:
    cleaned = clean_text(text)
    if not cleaned:
        return None
    return hashlib.sha256(cleaned.encode("utf-8")).hexdigest()



def compute_runtime_policy_metrics(y_fake: np.ndarray, p_fake: np.ndarray,
                                  fake_threshold: float = 0.65,
                                  real_threshold: float = 0.35) -> dict:
    """Score using TruthLens' actual calibrated runtime policy, including abstention.

    Positive class is FAKE=1; p_fake in the open interval (real_threshold,
    fake_threshold) deliberately abstains and is counted as incorrect in the
    operational metrics, while selective metrics are reported separately.
    """
    prediction = np.full(len(p_fake), -1, dtype=int)
    prediction[p_fake <= real_threshold] = 0
    prediction[p_fake >= fake_threshold] = 1
    decided = prediction >= 0
    real_mask = y_fake == 0
    fake_mask = y_fake == 1
    tn = int(np.sum(real_mask & (prediction == 0)))
    fp = int(np.sum(real_mask & (prediction == 1)))
    fn = int(np.sum(fake_mask & (prediction == 0)))
    tp = int(np.sum(fake_mask & (prediction == 1)))
    abstain_real = int(np.sum(real_mask & (prediction == -1)))
    abstain_fake = int(np.sum(fake_mask & (prediction == -1)))
    total = max(1, len(y_fake))
    decided_count = int(decided.sum())
    decided_balanced = None
    decided_accuracy = None
    if decided_count:
        decided_balanced = float(balanced_accuracy_score(y_fake[decided], prediction[decided]))
        decided_accuracy = float(accuracy_score(y_fake[decided], prediction[decided]))
    real_total = max(1, int(real_mask.sum()))
    fake_total = max(1, int(fake_mask.sum()))
    real_recall = tn / real_total
    fake_recall = tp / fake_total
    return {
        "policy": "p_fake >= 0.65 => LIKELY FAKE; p_fake <= 0.35 => LIKELY REAL; otherwise NEEDS MORE CONTEXT",
        "fake_threshold": fake_threshold,
        "real_threshold": real_threshold,
        "sample_count": int(len(y_fake)),
        "decided_count": decided_count,
        "coverage": float(decided_count / total),
        "abstention_rate": float(1.0 - decided_count / total),
        "operational_accuracy_abstentions_count_as_not_correct": float((tn + tp) / total),
        "operational_balanced_accuracy_abstentions_count_as_not_correct": float((fake_recall + real_recall) / 2.0),
        "fake_recall_all_fake_samples": float(fake_recall),
        "real_recall_all_real_samples": float(real_recall),
        "selective_accuracy_on_decided_only": decided_accuracy,
        "selective_balanced_accuracy_on_decided_only": decided_balanced,
        "confusion_matrix_decided_only": [[tn, fp], [fn, tp]],
        "abstained_real_samples": abstain_real,
        "abstained_fake_samples": abstain_fake,
        "confusion_matrix_layout": "[[TN, FP], [FN, TP]]; abstentions are counted separately; positive class is FAKE (1)",
    }

def neutralize_source_attribution(title: str, body: str) -> str:
    """Remove common wire-service byline strings for a source-cue stress test.

    This is a deliberately conservative ablation: it does not remove publisher
    names throughout article prose, entities, figures, or factual claims.
    """
    safe_title = re.sub(
        r"\s*(?:[-|–—]\s*)(?:Reuters|Associated Press|AP News|AFP|Agence France-Presse|Bloomberg News)\s*$",
        "",
        (title or "").strip(),
        flags=re.IGNORECASE,
    )
    safe_body = (body or "").strip()
    safe_body = re.sub(
        r"^\s*(?:[A-Z][A-Z0-9 .,'’/-]{2,60}\s+)?\(\s*(?:Reuters|Associated Press|AP News|AP|AFP|Bloomberg News)\s*\)\s*[-—:]\s*",
        "",
        safe_body,
        count=1,
        flags=re.IGNORECASE,
    )
    safe_body = re.sub(
        r"^\s*(?:Reuters|Associated Press|AP News|AP|AFP|Bloomberg News)\s*[-—:]\s*",
        "",
        safe_body,
        count=1,
        flags=re.IGNORECASE,
    )
    return (safe_title + " " + safe_body).strip()


def compute_metrics(y_fake: np.ndarray, p_fake: np.ndarray) -> dict:
    predicted_fake = (p_fake >= 0.5).astype(int)
    matrix = confusion_matrix(y_fake, predicted_fake, labels=[0, 1])
    tn, fp, fn, tp = (int(x) for x in matrix.ravel())
    return {
        "accuracy": float(accuracy_score(y_fake, predicted_fake)),
        "balanced_accuracy": float(balanced_accuracy_score(y_fake, predicted_fake)),
        "macro_f1": float(f1_score(y_fake, predicted_fake, average="macro", zero_division=0)),
        "fake_precision": float(precision_score(y_fake, predicted_fake, pos_label=1, zero_division=0)),
        "fake_recall": float(recall_score(y_fake, predicted_fake, pos_label=1, zero_division=0)),
        "real_recall": float(recall_score(y_fake, predicted_fake, pos_label=0, zero_division=0)),
        "roc_auc_fake": float(roc_auc_score(y_fake, p_fake)),
        "brier_fake": float(brier_score_loss(y_fake, p_fake)),
        "confusion_matrix_real_fake": [[tn, fp], [fn, tp]],
        "confusion_matrix_layout": "[[TN, FP], [FN, TP]]; positive class is FAKE (1)",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-dir", required=True)
    parser.add_argument("--welfake", required=True)
    parser.add_argument("--expected-md5", default=WELFAKE_MD5)
    args = parser.parse_args()

    candidate_dir = Path(args.candidate_dir).resolve()
    artifact_path = candidate_dir / "model_artifact.json"
    manifest_path = candidate_dir / "manifest.json"
    split_manifest_path = candidate_dir / "welfake_split_manifest.json"
    welfake_path = Path(args.welfake).resolve()
    for path in (artifact_path, manifest_path, split_manifest_path, welfake_path):
        if not path.is_file():
            raise SystemExit(f"Missing required evaluation input: {path}")

    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    split_manifest = json.loads(split_manifest_path.read_text(encoding="utf-8"))
    artifact_digest = sha256(artifact_path)
    if artifact_digest != manifest.get("artifact_sha256"):
        raise SystemExit("Candidate artifact hash does not match its manifest.")
    dataset_md5 = md5(welfake_path)
    if args.expected_md5 and dataset_md5.lower() != args.expected_md5.lower():
        raise SystemExit(f"WELFake checksum mismatch: expected {args.expected_md5}, got {dataset_md5}")
    if split_manifest.get("dataset_md5") != dataset_md5:
        raise SystemExit("WELFake split manifest checksum does not match the supplied CSV.")
    if split_manifest.get("is_source_independent_external_test") is not False:
        raise SystemExit("WELFake split manifest must explicitly declare same-corpus holdout scope.")
    train_hashes = set(split_manifest.get("train_hashes", []))
    validation_hashes = set(split_manifest.get("validation_hashes", []))
    holdout_hashes = set(split_manifest.get("holdout_hashes", []))
    if not holdout_hashes or (
        train_hashes & validation_hashes or train_hashes & holdout_hashes or
        validation_hashes & holdout_hashes
    ):
        raise SystemExit("WELFake split manifest is missing holdout hashes or has overlapping partitions.")
    if len(holdout_hashes) < MIN_GATE_SAMPLES:
        raise SystemExit(f"WELFake holdout has only {len(holdout_hashes)} hashes; at least {MIN_GATE_SAMPLES} are required.")

    # Hash all normalized ISOT article bodies so exact text overlap cannot
    # contaminate the held-out WELFake evaluation.
    isot_rows = read_isot()
    isot_hashes = {
        digest for digest in (
            text_hash(article_text(article)) for article in isot_rows.values()
        ) if digest
    }

    frame = pd.read_csv(welfake_path, dtype=str, keep_default_na=False, low_memory=False)
    frame.columns = [str(c).strip().lower() for c in frame.columns]
    required = {"title", "text", "label"}
    if not required.issubset(frame.columns):
        raise SystemExit(f"WELFake schema mismatch; required columns are {sorted(required)}, got {list(frame.columns)}")

    grouped: dict[str, list[dict]] = defaultdict(list)
    counters = {
        "rows_read": int(len(frame)),
        "invalid_label_rows": 0,
        "short_or_empty_rows": 0,
        "isot_exact_overlap_rows_removed": 0,
        "same_label_duplicate_rows_removed": 0,
        "conflicting_duplicate_group_rows_removed": 0,
        "non_holdout_partition_rows_excluded": 0,
    }

    for row in frame[["title", "text", "label"]].to_dict("records"):
        title = str(row["title"]).strip()
        body = str(row["text"]).strip()
        try:
            dataset_label = int(str(row["label"]).strip())
        except (TypeError, ValueError):
            counters["invalid_label_rows"] += 1
            continue
        if dataset_label not in (0, 1):
            counters["invalid_label_rows"] += 1
            continue
        full_text = (title + " " + body).strip()
        if len(full_text) < MIN_ARTICLE_CHARS or len(full_text.split()) < MIN_ARTICLE_WORDS:
            counters["short_or_empty_rows"] += 1
            continue

        digest = text_hash(full_text)
        if not digest:
            counters["short_or_empty_rows"] += 1
            continue
        if digest in isot_hashes:
            counters["isot_exact_overlap_rows_removed"] += 1
            continue

        grouped[digest].append({
            "text": full_text,
            "title": title,
            "body": body,
            # WELFake: 0=FAKE, 1=REAL. TruthLens runtime: 1=FAKE, 0=REAL.
            "y_fake": 1 if dataset_label == 0 else 0,
        })

    if holdout_hashes - set(grouped):
        missing = len(holdout_hashes - set(grouped))
        raise SystemExit(f"WELFake holdout integrity failure: {missing} expected holdout hashes were not found after input filtering.")

    samples = []
    for digest, duplicates in grouped.items():
        if digest not in holdout_hashes:
            counters["non_holdout_partition_rows_excluded"] += len(duplicates)
            continue
        labels = {entry["y_fake"] for entry in duplicates}
        if len(labels) != 1:
            counters["conflicting_duplicate_group_rows_removed"] += len(duplicates)
            continue
        counters["same_label_duplicate_rows_removed"] += max(0, len(duplicates) - 1)
        samples.append(duplicates[0])

    if not samples:
        raise SystemExit("No eligible WELFake full-article samples remained after quality/deduplication checks.")

    y_fake = np.asarray([entry["y_fake"] for entry in samples], dtype=int)
    p_fake = np.asarray([score_runtime(entry["text"], artifact)[0] for entry in samples], dtype=float)
    metrics = compute_metrics(y_fake, p_fake)
    runtime_policy_metrics = compute_runtime_policy_metrics(y_fake, p_fake)
    # This inverse-score statistic is diagnostic only. It helps distinguish a
    # likely domain/style inversion from a mediocre ranking, but it must never
    # reverse dataset labels or be used to make a candidate eligible.
    inverse_score_auc_diagnostic_only = float(roc_auc_score(y_fake, 1.0 - p_fake))
    neutralized_texts = [
        neutralize_source_attribution(entry["title"], entry["body"])
        for entry in samples
    ]
    p_fake_neutralized = np.asarray([
        score_runtime(text, artifact)[0] for text in neutralized_texts
    ], dtype=float)
    neutralized_metrics = compute_metrics(y_fake, p_fake_neutralized)
    neutralized_runtime_policy_metrics = compute_runtime_policy_metrics(y_fake, p_fake_neutralized)
    release_thresholds = {
        "minimum_eligible_samples": MIN_GATE_SAMPLES,
        "minimum_balanced_accuracy": 0.70,
        "minimum_fake_recall": 0.70,
        "minimum_real_recall": 0.70,
        "minimum_byline_ablation_balanced_accuracy": 0.65,
        "minimum_byline_ablation_fake_recall": 0.65,
        "minimum_byline_ablation_real_recall": 0.65,
        "minimum_runtime_policy_coverage": 0.50,
        "minimum_runtime_policy_balanced_accuracy": 0.70,
        "minimum_byline_runtime_policy_coverage": 0.50,
        "minimum_byline_runtime_policy_balanced_accuracy": 0.65,
    }
    raw_gate_passed = (
        len(samples) >= release_thresholds["minimum_eligible_samples"]
        and metrics["balanced_accuracy"] >= release_thresholds["minimum_balanced_accuracy"]
        and metrics["fake_recall"] >= release_thresholds["minimum_fake_recall"]
        and metrics["real_recall"] >= release_thresholds["minimum_real_recall"]
    )
    byline_ablation_passed = (
        neutralized_metrics["balanced_accuracy"] >= release_thresholds["minimum_byline_ablation_balanced_accuracy"]
        and neutralized_metrics["fake_recall"] >= release_thresholds["minimum_byline_ablation_fake_recall"]
        and neutralized_metrics["real_recall"] >= release_thresholds["minimum_byline_ablation_real_recall"]
    )
    runtime_policy_passed = (
        runtime_policy_metrics["coverage"] >= release_thresholds["minimum_runtime_policy_coverage"]
        and runtime_policy_metrics["operational_balanced_accuracy_abstentions_count_as_not_correct"]
            >= release_thresholds["minimum_runtime_policy_balanced_accuracy"]
        and runtime_policy_metrics["fake_recall_all_fake_samples"] >= 0.70
        and runtime_policy_metrics["real_recall_all_real_samples"] >= 0.70
    )
    byline_runtime_policy_passed = (
        neutralized_runtime_policy_metrics["coverage"]
            >= release_thresholds["minimum_byline_runtime_policy_coverage"]
        and neutralized_runtime_policy_metrics["operational_balanced_accuracy_abstentions_count_as_not_correct"]
            >= release_thresholds["minimum_byline_runtime_policy_balanced_accuracy"]
        and neutralized_runtime_policy_metrics["fake_recall_all_fake_samples"] >= 0.65
        and neutralized_runtime_policy_metrics["real_recall_all_real_samples"] >= 0.65
    )
    release_gate_passed = (
        raw_gate_passed and byline_ablation_passed and
        runtime_policy_passed and byline_runtime_policy_passed
    )

    report = {
        "status": "COMPLETED",
        "dataset": "WELFake untouched held-out full-article partition (Zenodo record 4561253)",
        "dataset_url": WELFAKE_URL,
        "dataset_md5": dataset_md5,
        "label_mapping": {"dataset_0": "FAKE", "dataset_1": "REAL", "runtime_fake_positive": 1},
        "task": "Full-article fake-vs-real classification on held-out article hashes not used in fitting, calibration or model selection. WELFake train/validation partitions are included in the multi-source candidate; this is not source-independent external validation.",
        "partition_scope": {
            "is_source_independent_external_test": False,
            "split_manifest": "welfake_split_manifest.json",
            "train_article_hash_count": len(train_hashes),
            "validation_article_hash_count": len(validation_hashes),
            "holdout_article_hash_count": len(holdout_hashes),
            "holdout_overlaps_train": bool(holdout_hashes & train_hashes),
            "holdout_overlaps_validation": bool(holdout_hashes & validation_hashes),
            "holdout_is_never_fit_calibrated_or_selected": True,
            "note": "Same-corpus holdout only; no claim of source-independent external validation.",
        },
        "candidate_model_version": manifest.get("model_version"),
        "candidate_artifact_sha256": artifact_digest,
        "isot_source_dataset_fingerprint": manifest.get("dataset_fingerprint"),
        "eligible_samples": len(samples),
        "fake_samples": int(y_fake.sum()),
        "real_samples": int(len(y_fake) - y_fake.sum()),
        "deduplication": {
            **counters,
            "isot_exact_overlap_hashes_count": len(isot_hashes),
            "normalized_exact_text_hashing": "TruthLens runtime cleaner; SHA-256; article body plus title",
            "minimum_characters": MIN_ARTICLE_CHARS,
            "minimum_words": MIN_ARTICLE_WORDS,
        },
        "metrics": metrics,
        "runtime_decision_policy": {
            "metrics": runtime_policy_metrics,
            "passed": runtime_policy_passed,
            "required_minimum_coverage": release_thresholds["minimum_runtime_policy_coverage"],
            "required_minimum_operational_balanced_accuracy": release_thresholds["minimum_runtime_policy_balanced_accuracy"],
            "required_minimum_recall_per_class": 0.70,
        },
        "score_orientation_diagnostic_only": {
            "roc_auc_fake_with_correct_label_mapping": metrics["roc_auc_fake"],
            "roc_auc_if_scores_were_inverted": inverse_score_auc_diagnostic_only,
            "note": "Diagnostic only. Dataset labels and production score orientation were not reversed; this field never participates in the release gate.",
        },
        "source_attribution_ablation": {
            "method": "Remove common wire-service byline strings at the start of body and publisher suffixes at title end; do not remove names throughout factual prose.",
            "metrics": neutralized_metrics,
            "runtime_decision_policy": {
                "metrics": neutralized_runtime_policy_metrics,
                "passed": byline_runtime_policy_passed,
                "required_minimum_coverage": release_thresholds["minimum_byline_runtime_policy_coverage"],
                "required_minimum_operational_balanced_accuracy": release_thresholds["minimum_byline_runtime_policy_balanced_accuracy"],
                "required_minimum_recall_per_class": 0.65,
            },
            "thresholds": {
                "minimum_balanced_accuracy": release_thresholds["minimum_byline_ablation_balanced_accuracy"],
                "minimum_fake_recall": release_thresholds["minimum_byline_ablation_fake_recall"],
                "minimum_real_recall": release_thresholds["minimum_byline_ablation_real_recall"],
            },
            "passed": byline_ablation_passed,
        },
        "release_thresholds": release_thresholds,
        "release_gate": {
            "passed": release_gate_passed,
            "checks": {
                "raw_full_article_gate": raw_gate_passed,
                "source_attribution_ablation_gate": byline_ablation_passed,
                "runtime_decision_policy_gate": runtime_policy_passed,
                "byline_runtime_decision_policy_gate": byline_runtime_policy_passed,
            },
            "result": "PASS" if release_gate_passed else "BLOCKED",
            "reason": (
                "Raw full-article and byline-ablation thresholds passed."
                if release_gate_passed
                else "One or more full-article or byline-ablation release thresholds failed."
            ),
        },
        "limitations": [
            "WELFake is a historical benchmark assembled from multiple corpora; it does not establish present-day real-world accuracy.",
            "Only exact normalized-text duplicates across ISOT and WELFake are removed; source-level or near-duplicate leakage may remain.",
            "The result supplements, and does not replace, retrieval-grounded verification and human review.",
            "Full article text is not written into the evaluation report or uploaded as an artifact."
        ],
    }

    out_path = candidate_dir / "article_heldout_validation.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    manifest["production_eligible"] = bool(release_gate_passed)
    manifest["promotion_status"] = "CANDIDATE_VALIDATED" if release_gate_passed else "CANDIDATE_ONLY"
    manifest["article_validation"] = {
        "status": report["status"],
        "release_gate_passed": bool(release_gate_passed),
        "path": "article_heldout_validation.json",
        "dataset": report["dataset"],
        "dataset_md5": dataset_md5,
        "is_source_independent_external_test": False,
        "eligible_samples": len(samples),
        "balanced_accuracy": metrics["balanced_accuracy"],
        "fake_recall": metrics["fake_recall"],
        "real_recall": metrics["real_recall"],
        "runtime_policy_gate_passed": runtime_policy_passed,
        "runtime_policy_coverage": runtime_policy_metrics["coverage"],
        "runtime_policy_operational_balanced_accuracy": runtime_policy_metrics["operational_balanced_accuracy_abstentions_count_as_not_correct"],
        "source_attribution_ablation_passed": byline_ablation_passed,
        "source_attribution_ablation_balanced_accuracy": neutralized_metrics["balanced_accuracy"],
        "source_attribution_runtime_policy_gate_passed": byline_runtime_policy_passed,
        "metrics_sha256": hashlib.sha256(json.dumps({
            "raw_0_50_diagnostic": metrics,
            "runtime_policy": runtime_policy_metrics,
            "source_attribution_ablation_0_50_diagnostic": neutralized_metrics,
            "source_attribution_runtime_policy": neutralized_runtime_policy_metrics,
            "score_orientation_auc_diagnostic_only": inverse_score_auc_diagnostic_only,
        }, sort_keys=True).encode()).hexdigest(),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(json.dumps({
        "report": str(out_path),
        "candidate_model_version": report["candidate_model_version"],
        "eligible_samples": report["eligible_samples"],
        "fake_samples": report["fake_samples"],
        "real_samples": report["real_samples"],
        "deduplication": report["deduplication"],
        "metrics_at_0_50_diagnostic": metrics,
        "runtime_decision_policy": report["runtime_decision_policy"],
        "score_orientation_diagnostic_only": report["score_orientation_diagnostic_only"],
        "source_attribution_ablation": report["source_attribution_ablation"],
        "partition_scope": report["partition_scope"],
        "release_thresholds": report["release_thresholds"],
        "release_gate": report["release_gate"],
        "production_eligible": manifest["production_eligible"],
        "candidate_artifact_hash_verified": True,
        "full_article_text_persisted": False,
    }, indent=2))


if __name__ == "__main__":
    main()
