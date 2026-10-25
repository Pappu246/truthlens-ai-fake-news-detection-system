import csv
import io
import zipfile

from prepare_external_source_disjoint_data import (
    article_text_fingerprint,
    external_sample_screening_gate,
    load_authoritative_label_registry,
    map_binary_label,
    normalize_article_url,
    resolve_external_label,
    scan_external_archive,
)


def test_binary_label_mapper_normalizes_explicit_labels_but_does_not_guess():
    assert map_binary_label("disinformation") == "FAKE"
    assert map_binary_label("TRUE") == "REAL"
    assert map_binary_label("FALSE") == "FAKE"
    assert map_binary_label("True", "is_fake") == "FAKE"
    assert map_binary_label("False", "is_fake") == "REAL"
    assert map_binary_label("True", "is_real") == "REAL"
    assert map_binary_label("False", "is_real") == "FAKE"
    assert map_binary_label("fake-news") == "FAKE"
    assert map_binary_label("real_news") == "REAL"
    assert map_binary_label("non-fake") == "REAL"
    assert map_binary_label("support") is None
    assert map_binary_label("1") is None
    assert map_binary_label("mostly true") is None


def test_article_fingerprint_collapses_whitespace_and_case():
    assert article_text_fingerprint("NASA  REPORT\nText") == article_text_fingerprint("nasa report text")


def test_external_archive_uses_one_balanced_field_and_consolidates_exact_duplicates(tmp_path):
    archive = tmp_path / "synthetic.zip"
    body = " ".join(["independent"] * 70) + " This is a sufficiently long full article used for a deterministic audit test."
    rows = [
        {"article_title": "Verified report", "article_text": body, "article_url": "https://www.example.org/item", "class": "disinformation", "label": "TRUE"},
        {"article_title": "Verified  report", "article_text": body, "article_url": "https://example.org/other", "class": "disinformation", "label": "true"},
        {"article_title": "Contradictory report", "article_text": body + " different tail", "article_url": "https://rumor.example.net/item", "class": "disinformation", "label": "disinformation"},
    ]
    raw = io.StringIO()
    writer = csv.DictWriter(raw, fieldnames=["article_title", "article_text", "article_url", "class", "label"])
    writer.writeheader()
    writer.writerows(rows)
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("articles.csv", raw.getvalue())

    unique, counts, files_scanned = scan_external_archive(archive)
    eligible = [item for item in unique.values() if len(item["labels"]) == 1 and item["source_fingerprints"]]
    assert files_scanned == 1
    assert counts["rows_scanned"] == 3
    assert len(unique) == 2
    assert len(eligible) == 2
    assert {next(iter(item["labels"])) for item in eligible} == {"FAKE", "REAL"}
    assert len(next(item for item in eligible if next(iter(item["labels"])) == "REAL")["source_fingerprints"]) == 1
    diagnostic = counts["source_file_label_diagnostics"][0]
    assert diagnostic["selected_label_column"] == "label"
    assert diagnostic["candidate_label_columns"]["class"]["fake"] == 3
    assert diagnostic["candidate_label_columns"]["class"]["real"] == 0


def test_nonempty_secondary_text_column_and_label_fallback_are_used(tmp_path):
    archive = tmp_path / "combined.zip"
    body = " ".join(["independent"] * 70) + " This full article uses the secondary text field."
    rows = [
        {"article_title": "", "article_text": "", "text": body, "article_url": "https://real.example.org/news", "class": "disinformation", "label": "true"},
        {"article_title": "False report", "article_text": body + " changed content", "text": "", "article_url": "https://fake.example.net/news", "class": "fake-news", "label": "disinformation"},
    ]
    raw = io.StringIO()
    writer = csv.DictWriter(raw, fieldnames=["article_title", "article_text", "text", "article_url", "class", "label"])
    writer.writeheader()
    writer.writerows(rows)
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("combined.csv", raw.getvalue())

    unique, counts, files_scanned = scan_external_archive(archive)
    labels = {next(iter(item["labels"])) for item in unique.values() if len(item["labels"]) == 1}
    assert files_scanned == 1
    assert counts["rows_scanned"] == 2
    assert len(unique) == 2
    assert labels == {"FAKE", "REAL"}
    assert counts["source_file_label_diagnostics"][0]["selected_label_column"] == "label"


