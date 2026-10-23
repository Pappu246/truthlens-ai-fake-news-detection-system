#!/usr/bin/env python3
"""Validate the integrity and required attestations of a sealed Open-Web holdout.

This checks structure, hashes, ordering, and declared review metadata only. It
cannot prove that an annotator is human or that an attestation is truthful;
a named data steward must verify those items independently before release.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlparse

ALLOWED_LABELS = {"SUPPORTS", "REFUTES", "INSUFFICIENT_EVIDENCE", "CONFLICTED"}
HEX_256 = re.compile(r"^[0-9a-f]{64}$")
HEX_160 = re.compile(r"^[0-9a-f]{40}$")
RECORD_KEYS = {
    "claim_id", "claim_text", "claim_date", "collected_at",
    "syndication_cluster_id", "sources", "annotations", "adjudication", "split",
}
SOURCE_KEYS = {
    "source_id", "url", "publisher_group_id", "published_at", "retrieved_at",
    "content_sha256", "snapshot_ref", "evidence_role", "evidence_excerpt",
}
ANNOTATION_KEYS = {
    "annotator_id", "annotator_type", "blind_to_model_output", "label",
    "rationale", "annotated_at", "attestation_ref",
}
ADJUDICATION_KEYS = {
    "adjudicator_id", "final_label", "rationale", "adjudicated_at",
    "disagreement_resolved",
}
ALLOWED_EVIDENCE_ROLES = {"supports", "refutes", "context"}


class HoldoutValidationError(ValueError):
    """Raised when a purported sealed holdout fails the release contract."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise HoldoutValidationError(message)


def _parse_aware_datetime(value: object, field: str) -> datetime:
    _require(isinstance(value, str) and bool(value.strip()), f"{field} must be an ISO-8601 timestamp.")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise HoldoutValidationError(f"{field} is not a valid ISO-8601 timestamp.") from exc
    _require(parsed.tzinfo is not None and parsed.utcoffset() is not None, f"{field} must include a UTC offset.")
    return parsed


def _parse_date(value: object, field: str) -> date:
    _require(isinstance(value, str) and bool(value.strip()), f"{field} must be YYYY-MM-DD.")
    try:
        parsed = date.fromisoformat(value.strip())
    except ValueError as exc:
        raise HoldoutValidationError(f"{field} must be YYYY-MM-DD.") from exc
    _require(parsed.isoformat() == value.strip(), f"{field} must use canonical YYYY-MM-DD form.")
    return parsed


def _https_url(value: object, field: str) -> tuple[str, str]:
    _require(isinstance(value, str) and bool(value.strip()), f"{field} must be a URL.")
    parsed = urlparse(value.strip())
    _require(
        parsed.scheme == "https" and bool(parsed.hostname) and parsed.username is None and parsed.password is None,
        f"{field} must be an HTTPS URL without embedded credentials.",
    )
    host = parsed.hostname.lower().rstrip(".")
    normalized_host = host[4:] if host.startswith("www.") else host
    _require("." in normalized_host and not normalized_host.startswith("."), f"{field} has no valid public hostname.")
    return value.strip(), normalized_host


