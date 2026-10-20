from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import pandas as pd
import pytest

from scripts.audit_finefake_archive import audit_archive
from scripts.evaluate_finefake_candidate import (
    OFFICIAL_REPOSITORY,
    normalise_finefake_frame,
    normalized_text_hash,
    evaluate_records,
    prepare_finefake_rows,
    validate_dataset_manifest,
)


def long_text(tag: str) -> str:
    words = (f"{tag} report describes public research and evidence across several detailed paragraphs. " * 12).strip()
    return words


def row(text: str, binary: int, fine: int, platform: str = "CNN", topic: str = "health") -> dict:
    return {
        "text": text,
        "label": binary,
        "fine-grained label": fine,
        "platform": platform,
        "topic": topic,
        "date": "2024-01-01",
    }


def test_normalises_documented_finefake_columns():
    frame = normalise_finefake_frame(pd.DataFrame([row(long_text("real"), 1, 0)]))
    assert {"text", "label", "fine_grained_label", "platform", "topic", "date"} <= set(frame.columns)


def test_only_real_and_text_based_fake_are_included_and_mapped_to_runtime_labels():
    real = long_text("real")
    fake = long_text("fake")
    multimodal = long_text("image")
    mismatch = long_text("mismatch")
    frame = pd.DataFrame([
        row(real, 1, 0),
        row(fake, 0, 3),
        row(multimodal, 0, 4),  # image-based fake is not a text-only target
        row(mismatch, 0, 0),    # binary and fine-grained labels disagree
    ])
    records, counts = prepare_finefake_rows(frame, set())
    labels = {record["text"]: record["y_fake"] for record in records}
    assert labels[real] == 0
    assert labels[fake] == 1
    assert multimodal not in labels
    assert mismatch not in labels
    assert counts["other_fine_grained_labels_excluded"] == 1
    assert counts["binary_fine_label_disagreements_excluded"] == 1


def test_exact_overlap_is_removed_before_deduplication():
    text = long_text("overlapping")
    records, counts = prepare_finefake_rows(
        pd.DataFrame([row(text, 1, 0)]),
        {normalized_text_hash(text)},
    )
    assert records == []
    assert counts["exact_text_overlap_rows_removed"] == 1


def test_same_label_duplicates_collapse_and_conflicting_duplicates_are_removed():
    same = long_text("same")
    conflicting = long_text("conflicting")
    frame = pd.DataFrame([
        row(same, 1, 0, "CNN"),
        row(same, 1, 0, "CNN"),
        row(conflicting, 1, 0, "Reuters"),
        row(conflicting, 0, 3, "Reddit"),
    ])
    records, counts = prepare_finefake_rows(frame, set())
    assert [record["text"] for record in records] == [same]
    assert counts["same_label_duplicate_rows_removed"] == 1
    assert counts["conflicting_label_duplicate_groups_removed"] == 1


def test_dataset_manifest_requires_matching_export_hash_and_trusted_conversion(tmp_path: Path):
    csv_path = tmp_path / "finefake_text_only.csv"
    pd.DataFrame([row(long_text("manifest"), 1, 0)]).to_csv(csv_path, index=False)
    data = csv_path.read_bytes()
    manifest_path = tmp_path / "finefake_text_only.csv.manifest.json"
    manifest = {
        "dataset": "FineFake",
        "official_repository": OFFICIAL_REPOSITORY,
        "source_archive_sha256": "a" * 64,
        "csv_sha256": hashlib.sha256(data).hexdigest(),
        "row_count": 1,
        "conversion_method": "trusted_offline_conversion_after_archive_hash_review",
    }
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    parsed = pd.read_csv(csv_path, dtype=str, keep_default_na=False)
    assert validate_dataset_manifest(csv_path, manifest_path, len(parsed))["dataset"] == "FineFake"

    manifest["csv_sha256"] = "b" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="CSV checksum mismatch"):
        validate_dataset_manifest(csv_path, manifest_path, len(parsed))


def test_archive_audit_lists_pickle_member_but_does_not_extract_or_unpickle(tmp_path: Path):
    archive_path = tmp_path / "fakefinefake.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("FineFake.pkl", b"not executed; metadata-only fixture")
        archive.writestr("README.txt", "sample readme")
    report = audit_archive(archive_path)
    assert report["archive_sha256"] == hashlib.sha256(archive_path.read_bytes()).hexdigest()
    assert report["pickle_members_present"] is True
    assert report["verification_status"] == "LOCAL_SHA256_COMPUTED_PROVENANCE_REQUIRES_REVIEW"
    assert {item["name"] for item in report["members_listed_without_extraction"]} == {"FineFake.pkl", "README.txt"}


def test_platform_reports_use_platform_scoped_runtime_metrics():
    real_text = "truthlens " + long_text("actual reporting")
    fake_text = "truthlens " + long_text("fabricated report")
    artifact = {
        "vocabulary": {"truthlens": 0},
        "idf": [1.0],
        "selected_model": {
            "bias": 0.0,
            "weights": [0.0],
            "plattA": 0.0,
            "plattB": 2.0,
        },
    }
    records = [
        {"text": real_text, "y_fake": 0, "platform": "CNN"},
        {"text": real_text + " additional phrase", "y_fake": 0, "platform": "CNN"},
        {"text": fake_text, "y_fake": 1, "platform": "Reddit"},
        {"text": fake_text + " other phrase", "y_fake": 1, "platform": "Reddit"},
    ]
    report = evaluate_records(records, artifact)
    cnn = report["platform_metrics"]["CNN"]
    reddit = report["platform_metrics"]["Reddit"]
    assert cnn["runtime_policy"]["coverage"] == 1.0
    assert cnn["runtime_policy"]["real_recall_all_real_samples"] == 1.0
    assert cnn["runtime_policy"]["fake_recall_all_fake_samples"] == 0.0
    assert reddit["runtime_policy"]["coverage"] == 1.0
    assert reddit["runtime_policy"]["fake_recall_all_fake_samples"] == 0.0
