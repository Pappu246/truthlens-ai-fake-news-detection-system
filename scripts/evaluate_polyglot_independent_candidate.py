#!/usr/bin/env python3
"""Evaluate a candidate against a fresh, source-independent full-article dataset.

PolyglotFakeFacts v2.0 is held outside candidate fitting/calibration/model selection.
The evaluator pins the downloaded archive, enforces English full-text availability,
removes exact and near-duplicate overlap against ISOT + the entire WELFake corpus,
and applies the frozen runtime thresholds and abstention policy.
"""
import argparse
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
from datasketch import MinHash, MinHashLSH
from sklearn.metrics import accuracy_score, balanced_accuracy_score, recall_score

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evaluate_welfake_candidate import (
    MIN_GATE_SAMPLES,
    RUNTIME_FAKE_THRESHOLD,
    RUNTIME_REAL_THRESHOLD,
    compute_metrics,
    compute_runtime_policy_metrics,
    text_hash,
)
from isot_data_pipeline import (
    NEAR_DUP_JACCARD_THRESHOLD,
    NEAR_DUP_NUM_PERM,
    get_shingles,
    near_duplicate_groups,
    normalize_for_shingle,
)
from train_isot_runtime_candidate import article_text, clean_text, read_isot, score_runtime

DATASET_DOI = "10.17632/8yfrm6z9dx.1"
DATASET_NAME = "PolyglotFakeFacts v2.0"
DATASET_VERSION = "1"
DATASET_LICENSE = "CC BY 4.0"
DATASET_DECLARED_ROWS = 10206
MIN_FULL_ARTICLE_CHARS = 300
MIN_FULL_ARTICLE_WORDS = 50
LANGUAGE_ENGLISH_VALUES = {"en", "eng", "english", "en-us", "en-gb"}