def _claim_fingerprint(text: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _load_jsonl(path: Path) -> tuple[list[dict], str]:
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    records = []
    for line_number, raw_line in enumerate(raw.splitlines(), start=1):
        if not raw_line.strip():
            raise HoldoutValidationError(f"Blank JSONL line at line {line_number}; blank lines are not allowed.")
        try:
            item = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise HoldoutValidationError(f"Invalid JSON on line {line_number}: {exc.msg}.") from exc
        _require(isinstance(item, dict), f"Line {line_number} must contain one JSON object.")
        records.append(item)
    return records, digest


def _validate_record(record: dict, line_number: int) -> tuple[str, str, set[str], set[str]]:
    prefix = f"record line {line_number}"
    _require(set(record) == RECORD_KEYS, f"{prefix} has missing or unexpected fields.")
    for key in ("claim_id", "claim_text", "syndication_cluster_id", "split"):
        _require(isinstance(record.get(key), str) and bool(record[key].strip()), f"{prefix}: {key} is required.")
    _require(len(record["claim_text"].strip()) >= 15, f"{prefix}: claim_text is too short to be a meaningful claim.")
    _require(record["split"] == "holdout", f"{prefix}: every record must be assigned to the sealed holdout split.")
    claim_day = _parse_date(record["claim_date"], f"{prefix}.claim_date")
    collected_at = _parse_aware_datetime(record["collected_at"], f"{prefix}.collected_at")
    _require(claim_day <= collected_at.date(), f"{prefix}: claim_date cannot be after collected_at.")

    sources = record["sources"]
    _require(isinstance(sources, list) and len(sources) >= 2, f"{prefix}: at least two evidence sources are required.")
    source_ids, publisher_groups, domains = set(), set(), set()
    for source_index, source in enumerate(sources, start=1):
        label = f"{prefix}.sources[{source_index}]"
        _require(isinstance(source, dict) and set(source) == SOURCE_KEYS, f"{label} has missing or unexpected fields.")
        _require(isinstance(source["source_id"], str) and source["source_id"].strip(), f"{label}.source_id is required.")
        _require(source["source_id"] not in source_ids, f"{prefix}: source_id values must be unique within a claim.")
        source_ids.add(source["source_id"])
        _, domain = _https_url(source["url"], f"{label}.url")
        _https_url(source["snapshot_ref"], f"{label}.snapshot_ref")
        _require(isinstance(source["publisher_group_id"], str) and source["publisher_group_id"].strip(), f"{label}.publisher_group_id is required.")
        group = source["publisher_group_id"].strip()
        _require(group not in publisher_groups, f"{prefix}: evidence sources must come from different declared publisher groups.")
        _require(domain not in domains, f"{prefix}: evidence sources must use different hostnames.")
        publisher_groups.add(group)
        domains.add(domain)
        _parse_aware_datetime(source["published_at"], f"{label}.published_at")
        _parse_aware_datetime(source["retrieved_at"], f"{label}.retrieved_at")
        _require(bool(HEX_256.fullmatch(str(source["content_sha256"]).lower())), f"{label}.content_sha256 must be a SHA-256 digest.")
        _require(source["evidence_role"] in ALLOWED_EVIDENCE_ROLES, f"{label}.evidence_role is invalid.")
        excerpt = source["evidence_excerpt"]
        _require(isinstance(excerpt, str) and 20 <= len(excerpt.strip()) <= 1200, f"{label}.evidence_excerpt must contain 20–1200 characters.")
    _require(len(publisher_groups) >= 2, f"{prefix}: at least two independent publisher groups are required.")

    annotations = record["annotations"]
    _require(isinstance(annotations, list) and len(annotations) == 2, f"{prefix}: exactly two independent blinded human annotations are required.")
    annotator_ids, attestation_refs, annotation_labels = set(), set(), []
    annotation_times = []
    for annotation_index, annotation in enumerate(annotations, start=1):
        label = f"{prefix}.annotations[{annotation_index}]"
        _require(isinstance(annotation, dict) and set(annotation) == ANNOTATION_KEYS, f"{label} has missing or unexpected fields (model/prediction fields are forbidden).")
        annotator = annotation["annotator_id"]
        _require(isinstance(annotator, str) and annotator.strip(), f"{label}.annotator_id is required.")
        _require(annotator not in annotator_ids, f"{prefix}: annotators must be distinct.")
        annotator_ids.add(annotator)
        _require(annotation["annotator_type"] == "human", f"{label}: AI-generated labels are not accepted as gold annotations.")
        _require(annotation["blind_to_model_output"] is True, f"{label}: annotator must attest they were blind to model output.")
        _require(annotation["label"] in ALLOWED_LABELS, f"{label}.label is invalid.")
        _require(isinstance(annotation["rationale"], str) and len(annotation["rationale"].strip()) >= 20, f"{label}.rationale is too short.")
        annotated_at = _parse_aware_datetime(annotation["annotated_at"], f"{label}.annotated_at")
        annotation_times.append(annotated_at)
        attestation = annotation["attestation_ref"]
        _require(isinstance(attestation, str) and attestation.strip(), f"{label}.attestation_ref must refer to a separately retained signed human attestation.")
        attestation_refs.add(attestation.strip())
        annotation_labels.append(annotation["label"])
    _require(len(attestation_refs) == 2, f"{prefix}: each annotator needs a distinct attestation reference.")

    adjudication = record["adjudication"]
    _require(isinstance(adjudication, dict) and set(adjudication) == ADJUDICATION_KEYS, f"{prefix}.adjudication has missing or unexpected fields.")
    adjudicator = adjudication["adjudicator_id"]
    _require(isinstance(adjudicator, str) and adjudicator.strip() and adjudicator not in annotator_ids, f"{prefix}: adjudicator must be identified separately from both annotators.")
    _require(adjudication["final_label"] in ALLOWED_LABELS, f"{prefix}.adjudication.final_label is invalid.")
    _require(isinstance(adjudication["rationale"], str) and len(adjudication["rationale"].strip()) >= 20, f"{prefix}.adjudication.rationale is too short.")
    adjudicated_at = _parse_aware_datetime(adjudication["adjudicated_at"], f"{prefix}.adjudication.adjudicated_at")
    _require(all(adjudicated_at >= when for when in annotation_times), f"{prefix}: adjudication cannot precede the two independent annotations.")
    _require(isinstance(adjudication["disagreement_resolved"], bool), f"{prefix}.adjudication.disagreement_resolved must be boolean.")
    if annotation_labels[0] != annotation_labels[1]:
        _require(adjudication["disagreement_resolved"] is True, f"{prefix}: conflicting annotators require explicit adjudication.")
    elif adjudication["final_label"] != annotation_labels[0]:
        _require(adjudication["disagreement_resolved"] is True, f"{prefix}: an adjudicated label differing from unanimous annotation requires an explanation.")
    fingerprint = _claim_fingerprint(record["claim_text"])
    return record["claim_id"], record["syndication_cluster_id"], annotator_ids, attestation_refs | {fingerprint}


def validate_holdout(records_path: Path, manifest_path: Path, minimum_claims: int = 100) -> dict:
    """Validate a sealed holdout and return aggregate-only validation evidence."""
    _require(records_path.is_file(), f"Holdout records file not found: {records_path}")
    _require(manifest_path.is_file(), f"Holdout manifest not found: {manifest_path}")
    records, records_sha256 = _load_jsonl(records_path)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HoldoutValidationError(f"Invalid manifest JSON: {exc.msg}.") from exc
    _require(isinstance(manifest, dict), "Manifest must be a JSON object.")
    _require(manifest.get("schema_version") == 1, "Unsupported manifest schema_version.")
    _require(manifest.get("dataset_id") == "truthlens-open-web-claims-v1", "Unexpected dataset_id.")
    _require(manifest.get("task") == "open_web_claim_verification", "Manifest task must be open_web_claim_verification.")
    _require(len(records) >= minimum_claims, f"Holdout has {len(records)} records; at least {minimum_claims} are required.")
    _require(manifest.get("record_count") == len(records), "Manifest record_count does not match JSONL rows.")
    _require(bool(HEX_256.fullmatch(str(manifest.get("records_sha256", "")).lower())), "Manifest records_sha256 is missing or malformed.")
    _require(records_sha256 == manifest["records_sha256"].lower(), "Holdout JSONL SHA-256 does not match the manifest.")
    _require(manifest.get("label_set") == sorted(ALLOWED_LABELS), "Manifest label_set does not match the frozen label contract.")

    seal = manifest.get("seal")
    _require(isinstance(seal, dict), "Manifest seal object is required.")
    _require(seal.get("status") == "SEALED", "Holdout must be sealed before evaluation.")
    _require(seal.get("records_sha256") == records_sha256, "Seal digest does not match holdout bytes.")
    _require(seal.get("model_outputs_accessible_before_seal") is False, "Model outputs must not be accessible before the holdout is sealed.")
    _require(isinstance(seal.get("sealed_by"), str) and seal["sealed_by"].strip(), "seal.sealed_by is required.")
    sealed_at = _parse_aware_datetime(seal.get("sealed_at"), "seal.sealed_at")

    seen_ids, seen_clusters, seen_claims, all_annotators, all_attestations = set(), set(), set(), set(), set()
    for line_number, record in enumerate(records, start=1):
        claim_id, cluster_id, annotators, attestation_and_fingerprint = _validate_record(record, line_number)
        _require(claim_id not in seen_ids, f"Duplicate claim_id: {claim_id}.")
        _require(cluster_id not in seen_clusters, f"Duplicate syndication cluster in holdout: {cluster_id}.")
        fingerprint = next((value for value in attestation_and_fingerprint if value not in {a["attestation_ref"] for a in record["annotations"]}), None)
        _require(fingerprint is not None and fingerprint not in seen_claims, f"Duplicate/near-identical claim text at line {line_number}.")
        seen_ids.add(claim_id)
        seen_clusters.add(cluster_id)
        seen_claims.add(fingerprint)
        all_annotators.update(annotators)
        all_attestations.update(a["attestation_ref"] for a in record["annotations"])

    human_review = manifest.get("human_review")
    _require(isinstance(human_review, dict), "Manifest human_review object is required.")
    _require(human_review.get("status") == "VERIFIED", "An independent human data-steward review is required.")
    reviewer = human_review.get("reviewer_id")
    _require(isinstance(reviewer, str) and reviewer.strip() and reviewer not in all_annotators, "Human review must be signed off by a separate reviewer.")
    reviewed_at = _parse_aware_datetime(human_review.get("reviewed_at"), "human_review.reviewed_at")
    _require(reviewed_at >= sealed_at, "Human review must occur after the holdout is sealed.")
    _require(isinstance(human_review.get("provenance_review_ref"), str) and human_review["provenance_review_ref"].strip(), "Human review must reference its provenance audit.")
    manifest_attestations = human_review.get("annotation_attestation_refs")
    _require(isinstance(manifest_attestations, list) and set(manifest_attestations) == all_attestations, "Manifest must enumerate every unique annotation attestation reference.")
    _require(isinstance(human_review.get("labeling_protocol_version"), str) and human_review["labeling_protocol_version"].strip(), "Human labeling protocol version is required.")

    access = manifest.get("evaluation_access")
    _require(isinstance(access, dict), "Manifest evaluation_access object is required.")
    _require(access.get("status") == "AUTHORIZED", "Evaluation access must be explicitly authorized after sealing and human review.")
    _require(isinstance(access.get("authorized_by"), str) and access["authorized_by"].strip(), "evaluation_access.authorized_by is required.")
    authorized_at = _parse_aware_datetime(access.get("authorized_at"), "evaluation_access.authorized_at")
    _require(authorized_at >= reviewed_at and authorized_at > sealed_at, "Evaluation access must be authorized after sealing and human review.")
    _require(bool(HEX_160.fullmatch(str(access.get("evaluation_commit_sha", "")).lower())), "evaluation_access.evaluation_commit_sha must be a pinned 40-character commit SHA.")
    _require(bool(HEX_256.fullmatch(str(access.get("candidate_artifact_sha256", "")).lower())), "evaluation_access.candidate_artifact_sha256 must be a pinned SHA-256.")

    return {
        "schema_version": 1,
        "dataset_id": manifest["dataset_id"],
        "task": manifest["task"],
        "record_count": len(records),
        "unique_claim_count": len(seen_claims),
        "unique_syndication_clusters": len(seen_clusters),
        "distinct_annotator_ids": len(all_annotators),
        "annotation_attestation_refs": len(all_attestations),
        "records_sha256": records_sha256,
        "sealed": True,
        "human_review_declared_verified": True,
        "evaluation_access_authorized": True,
        "evaluation_commit_sha": access["evaluation_commit_sha"],
        "candidate_artifact_sha256": access["candidate_artifact_sha256"],
        "structural_validation_passed": True,
        "interpretation": (
            "Structural integrity and required review attestations passed. This tool cannot independently "
            "prove that annotators are human, attestations are truthful, or publisher groups are independent; "
            "those require a separate human audit."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--records", required=True, type=Path, help="Restricted JSONL holdout; do not commit private claims/evidence to public Git.")
    parser.add_argument("--manifest", required=True, type=Path, help="Signed-off holdout manifest.")
    parser.add_argument("--minimum-claims", type=int, default=100)
    parser.add_argument("--output", type=Path, help="Optional aggregate-only JSON report path.")
    args = parser.parse_args()
    try:
        report = validate_holdout(args.records, args.manifest, minimum_claims=args.minimum_claims)
    except (HoldoutValidationError, OSError) as exc:
        print(json.dumps({"structural_validation_passed": False, "error": str(exc)}, indent=2), file=sys.stderr)
        return 1
    output = json.dumps(report, indent=2)
    print(output)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
