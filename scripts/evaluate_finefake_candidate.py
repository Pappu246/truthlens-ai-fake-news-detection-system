#!/usr/bin/env python3
"""Evaluate a calibrated TruthLens candidate on task-matched FineFake text.

Input must be a CSV export made in a trusted, isolated environment after the
FineFake archive was fingerprinted and reviewed. This script never unpickles
the source archive. Fine-grained labels are filtered to real (0) and text-based
fake (3) only; image/knowledge-dependent labels are excluded.
"""
from __future__ import annotations

import argparse
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
from train_isot_runtime_candidate import (
    FAKE_THRESHOLD,
    REAL_THRESHOLD,
    LOW_VOCABULARY_COVERAGE_THRESHOLD,
    OOD_SHORT_WORD_COUNT,
    OOD_COVERAGE_THRESHOLD,
    article_text,
    clean_text,
    file_md5,
    read_isot,
    score_runtime,
    sha256,
)
from evaluate_welfake_candidate import compute_runtime_policy_metrics

OFFICIAL_REPOSITORY = "https://github.com/Accuser907/FineFake"
OFFICIAL_DOWNLOAD = "https://drive.google.com/file/d/16D9ix7ZOisa4VVBznBTBcv1N7TA-jodH/view"
MIN_ARTICLE_CHARS = 300
MIN_ARTICLE_WORDS = 50
MIN_EXTERNAL_GATE_SAMPLES = 10_000
MIN_PER_CLASS = 2


def normalise_column_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower()).strip("_")


