import pandas as pd

from train_polyglot_source_heldout_candidate import (
    dedup_exact,
    exclude_mixed_publishers,
    normalize_domain,
    publisher_split,
    source_domain,
)


def record(i, label, domain, text=None):
    text = text or f"article {i} with unique substantive facts and detailed reporting from the public record"
    return {
        "id": f"r{i}",
        "domain": domain,
        "y": label,
        "text": text,
        "clean": text.lower(),
        "text_hash": f"hash-{i}",
    }


def test_registrable_domain_uses_public_suffix_list():
    assert normalize_domain("https://www.news.example.co.uk/path") == "example.co.uk"
    assert normalize_domain("https://sub.publisher.example.com/story") == "example.com"
    assert normalize_domain("https://bit.ly/abc") is None
    assert normalize_domain("not a valid URL") is None


def test_source_domain_prefers_canonical_url_host_and_falls_back_to_domain_metadata():
    row = pd.Series({"url": "https://www.publisher.example.com/article", "domain": "different.example.org"})
    assert source_domain(row) == "example.com"
    fallback = pd.Series({"url": "https://bit.ly/short", "domain": "publisher.example.org"})
    assert source_domain(fallback) == "example.org"


def test_publishers_with_conflicting_labels_are_excluded_entirely():
    rows = [
        record(1, 1, "mixed.example"),
        record(2, 0, "mixed.example"),
        record(3, 1, "fake.example"),
        record(4, 0, "real.example"),
    ]
    kept, report = exclude_mixed_publishers(rows)
    assert [item["id"] for item in kept] == ["r3", "r4"]
    assert report["mixed_label_publishers_excluded"] == 1
    assert report["rows_from_mixed_label_publishers_excluded"] == 2


def test_exact_dedup_removes_duplicate_articles_and_conflicting_label_duplicates():
    rows = [
        {**record(1, 1, "a.example"), "text_hash": "same"},
        {**record(2, 1, "b.example"), "text_hash": "same"},
        {**record(3, 1, "c.example"), "text_hash": "conflict"},
        {**record(4, 0, "d.example"), "text_hash": "conflict"},
        record(5, 0, "e.example"),
    ]
    kept, report = dedup_exact(rows)
    assert len(kept) == 2
    assert report["same_label_exact_duplicates_removed"] == 1
    assert report["conflicting_label_exact_duplicate_rows_removed"] == 2


def test_domain_split_keeps_publishers_disjoint_and_both_classes_in_every_split():
    rows = []
    i = 0
    # 20 independent publishers per class with multiple articles per domain.
    for label, prefix in ((0, "real"), (1, "fake")):
        for domain_index in range(20):
            for item in range(3):
                i += 1
                rows.append(record(i, label, f"{prefix}-{domain_index}.example", f"article {i} substantive reporting details"))
    split, domain_sets = publisher_split(rows)
    assert domain_sets["train"].isdisjoint(domain_sets["validation"])
    assert domain_sets["train"].isdisjoint(domain_sets["test"])
    assert domain_sets["validation"].isdisjoint(domain_sets["test"])
    for name, items in split.items():
        assert {item["y"] for item in items} == {0, 1}
        assert len({item["domain"] for item in items}) > 0