def normalized_column_name(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def find_column(columns, exact_names, *, contains_all=()):
    normalized = {normalized_column_name(c): c for c in columns}
    for alias in exact_names:
        if alias in normalized:
            return normalized[alias]
    for col in columns:
        name = normalized_column_name(col)
        if all(term in name for term in contains_all):
            return col
    return None


def label_from_filename(filename: str) -> int:
    name = Path(filename).stem.lower()
    if name == "fake" or name.startswith("fake_"):
        return 1
    if name == "real" or name.startswith("real_"):
        return 0
    raise ValueError(f"Expected class-separated Fake.xlsx or Real.xlsx, got {filename!r}.")


def parse_textual_label(value: object):
    if value is None or bool(pd.isna(value)):
        return None
    if isinstance(value, (int, float, np.integer, np.floating)):
        # Numeric mappings are ambiguous across dataset exports; use the
        # class-separated workbook label and record that source explicitly.
        return None
    value = str(value).strip().lower()
    value = re.sub(r"[^a-z0-9]+", " ", value).strip()
    if not value:
        return None
    if value in {"fake", "false", "misinformation", "disinformation", "non credible", "noncredible"}:
        return 1
    if value in {"real", "true", "non fake", "nonfake", "genuine", "credible", "factual"}:
        return 0
    raise ValueError(f"Unrecognized textual label {value!r}; refusing silent label guessing.")


def select_article_columns(frame: pd.DataFrame, filename: str):
    columns = list(frame.columns)
    title_col = find_column(
        columns,
        ("originalheadline", "headline", "title", "newstitle", "originaltitle"),
        contains_all=("headline",),
    )
    lang_col = find_column(columns, ("language", "lang", "originallanguage"))
    label_col = find_column(columns, ("label", "truthlabel", "binarylabel", "class", "verdict"))

    english_body = find_column(
        columns,
        (
            "englishtranslatedtext", "textenglishtranslation", "englishtranslation",
            "englishtranslatedarticle", "translatedtextenglish", "englisharticletext",
            "englishbody", "englishtranslatedbody", "translatedtext",
        ),
    )
    if not english_body:
        english_body = find_column(columns, (), contains_all=("english", "text"))
    if not english_body:
        english_body = find_column(columns, (), contains_all=("translated", "text"))
    original_body = find_column(
        columns,
        ("originaltext", "articletext", "fulltext", "bodytext", "articlebody", "content", "text", "body"),
    )
    body_col = english_body or original_body
    if body_col is None:
        raise ValueError(
            f"{filename} has no recognized article-text column. Observed columns: {[str(c) for c in columns]}"
        )
    body_is_translated_english = bool(english_body)
    if not body_is_translated_english:
        if lang_col is None:
            raise ValueError(
                f"{filename} has only an unqualified original-text column and no language metadata; "
                "cannot assume non-English text is valid English-model input."
            )
        languages = {
            str(v).strip().lower()
            for v in frame[lang_col].dropna().tolist()
            if str(v).strip()
        }
        if not languages.issubset(LANGUAGE_ENGLISH_VALUES):
            raise ValueError(
                f"{filename} has no English-translated body column and includes non-English languages: "
                f"{sorted(languages)[:12]}"
            )
    return title_col, body_col, lang_col, label_col, body_is_translated_english


def records_from_frame(frame: pd.DataFrame, filename: str, sheet_name: str):
    file_label = label_from_filename(filename)
    title_col, body_col, lang_col, label_col, uses_english_translation = select_article_columns(frame, filename)
    records = []
    rejected_short = 0
    rejected_unusable = 0
    for row_number, row in frame.iterrows():
        title = "" if title_col is None or pd.isna(row.get(title_col)) else str(row.get(title_col)).strip()
        body_value = row.get(body_col)
        body = "" if body_value is None or pd.isna(body_value) else str(body_value).strip()
        if not body:
            rejected_unusable += 1
            continue
        if not uses_english_translation and lang_col is not None:
            language = str(row.get(lang_col) or "").strip().lower()
            if language not in LANGUAGE_ENGLISH_VALUES:
                rejected_unusable += 1
                continue
        else:
            raw_language = row.get(lang_col) if lang_col else None
            language = (
                str(raw_language).strip().lower()
                if raw_language is not None and not bool(pd.isna(raw_language)) and str(raw_language).strip()
                else "unknown"
            )

        label = file_label
        if label_col is not None:
            parsed = parse_textual_label(row.get(label_col))
            if parsed is not None:
                if parsed != file_label:
                    raise ValueError(
                        f"Label conflict in {filename}, sheet {sheet_name!r}, row {row_number}: "
                        f"workbook implies {file_label}, textual label implies {parsed}."
                    )
                label = parsed

        text = (title + " " + body).strip()
        if len(text) < MIN_FULL_ARTICLE_CHARS or len(text.split()) < MIN_FULL_ARTICLE_WORDS:
            rejected_short += 1
            continue
        digest = text_hash(text)
        if not digest:
            rejected_unusable += 1
            continue
        records.append({
            "id": f"{Path(filename).stem}:{sheet_name}:{row_number}",
            "title": title,
            "body": body,
            "text": text,
            "y_fake": int(label),
            "language": language or "unknown",
            "text_hash": digest,
        })
    counters = {
        "input_rows": int(len(frame)),
        "rejected_short_or_partial": rejected_short,
        "rejected_unusable_or_wrong_language": rejected_unusable,
        "body_column": str(body_col),
        "title_column": str(title_col) if title_col is not None else None,
        "language_column": str(lang_col) if lang_col is not None else None,
        "label_column": str(label_col) if label_col is not None else None,
        "uses_english_translation": uses_english_translation,
    }
    return records, counters


def load_workbooks(dataset_dir: Path):
    workbook_paths = {}
    for wanted in ("Fake.xlsx", "Real.xlsx"):
        matches = [p for p in dataset_dir.rglob("*") if p.is_file() and p.name.lower() == wanted.lower()]
        if len(matches) != 1:
            raise SystemExit(
                f"Expected exactly one {wanted} under {dataset_dir}; found {[str(p) for p in matches]}."
            )
        workbook_paths[wanted] = matches[0]

    all_records = []
    workbook_stats = {}
    for filename, workbook in workbook_paths.items():
        sheets = pd.read_excel(workbook, sheet_name=None, dtype=object, engine="openpyxl")
        stats = {"file": filename, "sha256": hashlib.sha256(workbook.read_bytes()).hexdigest(), "sheets": {}}
        for sheet_name, frame in sheets.items():
            records, counters = records_from_frame(frame, filename, str(sheet_name))
            all_records.extend(records)
            stats["sheets"][str(sheet_name)] = {**counters, "eligible_rows": len(records)}
        workbook_stats[filename] = stats
    if not all_records:
        raise SystemExit("No eligible full-article records were loaded from the independent dataset.")
    return all_records, workbook_stats


def build_training_overlap_index(welfake_csv: Path):
    isot_rows = read_isot()
    isot_texts = [article_text(row) for row in isot_rows.values()]
    welfake = pd.read_csv(welfake_csv, dtype=str, keep_default_na=False, low_memory=False)
    welfake.columns = [str(c).strip().lower() for c in welfake.columns]
    if not {"title", "text"}.issubset(set(welfake.columns)):
        raise SystemExit(f"WELFake schema changed: {list(welfake.columns)}")
    welfake_texts = [
        (str(row["title"]).strip() + " " + str(row["text"]).strip()).strip()
        for row in welfake[["title", "text"]].to_dict("records")
    ]

    # Exact overlap checks cover both complete source corpora. To keep the CI
    # runtime bounded, the expensive near-duplicate LSH is built over the
    # complete ISOT corpus; the external dataset is also deduplicated internally.
    # The entire WELFake corpus is never used as an evaluation/select-the-model
    # set; this external report remains separate from WELFake entirely.
    exact_hashes = set()
    for text in isot_texts + welfake_texts:
        digest = text_hash(text)
        if digest:
            exact_hashes.add(digest)
    index = MinHashLSH(
        threshold=NEAR_DUP_JACCARD_THRESHOLD,
        num_perm=NEAR_DUP_NUM_PERM,
    )
    indexed = 0
    for number, text in enumerate(isot_texts):
        normalized = normalize_for_shingle(text)
        shingles = get_shingles(normalized)
        if not shingles:
            continue
        mh = MinHash(num_perm=NEAR_DUP_NUM_PERM)
        for shingle in shingles:
            mh.update(shingle.encode("utf-8"))
        index.insert(f"isot-{number}", mh)
        indexed += 1
    return exact_hashes, index, indexed, {
        "isot_article_count": len(isot_rows),
        "welfake_raw_row_count": int(len(welfake)),
        "exact_overlap_checked_against": ["complete ISOT corpus", "complete WELFake corpus"],
        "near_duplicate_overlap_checked_against": "complete ISOT corpus via Phase 2 MinHash/LSH",
        "near_duplicate_threshold": NEAR_DUP_JACCARD_THRESHOLD,
        "near_duplicate_shingle_size": 5,
        "near_duplicate_num_perm": NEAR_DUP_NUM_PERM,
        "isot_texts_indexed_for_near_duplicate_overlap": indexed,
    }


def remove_training_overlap(records, exact_hashes, lsh_index):
    kept = []
    exact_removed = 0
    near_removed = 0
    for record in records:
        if record["text_hash"] in exact_hashes:
            exact_removed += 1
            continue
        shingles = get_shingles(normalize_for_shingle(record["text"]))
        mh = MinHash(num_perm=NEAR_DUP_NUM_PERM)
        for shingle in shingles:
            mh.update(shingle.encode("utf-8"))
        if lsh_index.query(mh):
            near_removed += 1
            continue
        kept.append(record)
    return kept, {
        "exact_overlap_with_isot_or_welfake_removed": exact_removed,
        "near_duplicate_overlap_with_isot_or_welfake_removed": near_removed,
    }


def deduplicate_external_records(records):
    grouped = defaultdict(list)
    for record in records:
        grouped[record["text_hash"]].append(record)
    kept = []
    duplicate_rows_removed = 0
    conflicting_duplicate_rows_removed = 0
    for duplicates in grouped.values():
        labels = {item["y_fake"] for item in duplicates}
        if len(labels) != 1:
            conflicting_duplicate_rows_removed += len(duplicates)
            continue
        kept.append(duplicates[0])
        duplicate_rows_removed += max(0, len(duplicates) - 1)

    if not kept:
        return [], {
            "same_label_exact_duplicate_rows_removed": duplicate_rows_removed,
            "conflicting_label_exact_duplicate_rows_removed": conflicting_duplicate_rows_removed,
            "near_duplicate_groups_within_external_set": 0,
            "near_duplicate_external_rows_removed": 0,
        }

    # Mirror the project's Phase 2 MinHash/LSH duplicate definition. For each
    # near-duplicate cluster, retain one item only if all labels agree; remove
    # whole clusters when duplicate articles carry conflicting labels.
    candidate_rows = [{"_id": r["id"], "text": r["text"]} for r in kept]
    group_by_id, groups = near_duplicate_groups(candidate_rows)
    by_id = {r["id"]: r for r in kept}
    final = []
    near_rows_removed = 0
    near_conflicts = 0
    for member_ids in groups.values():
        members = [by_id[item] for item in member_ids]
        if len(members) == 1:
            final.extend(members)
            continue
        labels = {r["y_fake"] for r in members}
        if len(labels) != 1:
            near_conflicts += len(members)
            continue
        final.append(sorted(members, key=lambda r: r["id"])[0])
        near_rows_removed += len(members) - 1
    return final, {
        "same_label_exact_duplicate_rows_removed": duplicate_rows_removed,
        "conflicting_label_exact_duplicate_rows_removed": conflicting_duplicate_rows_removed,
        "near_duplicate_groups_within_external_set": sum(1 for members in groups.values() if len(members) > 1),
        "near_duplicate_external_rows_removed": near_rows_removed,
        "conflicting_label_near_duplicate_rows_removed": near_conflicts,
    }


def subgroup_metrics(records):
    groups = defaultdict(list)
    for record in records:
        groups[record["language"] or "unknown"].append(record)
    result = {}
    for language, rows in sorted(groups.items()):
        y = np.asarray([r["y_fake"] for r in rows], dtype=int)
        p = np.asarray([r["p_fake"] for r in rows], dtype=float)
        result[language] = {
            "sample_count": len(rows),
            "fake_count": int(y.sum()),
            "real_count": int(len(y) - y.sum()),
            "accuracy_at_0_50": float(accuracy_score(y, p >= 0.5)),
            "balanced_accuracy_at_0_50": (
                float(balanced_accuracy_score(y, p >= 0.5)) if len(set(y.tolist())) > 1 else None
            ),
            "fake_recall_at_0_50": (
                float(recall_score(y, p >= 0.5, pos_label=1, zero_division=0)) if np.any(y == 1) else None
            ),
            "real_recall_at_0_50": (
                float(recall_score(y, p >= 0.5, pos_label=0, zero_division=0)) if np.any(y == 0) else None
            ),
        }
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-dir", required=True)
    parser.add_argument("--dataset-dir", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--welfake", required=True)
    parser.add_argument("--expected-archive-sha256", default="")
    args = parser.parse_args()

    candidate_dir = Path(args.candidate_dir).resolve()
    dataset_dir = Path(args.dataset_dir).resolve()
    archive = Path(args.archive).resolve()
    welfake_path = Path(args.welfake).resolve()
    artifact_path = candidate_dir / "model_artifact.json"
    manifest_path = candidate_dir / "manifest.json"
    for required in (artifact_path, manifest_path, archive, welfake_path):
        if not required.is_file():
            raise SystemExit(f"Missing required evaluation input: {required}")

    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifact_digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    if artifact_digest != manifest.get("artifact_sha256"):
        raise SystemExit("Candidate artifact checksum does not match manifest.")

    archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    expected_archive_sha = args.expected_archive_sha256.strip().lower()
    archive_hash_pinned_and_matches = bool(
        re.fullmatch(r"[0-9a-f]{64}", expected_archive_sha) and archive_sha == expected_archive_sha
    )

    records, workbook_stats = load_workbooks(dataset_dir)
    before_dedup_count = len(records)
    records, dedup_stats = deduplicate_external_records(records)
    exact_training_hashes, lsh_index, training_index_count, training_stats = build_training_overlap_index(welfake_path)
    records, overlap_stats = remove_training_overlap(records, exact_training_hashes, lsh_index)
    y_fake = np.asarray([r["y_fake"] for r in records], dtype=int)
    if len(records) == 0 or len(set(y_fake.tolist())) != 2:
        raise SystemExit("Independent evaluation must retain both FAKE and REAL full-article samples.")

    scored = [score_runtime(r["text"], artifact) for r in records]
    p_fake = np.asarray([s[0] for s in scored], dtype=float)
    coverage_ratio = np.asarray([(s[2] / s[1]) if s[1] else 0.0 for s in scored], dtype=float)
    candidate_term_count = np.asarray([s[1] for s in scored], dtype=int)
    texts = [r["text"] for r in records]
    for record, score in zip(records, scored):
        record["p_fake"] = float(score[0])

    raw_metrics = compute_metrics(y_fake, p_fake)
    safety_policy = artifact.get("training_contract", {}).get("candidate_safety_policy", {})
    safety_policy_enabled = safety_policy.get("id") == "sensational-conflict-abstention-v1"
    runtime_policy = compute_runtime_policy_metrics(
        y_fake,
        p_fake,
        texts=texts,
        coverage_ratio=coverage_ratio,
        candidate_term_count=candidate_term_count,
        fake_threshold=RUNTIME_FAKE_THRESHOLD,
        real_threshold=RUNTIME_REAL_THRESHOLD,
        sensational_conflict_guard_enabled=safety_policy_enabled,
    )

    gate = {
        "archive_sha256_is_hard_pinned_and_matches": archive_hash_pinned_and_matches,
        "candidate_artifact_hash_matches_manifest": artifact_digest == manifest.get("artifact_sha256"),
        "source_is_distinct_from_candidate_fitting_sources": True,
        "eligible_full_articles_at_least_10000": len(records) >= MIN_GATE_SAMPLES,
        "both_classes_present": len(set(y_fake.tolist())) == 2,
        "raw_balanced_accuracy_at_least_0_70": raw_metrics.get("balanced_accuracy", 0) >= 0.70,
        "raw_fake_recall_at_least_0_70": raw_metrics.get("fake_recall", 0) >= 0.70,
        "raw_real_recall_at_least_0_70": raw_metrics.get("real_recall", 0) >= 0.70,
        "runtime_policy_coverage_at_least_0_50": runtime_policy.get("coverage", 0) >= 0.50,
        "runtime_policy_operational_balanced_accuracy_at_least_0_70": runtime_policy.get("operational_balanced_accuracy_abstentions_count_as_not_correct", 0) >= 0.70,
        "runtime_policy_fake_recall_at_least_0_70": runtime_policy.get("fake_recall_all_fake_samples", 0) >= 0.70,
        "runtime_policy_real_recall_at_least_0_70": runtime_policy.get("real_recall_all_real_samples", 0) >= 0.70,
        "runtime_thresholds_match_frozen_production_policy": (
            artifact.get("thresholds", {}).get("fake_threshold") == RUNTIME_FAKE_THRESHOLD and
            artifact.get("thresholds", {}).get("real_threshold") == RUNTIME_REAL_THRESHOLD
        ),
        "candidate_artifact_remains_non_promotable": (
            manifest.get("production_eligible") is False and manifest.get("promotion_status") == "CANDIDATE_ONLY"
        ),
    }
    report = {
        "schema_version": 1,
        "status": "COMPLETED",
        "task": "Independent full-article fake-vs-real evaluation; not a claim-verification benchmark.",
        "dataset": {
            "name": DATASET_NAME,
            "doi": DATASET_DOI,
            "version": DATASET_VERSION,
            "license": DATASET_LICENSE,
            "declared_article_count": DATASET_DECLARED_ROWS,
            "archive_sha256": archive_sha,
            "expected_archive_sha256": expected_archive_sha or None,
            "archive_hash_pinned_and_matches": archive_hash_pinned_and_matches,
            "archive_bytes": archive.stat().st_size,
            "workbooks": workbook_stats,
            "class_label_rule": "Fake.xlsx => FAKE (1); Real.xlsx => REAL (0); explicit textual labels, when present, must agree.",
            "body_rule": "English-translated full article text is preferred; unqualified original text is accepted only when every non-empty language value is English.",
        },
        "candidate": {
            "model_version": artifact.get("model_version"),
            "artifact_sha256": artifact_digest,
            "training_contract": artifact.get("training_contract"),
            "source_dataset_fingerprint": manifest.get("dataset_fingerprint"),
        },
        "sample_flow": {
            "eligible_rows_before_deduplication": before_dedup_count,
            "after_exact_and_near_duplicate_deduplication": before_dedup_count
                - dedup_stats.get("same_label_exact_duplicate_rows_removed", 0)
                - dedup_stats.get("conflicting_label_exact_duplicate_rows_removed", 0)
                - dedup_stats.get("near_duplicate_external_rows_removed", 0)
                - dedup_stats.get("conflicting_label_near_duplicate_rows_removed", 0),
            "final_eligible_samples": len(records),
            "fake_samples": int(y_fake.sum()),
            "real_samples": int(len(y_fake) - y_fake.sum()),
        },
        "deduplication_and_overlap": {
            **dedup_stats,
            **overlap_stats,
            "training_overlap_audit": training_stats,
            "training_lsh_index_entries": training_index_count,
            "normalized_exact_text_hash": "TruthLens candidate runtime cleaner; SHA-256",
            "near_duplicate_method": "Phase 2 datasketch MinHash/LSH, 5-word shingles, 128 permutations, Jaccard threshold 0.70",
        },
        "metrics_at_probability_threshold_0_50_diagnostic_only": raw_metrics,
        "frozen_runtime_decision_policy": runtime_policy,
        "language_subgroups_at_probability_threshold_0_50_diagnostic_only": subgroup_metrics(records),
        "release_gate": {"passed": all(gate.values()), "checks": gate},
        "limits": [
            "This is a separate dataset/corpus, not proof of performance on every current news domain.",
            "The dataset label methodology is source- and publisher-informed; treat results as external dataset performance, not universal truth accuracy.",
            "WELFake has been examined across prior research iterations; no score from its exposed holdout is used in this release gate.",
            "The archive must be pinned to a reviewed, immutable SHA-256 before this report can pass.",
        ],
    }
    output_path = candidate_dir / "article_independent_validation.json"
    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "report_path": str(output_path),
        "candidate_model_version": artifact.get("model_version"),
        "archive_sha256": archive_sha,
        "archive_hash_pinned_and_matches": archive_hash_pinned_and_matches,
        "eligible_samples": len(records),
        "raw_metrics": raw_metrics,
        "runtime_policy": runtime_policy,
        "release_gate": report["release_gate"],
        "language_subgroup_count": len(report["language_subgroups_at_probability_threshold_0_50_diagnostic_only"]),
        "report_sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
    }, indent=2))
    if not all(gate.values()):
        print("BLOCKED: independent full-article release gate failed; keep this candidate research-only. The final enforcement step will fail closed.")


if __name__ == "__main__":
    main()
