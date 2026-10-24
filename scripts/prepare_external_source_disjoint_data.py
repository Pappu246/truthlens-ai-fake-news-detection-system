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
LABEL_ALIASES = {"label", "veracity", "truthlabel", "truthfulness", "fakenewslabel", "factuality", "isfake", "fake", "class", "reliability", "credibility"}
FAKE_LABELS = {"fake", "fake news", "false", "misinformation", "disinformation", "false news", "not true", "untrue", "noncredible", "non credible"}
REAL_LABELS = {"real", "real news", "true", "factual", "credible", "reliable", "not fake", "non fake", "non-fake"}

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def norm_header(value) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())

def map_binary_label(value):
    # Normalize punctuation and separators before exact matching. This handles
    # spellings such as "fake-news", "real_news", and "non-fake" without
    # guessing numeric or ambiguous labels.
    value = re.sub(r"[^a-z0-9]+", " ", str(value or "").strip().lower()).strip()
    if value in FAKE_LABELS:
        return "FAKE"
    if value in REAL_LABELS:
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

def choose_label_column(rows, label_columns):
    """Choose one explicit binary label field; never combine separate taxonomies."""
    label_priority = (
        "class", "truthlabel", "veracity", "truthfulness", "fakenewslabel",
        "factuality", "isfake", "label", "reliability", "credibility"
    )
    candidate_stats = {}
    mapped_by_column = {}
    for column in label_columns:
        values = [map_binary_label(row.get(column)) for row in rows]
        mapped_by_column[column] = values
        candidate_stats[column] = {
            "fake": sum(value == "FAKE" for value in values),
            "real": sum(value == "REAL" for value in values),
            "unmapped": sum(value is None for value in values),
        }

    # A single field must demonstrate both classes on eligible full-text rows.
    # If a preferred field only emits one class, fall back to the next explicit
    # field that independently contains FAKE and REAL. Never union fields.
    viable = [
        column for column in label_columns
        if candidate_stats[column]["fake"] > 0 and candidate_stats[column]["real"] > 0
    ]

    def priority(column):
        name = norm_header(column)
        try:
            return label_priority.index(name)
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

    comparisons = {}
    if selected is not None:
        selected_values = mapped_by_column[selected]
        for column in viable:
            if column == selected:
                continue
            other_values = mapped_by_column[column]
            paired = [
                (left, right) for left, right in zip(selected_values, other_values)
                if left is not None and right is not None
            ]
            comparisons[column] = {
                "overlapping_mapped_rows": len(paired),
                "disagreement_rows": sum(left != right for left, right in paired),
            }

    return selected, {
        "candidate_label_columns": candidate_stats,
        "selected_label_column": selected,
        "selection_reason": (
            "selected one preferred field containing both explicit binary classes"
            if selected is not None
            else "no single candidate field contained both explicit binary classes; file rows excluded rather than mixing fields"
        ),
        "competing_column_comparisons": comparisons,
    }


def scan_delimited(stream, delimiter, unique, counters, diagnostics, source_name):
    reader = csv.DictReader(
        io.TextIOWrapper(stream, encoding="utf-8-sig", errors="replace", newline=""),
        delimiter=delimiter,
    )
    headers = reader.fieldnames or []
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
        or any(term in norm_header(h) for term in ("truthlabel", "veracitylabel", "fakelabel"))
    ]

    if not body_columns or not source_columns or not label_columns:
        rows_scanned_in_file = sum(1 for _ in reader)
        counters["rows_scanned"] += rows_scanned_in_file
        diagnostics.append({
            "file": source_name,
            "rows_scanned": rows_scanned_in_file,
            "full_text_rows": 0,
            "full_text_with_source_rows": 0,
            "candidate_label_columns": {},
            "selected_label_column": None,
            "selection_reason": "required article-text, source, or explicit label headers are missing",
        })
        counters["files_missing_required_headers"] += 1
        return

    full_text_rows_before = counters["full_text_rows"]
    rows_scanned_in_file = 0
    eligible_rows = []
    for row in reader:
        rows_scanned_in_file += 1
        counters["rows_scanned"] += 1
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
            continue
        counters["full_text_rows"] += 1
        sources = {fp for column in source_columns if (fp := domain_fingerprint(row.get(column)))}
        if not sources:
            continue
        eligible_rows.append((row, text, sources))

    counters["full_text_with_source_rows"] += len(eligible_rows)
    selected_label_column, label_diagnostic = choose_label_column(
        [item[0] for item in eligible_rows], label_columns
    )
    diagnostics.append({
        "file": source_name,
        "rows_scanned": rows_scanned_in_file,
        "full_text_rows": counters["full_text_rows"] - full_text_rows_before,
        "full_text_with_source_rows": len(eligible_rows),
        **label_diagnostic,
    })

    if selected_label_column is None:
        counters["files_without_mixed_label_column"] += 1
        counters["rows_excluded_without_single_mixed_label_field"] += len(eligible_rows)
        return

    for row, text, sources in eligible_rows:
        label = map_binary_label(row.get(selected_label_column))
        if label is None:
            counters["rows_unmapped_on_selected_label_field"] += 1
            continue
        counters["full_text_with_explicit_label_and_source"] += 1
        fingerprint = article_text_fingerprint(text)
        article = unique.setdefault(
            fingerprint,
            {"text": text, "labels": set(), "source_fingerprints": set()},
        )
        article["labels"].add(label)
        article["source_fingerprints"].update(sources)
        article["text"] = min(article["text"], text)


def scan_external_archive(archive_path: Path):
    csv.field_size_limit(50 * 1024 * 1024)
    unique = {}
    counters = defaultdict(int)
    diagnostics = []
    files_scanned = 0
    with zipfile.ZipFile(archive_path) as outer:
        for info in outer.infolist():
            if info.is_dir():
                continue
            suffix = Path(info.filename).suffix.lower()
            if suffix in {".csv", ".tsv"}:
                files_scanned += 1
                with outer.open(info, "r") as stream:
                    scan_delimited(
                        stream, "," if suffix == ".csv" else "\t",
                        unique, counters, diagnostics, info.filename,
                    )
            elif suffix == ".zip":
                with outer.open(info, "r") as source:
                    nested_bytes = source.read()
                with zipfile.ZipFile(io.BytesIO(nested_bytes)) as inner:
                    for nested in inner.infolist():
                        nested_suffix = Path(nested.filename).suffix.lower()
                        if nested.is_dir() or nested_suffix not in {".csv", ".tsv"}:
                            continue
                        files_scanned += 1
                        with inner.open(nested, "r") as stream:
                            scan_delimited(
                                stream, "," if nested_suffix == ".csv" else "\t",
                                unique, counters, diagnostics,
                                info.filename + "!" + nested.filename,
                            )
    counter_payload = dict(counters)
    counter_payload["source_file_label_diagnostics"] = diagnostics
    return unique, counter_payload, files_scanned


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
    if not eligible:
        raise SystemExit("No unique external articles meet the full-text, explicit-label and source filters.")
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

    selected_external, near_duplicate_counts = filter_near_duplicates_direct(
        filtered_candidate_rows, eligible
    )
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

if __name__ == "__main__":
    main()
