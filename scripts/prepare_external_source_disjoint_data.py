#!/usr/bin/env python3
"""Prepare a publisher-disjoint external article evaluation set."""
from __future__ import annotations
import argparse, csv, hashlib, io, json, re, sys, zipfile
from collections import defaultdict
from pathlib import Path
from publicsuffix2 import get_sld

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from datasketch import MinHash, MinHashLSH
from train_polyglot_source_heldout_candidate import load_records, normalize_domain

EXPECTED_EXTERNAL_MD5 = "64b4e8888f95ec104611de9d01ffe903"
TEXT_ALIASES = {"articletext", "fulltext", "fullarticle", "articlebody", "body", "content", "text", "newscontent", "articlecontent"}
TITLE_ALIASES = {"title", "headline", "newstitle", "articletitle", "newsheadline"}
SOURCE_ALIASES = {"url", "articleurl", "sourceurl", "domain", "sourcedomain", "publisher", "source", "outlet", "website", "site", "host", "media"}
LABEL_ALIASES = {"label", "veracity", "truthlabel", "truelabel", "truthfulness", "fakenewslabel", "factuality", "isfake", "isreal", "istrue", "fake", "fakeflag", "realflag", "class", "reliability", "credibility"}
FAKE_LABELS = {"fake", "fake news", "false", "misinformation", "disinformation", "false news", "not true", "untrue", "noncredible", "non credible", "hoax"}
REAL_LABELS = {"real", "real news", "true", "true news", "truthful", "factual", "credible", "reliable", "legitimate", "authentic", "not fake", "non fake", "non-fake"}

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def norm_header(value) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())

def normalize_label_value(value):
    normalized = re.sub(r"[^a-z0-9]+", " ", str(value or "").strip().lower()).strip()
    # Diagnostics contain normalized categorical labels only, never article text.
    return normalized[:80] if normalized else "<blank>"


def map_binary_label(value, column=None):
    """Map documented label strings, respecting explicit boolean-field semantics."""
    normalized = normalize_label_value(value)
    field = norm_header(column or "")

    # Boolean-like values are only interpreted when the field name makes the
    # polarity explicit. Generic 0/1 values remain ambiguous and are rejected.
    if field in {"isfake", "fake", "fakeflag", "isfakenews"}:
        if normalized in {"true", "yes", "1"}:
            return "FAKE"
        if normalized in {"false", "no", "0"}:
            return "REAL"
    if field in {"isreal", "istrue", "realflag", "istruenews", "istruthful"}:
        if normalized in {"true", "yes", "1"}:
            return "REAL"
        if normalized in {"false", "no", "0"}:
            return "FAKE"

    if normalized in FAKE_LABELS:
        return "FAKE"
    if normalized in REAL_LABELS:
        return "REAL"
    return None

def article_text_fingerprint(text: str) -> str:
    normalized = re.sub(r"\s+", " ", text or "").strip().casefold()
    return sha(normalized.encode("utf-8"))

def domain_fingerprint(value):
    canonical = normalize_domain(value)
    return sha(canonical.encode("utf-8")) if canonical else None

def word_shingles(text: str):
    normalized = re.sub(r"[^a-z0-9\s]", " ", str(text or "").casefold())
    words = re.sub(r"\s+", " ", normalized).strip().split()
    if len(words) < 5:
        material = " ".join(words)
        return {int.from_bytes(hashlib.blake2b(material.encode("utf-8"), digest_size=8).digest(), "big")} if material else set()
    return {
        int.from_bytes(hashlib.blake2b(" ".join(words[i:i + 5]).encode("utf-8"), digest_size=8).digest(), "big")
        for i in range(len(words) - 4)
    }

def make_minhash(shingles):
    signature = MinHash(num_perm=128)
    for item in shingles:
        signature.update(item.to_bytes(8, "big"))
    return signature

def exact_jaccard(left, right):
    if not left and not right:
        return 1.0
    union = len(left | right)
    return len(left & right) / union if union else 0.0

