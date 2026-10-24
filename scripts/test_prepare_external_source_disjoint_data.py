import csv
import io
import zipfile

from prepare_external_source_disjoint_data import article_text_fingerprint, map_binary_label, scan_external_archive

def test_binary_label_mapper_does_not_guess_ambiguous_or_numeric_labels():
    assert map_binary_label("disinformation") == "FAKE"
    assert map_binary_label("TRUE") == "REAL"
    assert map_binary_label("support") is None
    assert map_binary_label("1") is None
    assert map_binary_label("mostly true") is None

def test_article_fingerprint_collapses_whitespace_and_case():
    assert article_text_fingerprint("NASA  REPORT\nText") == article_text_fingerprint("nasa report text")

def test_external_archive_consolidates_exact_duplicates_and_requires_source_and_label(tmp_path):
    archive = tmp_path / "synthetic.zip"
    body = " ".join(["independent"] * 70) + " This is a sufficiently long full article used for a deterministic audit test."
    rows = [
        {"article_title": "Verified report", "article_text": body, "article_url": "https://www.example.org/item", "class": "true"},
        {"article_title": "Verified  report", "article_text": body, "article_url": "https://example.org/other", "class": "TRUE"},
        {"article_title": "Unmapped report", "article_text": body + " different tail", "article_url": "https://rumor.example.net/item", "class": "support"},
    ]
    raw = io.StringIO()
    writer = csv.DictWriter(raw, fieldnames=["article_title", "article_text", "article_url", "class"])
    writer.writeheader()
    writer.writerows(rows)
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("articles.csv", raw.getvalue())
    unique, counts, files_scanned = scan_external_archive(archive)
    eligible = [item for item in unique.values() if len(item["labels"]) == 1 and item["source_fingerprints"]]
    assert files_scanned == 1
    assert counts["rows_scanned"] == 3
    assert len(unique) == 1
    assert len(eligible) == 1
    assert eligible[0]["labels"] == {"REAL"}
    assert len(eligible[0]["source_fingerprints"]) == 1


def test_nonempty_text_column_wins_over_blank_primary_body_and_class_has_priority(tmp_path):
    archive = tmp_path / "combined.zip"
    body = " ".join(["independent"] * 70) + " This full article uses the secondary text field."
    rows = [
        {"article_title": "", "article_text": "", "text": body, "article_url": "https://real.example.org/news", "class": "true", "label": "disinformation"},
        {"article_title": "False report", "article_text": body + " changed content", "text": "", "article_url": "https://fake.example.net/news", "class": "disinformation", "label": "disinformation"},
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