def normalise_finefake_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Map the documented FineFake schema to stable column names."""
    renamed = {column: normalise_column_name(column) for column in frame.columns}
    result = frame.rename(columns=renamed).copy()
    # First-party releases and derived CSV exports may call this field differently.
    aliases = {
        "fine_grained_label": ("fine_grained_label", "finegrained_label", "fine_label"),
        "platform": ("platform", "source", "publisher"),
        "topic": ("topic", "category"),
        "date": ("date", "published_at", "publication_date"),
    }
    for target, names in aliases.items():
        if target not in result.columns:
            found = next((name for name in names if name in result.columns), None)
            if found:
                result[target] = result[found]
    required = {"text", "label", "fine_grained_label"}
    missing = sorted(required - set(result.columns))
    if missing:
        raise ValueError(
            "FineFake CSV schema mismatch; missing canonical columns "
            + ", ".join(missing)
            + f"; observed columns: {list(result.columns)}"
        )
    for optional in ("platform", "topic", "date"):
        if optional not in result.columns:
            result[optional] = ""
    return result


def normalized_text_hash(text: str) -> str | None:
    normalized = clean_text(text or "")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest() if normalized else None


def validate_dataset_manifest(csv_path: Path, manifest_path: Path, frame_rows: int) -> dict:
    """Verify local export provenance and bytes before treating it as benchmark input."""
    if not manifest_path.is_file():
        raise ValueError(f"Required FineFake intake manifest is missing: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("dataset") != "FineFake":
        raise ValueError("Dataset manifest must identify FineFake.")
    if manifest.get("official_repository") != OFFICIAL_REPOSITORY:
        raise ValueError("Dataset manifest source does not match the official FineFake repository.")
    archive_digest = str(manifest.get("source_archive_sha256", "")).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", archive_digest):
        raise ValueError("FineFake source archive SHA-256 must be pinned in the intake manifest.")
    expected_csv_digest = str(manifest.get("csv_sha256", "")).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_csv_digest):
        raise ValueError("FineFake CSV SHA-256 is missing or malformed in the intake manifest.")
    actual_csv_digest = sha256(csv_path)
    if actual_csv_digest != expected_csv_digest:
        raise ValueError(
            f"FineFake CSV checksum mismatch: expected {expected_csv_digest}, got {actual_csv_digest}"
        )
    if manifest.get("row_count") != frame_rows:
        raise ValueError(
            f"FineFake row-count mismatch: manifest says {manifest.get('row_count')}, parsed {frame_rows}"
        )
    if manifest.get("conversion_method") != "trusted_offline_conversion_after_archive_hash_review":
        raise ValueError(
            "FineFake export lacks the required trusted offline conversion attestation; "
            "do not load the source pickle in CI."
        )
    return manifest


def collect_overlap_hashes(isot_articles: dict, welfake_path: Path) -> set[str]:
    """Hash both body-only and title+body forms to catch exact-text leakage."""
    hashes: set[str] = set()

    def add(text: str) -> None:
        digest = normalized_text_hash(text)
        if digest:
            hashes.add(digest)

    for article in isot_articles.values():
        add(str(article.get("text", "")))
        add(article_text(article))
    if not welfake_path.is_file():
        raise FileNotFoundError(f"Verified WELFake CSV is required for overlap auditing: {welfake_path}")
    if file_md5(welfake_path).lower() != "73c9675a4b3d09f86a6933d0b8d7d908":
        raise ValueError("WELFake checksum mismatch while building FineFake overlap set.")
    corpus = pd.read_csv(welfake_path, dtype=str, keep_default_na=False, low_memory=False)
    corpus.columns = [normalise_column_name(c) for c in corpus.columns]
    if not {"title", "text"}.issubset(corpus.columns):
        raise ValueError("WELFake overlap corpus is missing title/text columns.")
    for row in corpus[["title", "text"]].to_dict("records"):
        add(str(row.get("text", "")))
        add(f"{row.get('title', '')} {row.get('text', '')}")
    return hashes


def prepare_finefake_rows(
    frame: pd.DataFrame,
    corpus_hashes: set[str],
    min_chars: int = MIN_ARTICLE_CHARS,
    min_words: int = MIN_ARTICLE_WORDS,
) -> tuple[list[dict], dict]:
    """Select only label-consistent real/text-fake rows, filter overlaps and deduplicate."""
    data = normalise_finefake_frame(frame)
    counters = {
        "rows_read": int(len(data)),
        "invalid_binary_label_rows": 0,
        "invalid_fine_grained_label_rows": 0,
        "other_fine_grained_labels_excluded": 0,
        "binary_fine_label_disagreements_excluded": 0,
        "short_or_empty_text_rows_excluded": 0,
        "exact_text_overlap_rows_removed": 0,
        "same_label_duplicate_rows_removed": 0,
        "conflicting_label_duplicate_groups_removed": 0,
    }
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in data[["text", "label", "fine_grained_label", "platform", "topic", "date"]].to_dict("records"):
        try:
            binary = int(str(row["label"]).strip())
        except (TypeError, ValueError):
            counters["invalid_binary_label_rows"] += 1
            continue
        try:
            fine = int(str(row["fine_grained_label"]).strip())
        except (TypeError, ValueError):
            counters["invalid_fine_grained_label_rows"] += 1
            continue

        # FineFake binary convention is 0=FAKE, 1=REAL. For the text-only
        # experiment, fine label 0 is real and fine label 3 is text-based fake.
        if fine not in (0, 3):
            counters["other_fine_grained_labels_excluded"] += 1
            continue
        if (fine == 0 and binary != 1) or (fine == 3 and binary != 0):
            counters["binary_fine_label_disagreements_excluded"] += 1
            continue

        text_value = str(row["text"] or "").strip()
        if len(text_value) < min_chars or len(text_value.split()) < min_words:
            counters["short_or_empty_text_rows_excluded"] += 1
            continue
        digest = normalized_text_hash(text_value)
        if not digest:
            counters["short_or_empty_text_rows_excluded"] += 1
            continue
        if digest in corpus_hashes:
            counters["exact_text_overlap_rows_removed"] += 1
            continue
        grouped[digest].append({
            "text": text_value,
            "y_fake": 0 if fine == 0 else 1,
            "fine_grained_label": fine,
            "platform": str(row.get("platform", "") or "").strip() or "UNKNOWN",
            "topic": str(row.get("topic", "") or "").strip() or "UNKNOWN",
            "date": str(row.get("date", "") or "").strip(),
            "text_sha256": digest,
        })

    records = []
    for digest, group in grouped.items():
        labels = {item["y_fake"] for item in group}
        if len(labels) > 1:
            counters["conflicting_label_duplicate_groups_removed"] += 1
            continue
        records.append(group[0])
        counters["same_label_duplicate_rows_removed"] += len(group) - 1
    counters["eligible_unique_rows"] = len(records)
    counters["eligible_fake_rows"] = sum(item["y_fake"] == 1 for item in records)
    counters["eligible_real_rows"] = sum(item["y_fake"] == 0 for item in records)
    return records, counters


def raw_metrics(y_true: np.ndarray, p_fake: np.ndarray) -> dict:
    predicted = (p_fake >= 0.5).astype(int)
    if len(set(y_true.tolist())) < 2:
        auc = None
    else:
        auc = float(roc_auc_score(y_true, p_fake))
    return {
        "diagnostic_threshold": 0.50,
        "accuracy": float(accuracy_score(y_true, predicted)),
        "balanced_accuracy": float(balanced_accuracy_score(y_true, predicted)),
        "fake_precision": float(precision_score(y_true, predicted, pos_label=1, zero_division=0)),
        "fake_recall": float(recall_score(y_true, predicted, pos_label=1, zero_division=0)),
        "real_recall": float(recall_score(y_true, predicted, pos_label=0, zero_division=0)),
        "macro_f1": float(f1_score(y_true, predicted, average="macro", zero_division=0)),
        "roc_auc_fake": auc,
        "brier_score": float(brier_score_loss(y_true, p_fake)),
        "confusion_matrix_labels_real_fake": confusion_matrix(y_true, predicted, labels=[0, 1]).tolist(),
    }


def evaluate_records(records: list[dict], artifact: dict) -> dict:
    y_fake = np.asarray([row["y_fake"] for row in records], dtype=int)
    probs, term_counts, matched_counts = [], [], []
    for row in records:
        probability, candidate_terms, matched_terms = score_runtime(row["text"], artifact)
        probs.append(float(probability))
        term_counts.append(int(candidate_terms))
        matched_counts.append(int(matched_terms))
    p_fake = np.asarray(probs, dtype=float)
    candidate_terms = np.asarray(term_counts, dtype=int)
    matched_terms = np.asarray(matched_counts, dtype=int)
    coverage_ratio = np.divide(
        matched_terms,
        candidate_terms,
        out=np.zeros_like(matched_terms, dtype=float),
        where=candidate_terms > 0,
    )
    runtime = compute_runtime_policy_metrics(
        y_fake,
        p_fake,
        texts=[row["text"] for row in records],
        coverage_ratio=coverage_ratio,
        candidate_term_count=candidate_terms,
    )
    platform_metrics = {}
    by_platform: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(records):
        by_platform[row["platform"]].append(index)
    for platform, indices in sorted(by_platform.items()):
        ys = y_fake[indices]
        platform_metrics[platform] = {
            "samples": len(indices),
            "fake_samples": int(ys.sum()),
            "real_samples": int(len(ys) - ys.sum()),
            "diagnostic_accuracy_at_0_50": float(accuracy_score(ys, p_fake[indices] >= 0.5)),
            "coverage_under_frozen_runtime_policy": float(runtime["coverage"]) if len(indices) == len(records) else None,
            "note": "Per-platform probabilities require a platform-scoped runtime policy evaluation; aggregate coverage is not copied as a per-platform result.",
        }
    return {
        "raw_diagnostic_metrics": raw_metrics(y_fake, p_fake),
        "runtime_policy_metrics": runtime,
        "probability_summary": {
            "min_p_fake": float(p_fake.min()),
            "median_p_fake": float(np.median(p_fake)),
            "max_p_fake": float(p_fake.max()),
            "mean_vocabulary_coverage": float(coverage_ratio.mean()),
        },
        "platform_counts": {
            platform: len(indices) for platform, indices in sorted(by_platform.items())
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-dir", required=True, type=Path)
    parser.add_argument("--dataset-csv", required=True, type=Path)
    parser.add_argument("--dataset-manifest", required=True, type=Path)
    parser.add_argument("--welfake", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    artifact_path = args.candidate_dir / "model_artifact.json"
    candidate_manifest_path = args.candidate_dir / "manifest.json"
    for path in (artifact_path, candidate_manifest_path, args.dataset_csv, args.dataset_manifest):
        if not path.is_file():
            raise SystemExit(f"Required input is missing: {path}")

    with candidate_manifest_path.open(encoding="utf-8") as handle:
        candidate_manifest = json.load(handle)
    expected_policy = {
        "fake_threshold": FAKE_THRESHOLD,
        "real_threshold": REAL_THRESHOLD,
        "low_vocabulary_coverage_threshold": LOW_VOCABULARY_COVERAGE_THRESHOLD,
        "ood_short_word_count": OOD_SHORT_WORD_COUNT,
        "ood_coverage_threshold": OOD_COVERAGE_THRESHOLD,
    }
    if candidate_manifest.get("training_contract", {}).get("runtime_policy", {}) != expected_policy:
        raise SystemExit("Candidate manifest is missing the exact frozen production-policy fingerprint.")
    artifact_digest = sha256(artifact_path)
    if artifact_digest != candidate_manifest.get("artifact_sha256"):
        raise SystemExit("Candidate artifact SHA-256 does not match its manifest.")
    with artifact_path.open(encoding="utf-8") as handle:
        artifact = json.load(handle)

    frame = pd.read_csv(args.dataset_csv, dtype=str, keep_default_na=False, low_memory=False)
    dataset_manifest = validate_dataset_manifest(args.dataset_csv, args.dataset_manifest, len(frame))
    isot_articles = read_isot()
    overlap_hashes = collect_overlap_hashes(isot_articles, args.welfake)
    records, counters = prepare_finefake_rows(frame, overlap_hashes)
    if counters["eligible_fake_rows"] < MIN_PER_CLASS or counters["eligible_real_rows"] < MIN_PER_CLASS:
        raise SystemExit(
            "FineFake task-matched evaluation blocked: fewer than two eligible samples in one class after filtering."
        )

    scored = evaluate_records(records, artifact)
    runtime = scored["runtime_policy_metrics"]
    policy_quality_passed = (
        runtime["coverage"] >= 0.50
        and runtime["operational_balanced_accuracy_abstentions_count_as_not_correct"] >= 0.70
        and runtime["fake_recall_all_fake_samples"] >= 0.70
        and runtime["real_recall_all_real_samples"] >= 0.70
    )
    # Source attribution for the candidate training corpus is not retained at a
    # level that can prove FineFake publishers are disjoint; therefore this
    # benchmark cannot satisfy the strict source-independent promotion gate.
    source_independence = {
        "proven_disjoint": False,
        "status": "NOT_PROVEN",
        "reason": (
            "FineFake identifies its platform/source, but the candidate's training corpus does not retain "
            "a complete publisher-level source registry proving disjointness."
        ),
    }
    blockers = []
    if len(records) < MIN_EXTERNAL_GATE_SAMPLES:
        blockers.append(f"eligible sample count {len(records)} is below the required {MIN_EXTERNAL_GATE_SAMPLES}")
    if not policy_quality_passed:
        blockers.append("frozen-runtime quality gate failed")
    blockers.append("source-independent status is NOT_PROVEN")
    blockers.append("publisher does not publish a signed archive checksum; intake hash is operator-pinned and requires provenance review")

    report = {
        "schema_version": 1,
        "status": "COMPLETED",
        "benchmark": "FineFake",
        "source": {
            "official_repository": OFFICIAL_REPOSITORY,
            "official_download": OFFICIAL_DOWNLOAD,
            "source_archive_sha256": dataset_manifest["source_archive_sha256"],
            "csv_sha256": dataset_manifest["csv_sha256"],
            "publisher_signed_checksum_available": False,
            "source_integrity_scope": "operator-pinned archive digest plus verified CSV digest; not a publisher-signed checksum",
            "source_independent_claim_allowed": False,
            "source_independence": source_independence,
        },
        "candidate": {
            "model_version": candidate_manifest.get("model_version"),
            "artifact_sha256": artifact_digest,
            "production_eligible": False,
            "promotion_status": "CANDIDATE_ONLY",
        },
        "task": {
            "type": "text-only article classification",
            "binary_label_convention": "FineFake binary label 0=FAKE, 1=REAL; runtime y_fake 1=FAKE, 0=REAL",
            "included_fine_grained_labels": {"0": "REAL", "3": "text-based FAKE"},
            "excluded_fine_grained_labels": {"1": "text-image inconsistency", "2": "content-knowledge inconsistency", "4": "image-based fake", "5": "other"},
            "minimum_article_characters": MIN_ARTICLE_CHARS,
            "minimum_article_words": MIN_ARTICLE_WORDS,
        },
        "deduplication_and_overlap": {
            **counters,
            "overlap_corpus": ["full ISOT corpus", "verified WELFake corpus"],
            "normalized_exact_text_overlap_removed": True,
            "normalized_exact_text_hashing": "TruthLens runtime cleaner plus SHA-256; body-only form",
            "near_duplicate_overlap_removed": False,
        },
        "metrics": scored,
        "quality_gate": {
            "runtime_policy_quality_passed": bool(policy_quality_passed),
            "release_gate_passed": False,
            "minimum_eligible_samples_for_external_gate": MIN_EXTERNAL_GATE_SAMPLES,
            "production_eligible": False,
            "promotion_status": "CANDIDATE_ONLY",
            "blockers": blockers,
        },
        "limitations": [
            "FineFake is an external cross-corpus stress test, but publisher/source independence is not proven.",
            "Only real and fine-grained text-based fake items are task-matched to the text-only model; other modalities/knowledge categories are excluded.",
            "Only normalized exact-text overlaps are removed; near-duplicate or source leakage may remain.",
            "No text, author names, comments, or image paths are written to the report.",
            "This report is deliberately not named external_article_validation.json and cannot satisfy the production promotion gate.",
        ],
    }
    output = args.output or args.candidate_dir / "finefake_candidate_evaluation.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        "report": str(output),
        "status": report["status"],
        "eligible_samples": counters["eligible_unique_rows"],
        "fake_samples": counters["eligible_fake_rows"],
        "real_samples": counters["eligible_real_rows"],
        "runtime_policy_coverage": runtime["coverage"],
        "runtime_policy_operational_balanced_accuracy": runtime["operational_balanced_accuracy_abstentions_count_as_not_correct"],
        "source_independence": source_independence["status"],
        "production_eligible": False,
        "release_gate_passed": False,
        "blockers": blockers,
    }, indent=2))


if __name__ == "__main__":
    main()