def filter_near_duplicates_direct(candidate_records, external_records):
    """Filter by direct, exact Jaccard matches, avoiding transitive LSH components."""
    lsh = MinHashLSH(threshold=0.70, num_perm=128)
    shingle_cache = {}
    candidate_ids = set()
    accepted = {}
    conflicted = set()
    external_near_duplicates_removed = 0
    cross_corpus_removed = 0
    conflicting_near_duplicates_removed = 0

    for record in candidate_records:
        record_id = "polyglot-" + str(record["id"])
        shingles = word_shingles(record["text"])
        if not shingles:
            continue
        lsh.insert(record_id, make_minhash(shingles))
        shingle_cache[record_id] = shingles
        candidate_ids.add(record_id)

    for record in sorted(external_records, key=lambda item: item["text_hash"]):
        record_id = record["_id"]
        shingles = word_shingles(record["text"])
        if not shingles:
            continue
        signature = make_minhash(shingles)
        neighbors = lsh.query(signature)
        exact_matches = [
            neighbor for neighbor in neighbors
            if neighbor in shingle_cache and exact_jaccard(shingles, shingle_cache[neighbor]) >= 0.70
        ]

        if any(neighbor in candidate_ids for neighbor in exact_matches):
            cross_corpus_removed += 1
            continue

        conflict_matches = [neighbor for neighbor in exact_matches if neighbor in conflicted]
        if conflict_matches:
            conflicted.add(record_id)
            shingle_cache[record_id] = shingles
            lsh.insert(record_id, signature)
            conflicting_near_duplicates_removed += 1
            continue

        external_matches = [neighbor for neighbor in exact_matches if neighbor in accepted]
        if any(accepted[neighbor]["y"] != record["y"] for neighbor in external_matches):
            for neighbor in external_matches:
                accepted.pop(neighbor, None)
                conflicted.add(neighbor)
            conflicted.add(record_id)
            shingle_cache[record_id] = shingles
            lsh.insert(record_id, signature)
            conflicting_near_duplicates_removed += len(external_matches) + 1
            continue

        if external_matches:
            # A direct same-label duplicate of an already-retained representative
            # is removed; similarity chains alone do not collapse unrelated endpoints.
            external_near_duplicates_removed += 1
            continue

        accepted[record_id] = record
        shingle_cache[record_id] = shingles
        lsh.insert(record_id, signature)

    return sorted(accepted.values(), key=lambda item: item["text_hash"]), {
        "cross_corpus_near_duplicate_articles_removed": cross_corpus_removed,
        "external_near_duplicate_articles_removed": external_near_duplicates_removed,
        "conflicting_near_duplicate_articles_removed": conflicting_near_duplicates_removed,
    }

def classify_columns(headers):
    body_columns = [h for h in headers if norm_header(h) in TEXT_ALIASES]
    if not body_columns:
        body_columns = [
            h for h in headers
            if any(term in norm_header(h) for term in ("articletext", "articlebody", "fulltext", "articlecontent", "newscontent"))
        ]
    title_columns = [h for h in headers if norm_header(h) in TITLE_ALIASES]
    source_columns = [
        h for h in headers
        if norm_header(h) in SOURCE_ALIASES
        or any(term in norm_header(h) for term in ("sourceurl", "sourcedomain", "publisherdomain", "websiteurl"))
    ]
    label_columns = [
        h for h in headers
        if norm_header(h) in LABEL_ALIASES
        or any(term in norm_header(h) for term in ("truthlabel", "truelabel", "veracitylabel", "fakelabel"))
    ]
    return body_columns, title_columns, source_columns, label_columns


def schema_signature(headers, body_columns, title_columns, source_columns, label_columns):
    # Group only structurally compatible files. One authoritative field is
    # selected across a group; distinct columns are never combined.
    return json.dumps({
        "headers": sorted(norm_header(h) for h in headers),
        "body_columns": sorted(norm_header(h) for h in body_columns),
        "title_columns": sorted(norm_header(h) for h in title_columns),
        "source_columns": sorted(norm_header(h) for h in source_columns),
        "label_columns": sorted(norm_header(h) for h in label_columns),
    }, sort_keys=True, separators=(",", ":"))


def get_eligible_article_fields(row, body_columns, title_columns, source_columns):
    body = next(
        (str(row.get(column) or "").strip() for column in body_columns if str(row.get(column) or "").strip()),
        "",
    )
    title = next(
        (str(row.get(column) or "").strip() for column in title_columns if str(row.get(column) or "").strip()),
        "",
    )
    text = re.sub(r"\s+", " ", (title + " " + body).strip())
    if len(text) < 300 or len(text.split()) < 50:
        return text, set(), False
    sources = {fp for column in source_columns if (fp := domain_fingerprint(row.get(column)))}
    return text, sources, True