def test_single_class_columns_are_not_combined_to_manufacture_a_binary_set(tmp_path):
    archive = tmp_path / "ambiguous.zip"
    body = " ".join(["independent"] * 70) + " This is a sufficiently long full article used for a deterministic audit test."
    rows = [
        {"article_title": "Story A", "article_text": body, "article_url": "https://a.example.org/item", "class": "disinformation", "label": "true"},
        {"article_title": "Story B", "article_text": body + " distinct tail", "article_url": "https://b.example.org/item", "class": "disinformation", "label": "true"},
    ]
    raw = io.StringIO()
    writer = csv.DictWriter(raw, fieldnames=["article_title", "article_text", "article_url", "class", "label"])
    writer.writeheader()
    writer.writerows(rows)
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("ambiguous.csv", raw.getvalue())

    unique, counts, files_scanned = scan_external_archive(archive)
    assert files_scanned == 1
    assert unique == {}
    diagnostic = counts["source_file_label_diagnostics"][0]
    assert diagnostic["selected_label_column"] is None
    assert "rather than mixing fields" in diagnostic["selection_reason"]
    assert counts["rows_excluded_without_single_mixed_label_field"] == 2


def test_exact_jaccard_is_direct_and_symmetric():
    from prepare_external_source_disjoint_data import exact_jaccard
    left = {1, 2, 3, 4}
    right = {2, 3, 4, 5}
    assert exact_jaccard(left, right) == 0.6
    assert exact_jaccard(left, right) == exact_jaccard(right, left)


