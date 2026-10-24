#!/usr/bin/env python3
"""Unit tests for the sealed Open-Web holdout contract."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_open_web_holdout import HoldoutValidationError, _ensure_output_path_separate, validate_holdout


class OpenWebHoldoutValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.records_path = self.root / "holdout.jsonl"
        self.manifest_path = self.root / "manifest.json"
        self.records = [self.make_record(index) for index in range(100)]
        self.write_bundle()

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def make_record(index):
        timestamp = "2026-01-03T12:00:00Z"
        label = "SUPPORTS"
        return {
            "claim_id": f"OWH-{index:04d}",
            "claim_text": f"Distinct test claim number {index} states a separately testable public fact.",
            "claim_date": "2026-01-01",
            "collected_at": timestamp,
            "syndication_cluster_id": f"cluster-{index:04d}",
            "sources": [
                {
                    "source_id": f"source-{index}-a",
                    "url": f"https://publisher-a{index}.example.org/article",
                    "publisher_group_id": f"publisher-a{index}",
                    "published_at": timestamp,
                    "retrieved_at": timestamp,
                    "content_sha256": hashlib.sha256(f"source-a-{index}".encode()).hexdigest(),
                    "snapshot_ref": f"https://archive.example.org/a/{index}",
                    "evidence_role": "supports",
                    "evidence_excerpt": "A documented passage longer than twenty characters supports the claim.",
                },
                {
                    "source_id": f"source-{index}-b",
                    "url": f"https://publisher-b{index}.example.net/article",
                    "publisher_group_id": f"publisher-b{index}",
                    "published_at": timestamp,
                    "retrieved_at": timestamp,
                    "content_sha256": hashlib.sha256(f"source-b-{index}".encode()).hexdigest(),
                    "snapshot_ref": f"https://archive.example.net/b/{index}",
                    "evidence_role": "context",
                    "evidence_excerpt": "A separate documented passage longer than twenty characters provides context.",
                },
            ],
            "annotations": [
                {
                    "annotator_id": "annotator-1",
                    "annotator_type": "human",
                    "blind_to_model_output": True,
                    "label": label,
                    "rationale": "The cited evidence independently supports this test claim.",
                    "annotated_at": "2026-01-04T12:00:00Z",
                    "attestation_ref": "private-attestation-1",
                },
                {
                    "annotator_id": "annotator-2",
                    "annotator_type": "human",
                    "blind_to_model_output": True,
                    "label": label,
                    "rationale": "The separate source record also supports this test claim.",
                    "annotated_at": "2026-01-04T13:00:00Z",
                    "attestation_ref": "private-attestation-2",
                },
            ],
            "adjudication": {
                "adjudicator_id": "adjudicator-1",
                "final_label": label,
                "rationale": "Both independent annotations agree after review of evidence provenance.",
                "adjudicated_at": "2026-01-05T12:00:00Z",
                "disagreement_resolved": False,
            },
            "split": "holdout",
        }

    def write_bundle(self):
        raw = "".join(json.dumps(record, sort_keys=True) + "\n" for record in self.records).encode()
        digest = hashlib.sha256(raw).hexdigest()
        self.records_path.write_bytes(raw)
        self.manifest_path.write_text(json.dumps({
            "schema_version": 1,
            "dataset_id": "truthlens-open-web-claims-v1",
            "task": "open_web_claim_verification",
            "record_count": len(self.records),
            "records_sha256": digest,
            "label_set": sorted(["SUPPORTS", "REFUTES", "INSUFFICIENT_EVIDENCE", "CONFLICTED"]),
            "seal": {
                "status": "SEALED",
                "records_sha256": digest,
                "model_outputs_accessible_before_seal": False,
                "sealed_by": "data-steward-1",
                "sealed_at": "2026-01-06T12:00:00Z",
            },
            "human_review": {
                "status": "VERIFIED",
                "reviewer_id": "reviewer-1",
                "reviewed_at": "2026-01-07T12:00:00Z",
                "provenance_review_ref": "private-provenance-audit-ref",
                "annotation_attestation_refs": ["private-attestation-1", "private-attestation-2"],
                "labeling_protocol_version": "open-web-holdout-v1",
            },
            "evaluation_access": {
                "status": "AUTHORIZED",
                "authorized_by": "release-steward-1",
                "authorized_at": "2026-01-08T12:00:00Z",
                "evaluation_commit_sha": "a" * 40,
                "candidate_artifact_sha256": "b" * 64,
            },
        }, indent=2))

    def validate_current_candidate(self, **kwargs):
        return validate_holdout(
            self.records_path,
            self.manifest_path,
            expected_commit_sha="a" * 40,
            expected_artifact_sha256="b" * 64,
            **kwargs,
        )

    def test_valid_sealed_holdout_passes_structural_contract(self):
        report = self.validate_current_candidate()
        self.assertTrue(report["structural_validation_passed"])
        self.assertEqual(report["record_count"], 100)
        self.assertEqual(report["unique_syndication_clusters"], 100)
        self.assertTrue(report["sealed"])
        self.assertTrue(report["evaluation_access_authorized"])

    def test_under_100_claims_is_rejected(self):
        self.records.pop()
        self.write_bundle()
        with self.assertRaisesRegex(HoldoutValidationError, "at least 100"):
            self.validate_current_candidate()

    def test_mutated_holdout_bytes_fail_hash_check(self):
        raw = self.records_path.read_bytes()
        self.records_path.write_bytes(raw.replace(b"Distinct test claim number 0", b"Changed test claim number 0", 1))
        with self.assertRaisesRegex(HoldoutValidationError, "SHA-256"):
            self.validate_current_candidate()

    def test_two_sources_from_same_publisher_group_are_rejected(self):
        self.records[0]["sources"][1]["publisher_group_id"] = self.records[0]["sources"][0]["publisher_group_id"]
        self.write_bundle()
        with self.assertRaisesRegex(HoldoutValidationError, "different declared publisher groups"):
            self.validate_current_candidate()

    def test_duplicate_syndication_cluster_is_rejected(self):
        self.records[1]["syndication_cluster_id"] = self.records[0]["syndication_cluster_id"]
        self.write_bundle()
        with self.assertRaisesRegex(HoldoutValidationError, "Duplicate syndication cluster"):
            self.validate_current_candidate()

    def test_ai_annotator_is_rejected(self):
        self.records[0]["annotations"][0]["annotator_type"] = "ai"
        self.write_bundle()
        with self.assertRaisesRegex(HoldoutValidationError, "AI-generated labels"):
            self.validate_current_candidate()

    def test_model_output_field_is_rejected(self):
        self.records[0]["annotations"][0]["model_prediction"] = "SUPPORTS"
        self.write_bundle()
        with self.assertRaisesRegex(HoldoutValidationError, "model/prediction fields are forbidden"):
            self.validate_current_candidate()

    def test_unblinded_annotator_is_rejected(self):
        self.records[0]["annotations"][1]["blind_to_model_output"] = False
        self.write_bundle()
        with self.assertRaisesRegex(HoldoutValidationError, "blind to model output"):
            self.validate_current_candidate()

    def test_access_before_sealing_is_rejected(self):
        manifest = json.loads(self.manifest_path.read_text())
        manifest["evaluation_access"]["authorized_at"] = "2026-01-06T11:00:00Z"
        self.manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(HoldoutValidationError, "authorized after sealing"):
            self.validate_current_candidate()

    def test_conflicting_annotations_require_adjudication(self):
        self.records[0]["annotations"][1]["label"] = "REFUTES"
        self.records[0]["adjudication"]["disagreement_resolved"] = False
        self.write_bundle()
        with self.assertRaisesRegex(HoldoutValidationError, "conflicting annotators"):
            self.validate_current_candidate()


    def test_minimum_claim_override_cannot_lower_floor(self):
        with self.assertRaisesRegex(HoldoutValidationError, "--minimum-claims must be at least 100"):
            self.validate_current_candidate(minimum_claims=99)

    def test_unicode_claim_texts_remain_distinct(self):
        self.records[0]["claim_text"] = "中国政府于2026年公布了独立的公共卫生统计数据"
        self.records[1]["claim_text"] = "أعلنت الجهة الحكومية بيانات إحصائية عامة مستقلة"
        self.write_bundle()
        report = self.validate_current_candidate()
        self.assertEqual(report["unique_claim_count"], 100)

    def test_annotation_after_seal_is_rejected(self):
        self.records[0]["annotations"][0]["annotated_at"] = "2026-01-07T00:00:00Z"
        self.write_bundle()
        with self.assertRaisesRegex(HoldoutValidationError, "annotations must be completed before the holdout is sealed"):
            self.validate_current_candidate()

    def test_adjudication_after_seal_is_rejected(self):
        self.records[0]["adjudication"]["adjudicated_at"] = "2026-01-07T12:00:00Z"
        self.write_bundle()
        with self.assertRaisesRegex(HoldoutValidationError, "adjudication must be completed before the holdout is sealed"):
            self.validate_current_candidate()

    def test_manifest_commit_must_match_candidate_being_evaluated(self):
        manifest = json.loads(self.manifest_path.read_text())
        manifest["evaluation_access"]["evaluation_commit_sha"] = "c" * 40
        self.manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(HoldoutValidationError, "does not match the expected candidate commit SHA"):
            self.validate_current_candidate()

    def test_manifest_artifact_must_match_candidate_being_evaluated(self):
        manifest = json.loads(self.manifest_path.read_text())
        manifest["evaluation_access"]["candidate_artifact_sha256"] = "c" * 64
        self.manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(HoldoutValidationError, "does not match the expected candidate artifact SHA-256"):
            self.validate_current_candidate()

    def test_provenance_reviewer_must_differ_from_adjudicator(self):
        manifest = json.loads(self.manifest_path.read_text())
        manifest["human_review"]["reviewer_id"] = "adjudicator-1"
        self.manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(HoldoutValidationError, "not an annotator, adjudicator, or sealer"):
            self.validate_current_candidate()

    def test_duplicate_json_keys_in_records_are_rejected(self):
        lines = self.records_path.read_text().splitlines()
        lines[0] = lines[0].replace('"split": "holdout"', '"split": "holdout", "split": "holdout"', 1)
        self.records_path.write_text("\n".join(lines) + "\n")
        with self.assertRaisesRegex(HoldoutValidationError, "duplicate JSON object key: 'split'"):
            self.validate_current_candidate()

    def test_duplicate_json_keys_in_manifest_are_rejected(self):
        raw = self.manifest_path.read_text()
        raw = raw.replace('"schema_version": 1,', '"schema_version": 1,\n  "schema_version": 1,', 1)
        self.manifest_path.write_text(raw)
        with self.assertRaisesRegex(HoldoutValidationError, "duplicate JSON object key: 'schema_version'"):
            self.validate_current_candidate()

    def test_report_output_cannot_overwrite_an_input(self):
        for input_path in (self.records_path, self.manifest_path):
            with self.subTest(input_path=input_path):
                with self.assertRaisesRegex(HoldoutValidationError, "must not overwrite"):
                    _ensure_output_path_separate(input_path, (self.records_path, self.manifest_path))


if __name__ == "__main__":
    unittest.main(verbosity=2)