def iter_archive_delimited_files(archive_path: Path):
    """Yield CSV/TSV streams, including members inside nested ZIP files."""
    with zipfile.ZipFile(archive_path) as outer:
        for info in outer.infolist():
            if info.is_dir():
                continue
            suffix = Path(info.filename).suffix.lower()
            if suffix in {".csv", ".tsv"}:
                with outer.open(info, "r") as stream:
                    yield info.filename, "," if suffix == ".csv" else "\t", stream
            elif suffix == ".zip":
                with outer.open(info, "r") as source:
                    nested_bytes = source.read()
                with zipfile.ZipFile(io.BytesIO(nested_bytes)) as inner:
                    for nested in inner.infolist():
                        nested_suffix = Path(nested.filename).suffix.lower()
                        if nested.is_dir() or nested_suffix not in {".csv", ".tsv"}:
                            continue
                        with inner.open(nested, "r") as stream:
                            yield info.filename + "!" + nested.filename, "," if nested_suffix == ".csv" else "\t", stream


def scan_external_archive(archive_path: Path):
    """
    Two-pass scan: infer one label field per compatible header schema, then ingest
    rows using only that field. Class-partitioned files can be combined only when
    their schemas match and a single field carries both explicit binary labels.
    """
    csv.field_size_limit(50 * 1024 * 1024)
    unique = {}
    counters = defaultdict(int)
    group_stats = {}
    file_stats = {}
    files_scanned = 0

    # Pass 1: establish label distributions across compatible schemas.
    for source_name, delimiter, stream in iter_archive_delimited_files(archive_path):
        files_scanned += 1
        reader = csv.DictReader(
            io.TextIOWrapper(stream, encoding="utf-8-sig", errors="replace", newline=""),
            delimiter=delimiter,
        )
        headers = reader.fieldnames or []
        body_columns, title_columns, source_columns, label_columns = classify_columns(headers)
        stats = {
            "file": source_name,
            "rows_scanned": 0,
            "full_text_rows": 0,
            "full_text_with_source_rows": 0,
            "source_schema_sha256": None,
            "candidate_label_columns": {},
            "selected_label_column": None,
            "selected_label_counts": {"FAKE": 0, "REAL": 0},
            "selection_reason": None,
        }

        if not body_columns or not source_columns or not label_columns:
            for _ in reader:
                stats["rows_scanned"] += 1
            counters["rows_scanned"] += stats["rows_scanned"]
            counters["files_missing_required_headers"] += 1
            stats["selection_reason"] = "required article-text, source, or explicit label headers are missing"
            file_stats[source_name] = stats
            continue

        signature = schema_signature(headers, body_columns, title_columns, source_columns, label_columns)
        stats["source_schema_sha256"] = sha(signature.encode("utf-8"))
        group_label_stats = group_stats.setdefault(signature, {})
        for column in label_columns:
            group_label_stats.setdefault(column, {"fake": 0, "real": 0, "unmapped": 0, "values": {}})

        for row in reader:
            stats["rows_scanned"] += 1
            text, sources, full_text = get_eligible_article_fields(row, body_columns, title_columns, source_columns)
            if not full_text:
                continue
            stats["full_text_rows"] += 1
            counters["full_text_rows"] += 1
            if not sources:
                continue
            stats["full_text_with_source_rows"] += 1
            counters["full_text_with_source_rows"] += 1
            for column in label_columns:
                label = map_binary_label(row.get(column), column)
                counts = group_label_stats[column]
                raw_category = normalize_label_value(row.get(column))
                category_counts = counts["values"]
                category_counts[raw_category] = category_counts.get(raw_category, 0) + 1
                if label == "FAKE":
                    counts["fake"] += 1
                elif label == "REAL":
                    counts["real"] += 1
                else:
                    counts["unmapped"] += 1
        counters["rows_scanned"] += stats["rows_scanned"]
        file_stats[source_name] = stats

    label_priority = (
        "class", "truthlabel", "truelabel", "veracity", "truthfulness", "fakenewslabel",
        "factuality", "isfake", "label", "reliability", "credibility"
    )
    selected_by_schema = {}
    group_diagnostics = {}
    for signature, candidate_stats in group_stats.items():
        viable = [
            column for column, counts in candidate_stats.items()
            if counts["fake"] > 0 and counts["real"] > 0
        ]

        def priority(column):
            try:
                return label_priority.index(norm_header(column))
            except ValueError:
                return len(label_priority)

        selected = sorted(
            viable,
            key=lambda column: (
                priority(column),
                -candidate_stats[column]["fake"] - candidate_stats[column]["real"],
                column.lower(),
            ),
        )[0] if viable else None
        selected_by_schema[signature] = selected
        bounded_candidate_stats = {}
        for column, counts in candidate_stats.items():
            values = counts.get("values", {})
            top_values = sorted(values.items(), key=lambda item: (-item[1], item[0]))[:30]
            bounded_candidate_stats[column] = {
                **{key: value for key, value in counts.items() if key != "values"},
                "normalized_value_counts_top30": dict(top_values),
                "distinct_normalized_value_count": len(values),
            }
        group_diagnostics[signature] = {
            "schema_sha256": sha(signature.encode("utf-8")),
            "candidate_label_columns": bounded_candidate_stats,
            "selected_label_column": selected,
            "selection_reason": (
                "selected one explicit label field with both binary classes across this compatible schema group"
                if selected is not None
                else "no single label field in this compatible schema group contains both binary classes; rows excluded rather than mixing fields"
            ),
        }

    # Pass 2: ingest using the one selected field for each schema group.
    for source_name, delimiter, stream in iter_archive_delimited_files(archive_path):
        stats = file_stats.get(source_name)
        if not stats or not stats.get("source_schema_sha256"):
            continue
        reader = csv.DictReader(
            io.TextIOWrapper(stream, encoding="utf-8-sig", errors="replace", newline=""),
            delimiter=delimiter,
        )
        headers = reader.fieldnames or []
        body_columns, title_columns, source_columns, label_columns = classify_columns(headers)
        signature = schema_signature(headers, body_columns, title_columns, source_columns, label_columns)
        selected_label_column = selected_by_schema.get(signature)
        group_diag = group_diagnostics.get(signature, {})
        stats["selected_label_column"] = selected_label_column
        stats["candidate_label_columns"] = group_diag.get("candidate_label_columns", {})
        stats["selection_reason"] = group_diag.get("selection_reason")

        if selected_label_column is None:
            if stats["full_text_with_source_rows"]:
                counters["files_without_mixed_label_column"] += 1
                counters["rows_excluded_without_single_mixed_label_field"] += stats["full_text_with_source_rows"]
            continue

        for row in reader:
            text, sources, full_text = get_eligible_article_fields(row, body_columns, title_columns, source_columns)
            if not full_text or not sources:
                continue
            label = map_binary_label(row.get(selected_label_column), selected_label_column)
            if label is None:
                counters["rows_unmapped_on_selected_label_field"] += 1
                continue
            stats["selected_label_counts"][label] += 1
            counters["full_text_with_explicit_label_and_source"] += 1
            fingerprint = article_text_fingerprint(text)
            article = unique.setdefault(
                fingerprint,
                {"text": text, "labels": set(), "source_fingerprints": set()},
            )
            article["labels"].add(label)
            article["source_fingerprints"].update(sources)
            article["text"] = min(article["text"], text)

    diagnostics = [
        {**stats, "source_schema_sha256": stats.get("source_schema_sha256")}
        for _, stats in sorted(file_stats.items())
    ]
    counters["compatible_schema_group_count"] = len(group_stats)
    counters["schema_groups_without_single_mixed_label_field"] = sum(
        selected is None for selected in selected_by_schema.values()
    )
    counters["source_file_label_diagnostics"] = diagnostics
    counters["label_schema_group_diagnostics"] = list(group_diagnostics.values())
    return unique, dict(counters), files_scanned