def test_balanced_label_field_can_span_compatible_single_class_files(tmp_path):
    archive = tmp_path / "split-by-class.zip"
    body = " ".join(["independent"] * 70) + " This is a long article in a source split by its class."
    fields = ["article_title", "article_text", "article_url", "class", "label"]
    fake = [
        {"article_title": "Fake item " + str(i), "article_text": body + " fake " + str(i),
         "article_url": f"https://fake{i}.example.org/story", "class": "disinformation", "label": "false"}
        for i in range(2)
    ]
    real = [
        {"article_title": "Real item " + str(i), "article_text": body + " real " + str(i),
         "article_url": f"https://real{i}.example.net/story", "class": "disinformation", "label": "true"}
        for i in range(2)
    ]
    raw_fake, raw_real = io.StringIO(), io.StringIO()
    for raw, rows in ((raw_fake, fake), (raw_real, real)):
        writer = csv.DictWriter(raw, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("partition-a.csv", raw_fake.getvalue())
        z.writestr("partition-b.csv", raw_real.getvalue())

    unique, counts, files_scanned = scan_external_archive(archive)
    labels = {next(iter(item["labels"])) for item in unique.values() if len(item["labels"]) == 1}
    assert files_scanned == 2
    assert len(unique) == 4
    assert labels == {"FAKE", "REAL"}
    assert counts["compatible_schema_group_count"] == 1
    assert counts["schema_groups_without_single_mixed_label_field"] == 0
    group = counts["label_schema_group_diagnostics"][0]
    assert group["candidate_label_columns"]["label"]["normalized_value_counts_top30"]["false"] == 2
    assert group["candidate_label_columns"]["label"]["normalized_value_counts_top30"]["true"] == 2
    assert all(item["selected_label_column"] == "label" for item in counts["source_file_label_diagnostics"])


def test_external_sample_screening_requires_10000_and_both_classes():
    balanced = [{"y": 1} for _ in range(5000)] + [{"y": 0} for _ in range(5000)]
    passed, failures, counts = external_sample_screening_gate(balanced)
    assert passed is True
    assert failures == []
    assert counts == {"FAKE": 5000, "REAL": 5000}

    too_small = balanced[:-1]
    passed, failures, counts = external_sample_screening_gate(too_small)
    assert passed is False
    assert any("9999 < 10000" in failure for failure in failures)

    one_class = [{"y": 1} for _ in range(10000)]
    passed, failures, counts = external_sample_screening_gate(one_class)
    assert passed is False
    assert any("missing binary class(es): REAL" in failure for failure in failures)


def test_authoritative_url_registry_resolves_support_only_when_official_url_label_matches(tmp_path):
    registry = tmp_path / "euvsdisinfo_base.csv"
    raw = (
        "article_url,class\n"
        "https://www.example.org/news/support-story?utm_source=feed,trustworthy\n"
        "http://misinfo.example.net/story#debunk,disinformation\n"
        "https://conflict.example.org/a,trustworthy\n"
        "https://www.conflict.example.org/a?utm_medium=share,disinformation\n"
    ).encode("utf-8")
    registry.write_bytes(raw)

    labels, conflicts, metadata = load_authoritative_label_registry(registry, expected_md5=None)
    assert metadata["rows_scanned"] == 4
    assert metadata["recognized_label_rows"] == {"FAKE": 2, "REAL": 2}
    assert metadata["conflicting_article_url_count"] == 1
    assert normalize_article_url("https://www.example.org/news/support-story?utm_source=other") in labels
    assert normalize_article_url("https://conflict.example.org/a") in conflicts

    assert resolve_external_label(
        "support", "class", "https://example.org/news/support-story",
        labels, conflicts
    ) == ("REAL", "authoritative_url_fallback")
    assert resolve_external_label(
        "disinformation", "class", "https://misinfo.example.net/story",
        labels, conflicts
    ) == ("FAKE", "raw_and_authoritative_agree")
    assert resolve_external_label(
        "support", "class", "https://unmatched.example.net/article",
        labels, conflicts
    ) == (None, "unmapped_without_authority_match")
    assert resolve_external_label(
        "disinformation", "class", "https://example.org/news/support-story",
        labels, conflicts
    ) == (None, "raw_label_conflicts_with_authoritative_url")
    assert resolve_external_label(
        "support", "class", "https://conflict.example.org/a",
        labels, conflicts
    ) == (None, "ambiguous_authoritative_url")


def test_source_disjoint_scan_uses_official_url_crosswalk_for_support_rows(tmp_path):
    archive = tmp_path / "synthetic.zip"
    body_a = " ".join(["independent"] * 70) + " This is a full supporting article with the official source URL."
    body_b = " ".join(["different"] * 70) + " This is a separate disinformation article with its source URL."
    rows = [
        {"article_title": "Support story", "article_text": body_a, "article_url": "https://www.example.org/support-story?utm_source=copy", "class": "support"},
        {"article_title": "Disinformation story", "article_text": body_b, "article_url": "http://misinfo.example.net/story", "class": "disinformation"},
    ]
    raw_csv = io.StringIO()
    writer = csv.DictWriter(raw_csv, fieldnames=["article_title", "article_text", "article_url", "class"])
    writer.writeheader()
    writer.writerows(rows)
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.writestr("articles.csv", raw_csv.getvalue())

    registry = tmp_path / "euvsdisinfo_base.csv"
    registry.write_text(
        "article_url,class\n"
        "https://example.org/support-story,trustworthy\n"
        "https://misinfo.example.net/story,disinformation\n",
        encoding="utf-8",
    )
    labels, conflicts, _ = load_authoritative_label_registry(registry, expected_md5=None)
    unique, counts, _ = scan_external_archive(archive, labels, conflicts)

    assert counts["compatible_schema_group_count"] == 1
    assert counts["schema_groups_without_single_mixed_label_field"] == 0
    assert len(unique) == 2
    labels_found = {next(iter(article["labels"])) for article in unique.values() if len(article["labels"]) == 1}
    assert labels_found == {"FAKE", "REAL"}
    diagnostic = counts["source_file_label_diagnostics"][0]
    assert diagnostic["selected_label_column"] == "class"
    assert diagnostic["selected_label_counts"] == {"FAKE": 1, "REAL": 1}
    assert diagnostic["label_resolution_counts"]["selected_field"]["authoritative_url_fallback"] == 1
