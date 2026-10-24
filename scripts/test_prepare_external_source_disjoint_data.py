import csv
import io
import zipfile

from prepare_external_source_disjoint_data import article_text_fingerprint, map_binary_label, scan_external_archive


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
    assert all(item["selected_label_column"] == "label" for item in counts["source_file_label_diagnostics"])