def write_jsonl(path: Path, records):
    with path.open("w", encoding="utf-8", newline="\n") as output:
        for record in records:
            output.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--external-archive", required=True)
    parser.add_argument("--candidate-dataset-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    archive = Path(args.external_archive)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    md5, archive_sha = hashlib.md5(), hashlib.sha256()
    with archive.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            md5.update(chunk)
            archive_sha.update(chunk)
    if md5.hexdigest() != EXPECTED_EXTERNAL_MD5:
        raise SystemExit(f"External archive MD5 mismatch: {md5.hexdigest()}")

    unique, scan_counts, files_scanned = scan_external_archive(archive)
    source_file_label_diagnostics = scan_counts.pop("source_file_label_diagnostics", [])
    eligible, conflicting_label_articles = [], 0
    for fingerprint, article in sorted(unique.items()):
        if len(article["labels"]) != 1:
            conflicting_label_articles += 1
            continue
        if not article["source_fingerprints"]:
            continue
        label = next(iter(article["labels"]))
        eligible.append({
            "_id": "external-" + fingerprint,
            "text_hash": fingerprint,
            "text": article["text"],
            "y": 1 if label == "FAKE" else 0,
            "label": label,
            "source_fingerprints": sorted(article["source_fingerprints"]),
        })
    eligible_label_counts = {
        "FAKE": sum(record["y"] == 1 for record in eligible),
        "REAL": sum(record["y"] == 0 for record in eligible),
    }

    external_publishers = sorted({fp for record in eligible for fp in record["source_fingerprints"]})
    fingerprint_set_sha = sha(json.dumps(external_publishers, separators=(",", ":")).encode("utf-8"))
    exclusion_payload = {
        "schema_version": 1,
        "source_archive_sha256": archive_sha.hexdigest(),
        "source_archive_md5": md5.hexdigest(),
        "publisher_fingerprint_algorithm": "SHA-256 of canonical registrable domain UTF-8; equality fingerprints are not anonymization",
        "publisher_fingerprint_count": len(external_publishers),
        "publisher_fingerprint_set_sha256": fingerprint_set_sha,
        "publisher_domain_fingerprints": external_publishers,
    }
    exclusion_path = output_dir / "external-publisher-fingerprints.json"
    exclusion_path.write_text(json.dumps(exclusion_payload, indent=2) + "\n", encoding="utf-8")

    candidate_rows, _ = load_records(Path(args.candidate_dataset_dir))
    external_publisher_set = set(external_publishers)
    filtered_candidate_rows = [
        record for record in candidate_rows
        if hashlib.sha256(record["domain"].encode("utf-8")).hexdigest() not in external_publisher_set
    ]

    if eligible:
        selected_external, near_duplicate_counts = filter_near_duplicates_direct(
            filtered_candidate_rows, eligible
        )
    else:
        selected_external = []
        near_duplicate_counts = {
            "cross_corpus_near_duplicate_articles_removed": 0,
            "external_near_duplicate_articles_removed": 0,
            "conflicting_near_duplicate_articles_removed": 0,
        }
    cross_corpus_removed = near_duplicate_counts["cross_corpus_near_duplicate_articles_removed"]
    external_near_duplicates_removed = near_duplicate_counts["external_near_duplicate_articles_removed"]
    conflicting_near_duplicates_removed = near_duplicate_counts["conflicting_near_duplicate_articles_removed"]
    selected_external.sort(key=lambda item: item["text_hash"])
    evaluation_path = output_dir / "external-disjoint-evaluation.jsonl"
    write_jsonl(evaluation_path, selected_external)
    summary = {
        "protocol_version": "truthlens-external-publisher-disjoint-v1",
        "dataset": "Disinformation Detection: Code and Datasets v1.1",
        "dataset_doi": "10.5281/zenodo.18135595",
        "license": "CC BY 4.0",
        "source_archive_md5": md5.hexdigest(),
        "source_archive_sha256": archive_sha.hexdigest(),
        "delimited_files_scanned": files_scanned,
        "scan_counts": scan_counts,
        "source_file_label_diagnostics": source_file_label_diagnostics,
        "exact_unique_full_text_article_fingerprints": len(unique),
        "exact_duplicate_articles_with_conflicting_labels_excluded": conflicting_label_articles,
        "eligible_unique_articles_before_cross_corpus_near_dedup": len(eligible),
        "eligible_unique_articles_by_label": eligible_label_counts,
        "external_publisher_fingerprint_count": len(external_publishers),
        "external_publisher_fingerprint_set_sha256": fingerprint_set_sha,
        "candidate_input_records_before_source_exclusion": len(candidate_rows),
        "candidate_input_records_after_publisher_exclusion": len(filtered_candidate_rows),
        "candidate_input_records_excluded_for_external_publisher_overlap": len(candidate_rows) - len(filtered_candidate_rows),
        "external_records_removed_for_cross_corpus_near_duplicate_overlap": cross_corpus_removed,
        "external_records_removed_for_external_near_duplicates": external_near_duplicates_removed,
        "external_records_removed_for_near_duplicate_label_conflicts": conflicting_near_duplicates_removed,
        "independent_external_evaluation_count": len(selected_external),
        "independent_external_evaluation_by_label": {
            "FAKE": sum(record["y"] == 1 for record in selected_external),
            "REAL": sum(record["y"] == 0 for record in selected_external),
        },
        "external_evaluation_jsonl_sha256": sha(evaluation_path.read_bytes()),
        "method_notes": [
            "Only unique full-text articles with explicit, unambiguous binary labels and source metadata enter evaluation.",
            "Every eligible external publisher is excluded from candidate development before training.",
            "Near-duplicate clusters use the repository's 5-word-shingle, 128-permutation, Jaccard 0.70 method.",
            "External records with any near-duplicate match to candidate-development articles are removed.",
            "External labels and scores are not used for feature/model/calibration/threshold selection.",
            "Raw external text is temporary and is not uploaded as an artifact.",
        ],
        "screening_gate_passed": len(selected_external) >= 10000,
    }
    summary_path = output_dir / "external-preparation-summary.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "method_notes"}, indent=2))
    if not eligible:
        raise SystemExit("No unique external articles meet the full-text, explicit-label and source filters; diagnostic summary was written.")

if __name__ == "__main__":
    main()
