"""
Automated tests for scripts/isot_data_pipeline.py (Task 14 of the ML upgrade
Phase 2 spec). These use small synthetic fixtures so they run in well under
a second -- they do not require the real ~45k-row ISOT dataset to be present.

Every test fails LOUDLY (a plain AssertionError with a clear message) when
the pipeline violates one of its stated guarantees. Run with:

    python3 backend/tests/test_isot_pipeline.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.isot_data_pipeline import (  # noqa: E402
    build_manifest,
    near_duplicate_groups,
    stratified_group_split,
    temporal_split,
    try_parse_date,
    REUTERS_DATELINE_RE,
)

passed = 0
failed = 0


def check(condition, name, detail=""):
    global passed, failed
    if condition:
        print(f"[PASS] {name}")
        passed += 1
    else:
        print(f"[FAIL] {name} -- {detail}")
        failed += 1


def make_row(idx, label, title, text, subject="test", date="January 1, 2017"):
    return {
        "title": title,
        "text": text,
        "subject": subject,
        "date": date,
        "_source_file": "synthetic",
        "_row_index": idx,
        "_label": label,
        "_id": f"{label}-{idx}",
    }


def test_date_parsing():
    d = try_parse_date("January 5, 2017")
    check(
        d is not None and d.year == 2017 and d.month == 1 and d.day == 5,
        "date_parsing: valid 'Month D, YYYY' format parses correctly",
    )

    d2 = try_parse_date("not a date at all")
    check(
        d2 is None,
        "date_parsing: garbage input returns None, not a crash or a fabricated date",
    )


def test_exact_duplicate_detection():
    rows = [
        make_row(0, "FAKE", "Same Title", "Same body text here."),
        make_row(1, "FAKE", "Same Title", "Same body text here."),
        make_row(2, "FAKE", "Different Title", "Different body text."),
    ]
    rows = build_manifest(rows)
    dup_flags = [r["is_exact_duplicate_group"] for r in rows]
    check(
        dup_flags == [True, True, False],
        "exact_duplicate: identical title+text rows are both flagged, unique row is not",
        detail=str(dup_flags),
    )

    first_occurrence = [r["is_first_occurrence"] for r in rows]
    check(
        first_occurrence == [True, False, True],
        "exact_duplicate: only the first of a duplicate pair keeps is_first_occurrence=True",
    )

    check(
        rows[0]["is_empty_text"] is False and rows[0]["is_very_short_text"] is True,
        "quality_flags: the 21-char fixture text is correctly flagged as very-short (< 60 chars), "
        "not empty",
    )


def test_empty_and_short_text_flagged_not_deleted():
    rows = [
        make_row(0, "REAL", "T1", ""),
        make_row(1, "REAL", "T2", "short"),
        make_row(2, "REAL", "T3", "x" * 200),
    ]
    rows = build_manifest(rows)
    check(
        len(rows) == 3,
        "no_silent_deletion: build_manifest never removes rows, only flags them",
    )
    check(rows[0]["is_empty_text"] is True, "empty_text: zero-length text is flagged")
    check(rows[1]["is_very_short_text"] is True, "short_text: 5-char text is flagged")
    check(
        rows[2]["is_empty_text"] is False and rows[2]["is_very_short_text"] is False,
        "normal_text: 200-char text is not flagged",
    )


def test_reuters_dateline_regex_matches_real_pattern():
    matches = bool(
        REUTERS_DATELINE_RE.match(
            "WASHINGTON (Reuters) - The government said on Tuesday..."
        )
    )
    check(matches, "reuters_dateline: real Reuters-style opening line is detected")

    no_match = bool(
        REUTERS_DATELINE_RE.match(
            "SHOCKING new report reveals the truth about..."
        )
    )
    check(
        not no_match,
        "reuters_dateline: a non-wire-service opening line is NOT falsely flagged",
    )


def test_near_duplicate_detection_catches_paraphrase():
    base_text = (
        "The city council voted on Tuesday to approve the new municipal "
        "budget after several months of public debate over infrastructure "
        "spending priorities, public transit funding allocations, and road "
        "maintenance projects planned for the coming fiscal year. Officials "
        "said the plan balances competing demands from residents in the "
        "northern and southern districts, who have long disagreed over how "
        "transit funding should be divided between bus routes and light "
        "rail expansion. The council chairwoman said the final vote reflects "
        "months of negotiation between departments and community groups, and "
        "that implementation would begin early next year pending final "
        "sign-off from the finance committee and a routine compliance review."
    )
    near_dup_text = base_text.replace("Tuesday", "Wednesday").replace(
        "chairwoman", "chairperson"
    )
    unrelated_text = (
        "A total solar eclipse will be visible across several states "
        "next month, drawing large crowds to viewing sites along the path "
        "of totality. Astronomers say the event offers a rare chance to "
        "study the sun's outer atmosphere, and local governments are "
        "preparing for a significant increase in visitor traffic."
    )
    rows = [
        make_row(0, "REAL", "A", base_text),
        make_row(1, "REAL", "B", near_dup_text),
        make_row(2, "FAKE", "C", unrelated_text),
    ]
    id_to_group, groups = near_duplicate_groups(rows)
    check(
        id_to_group["REAL-0"] == id_to_group["REAL-1"],
        "near_duplicate: a lightly-reworded paraphrase of an article-length text is grouped with its source",
    )
    check(
        id_to_group["FAKE-2"] != id_to_group["REAL-0"],
        "near_duplicate: an unrelated article is NOT grouped with unrelated content",
    )


def test_split_never_straddles_a_near_duplicate_group():
    rows = []
    idx = 0
    for cluster in range(40):
        label = "FAKE" if cluster % 2 == 0 else "REAL"
        base = (
            f"Cluster {cluster} story about topic number {cluster} "
            "with enough words to matter here today."
        )
        for variant in range(3):
            text = base if variant == 0 else base.replace(
                "today", f"today variant {variant}"
            )
            rows.append(make_row(idx, label, f"T{idx}", text))
            idx += 1

    rows = build_manifest(rows)
    id_to_group, groups = near_duplicate_groups(rows)
    split_ids = stratified_group_split(rows, id_to_group, seed=123)

    split_of_id = {}
    for name, ids in split_ids.items():
        for i in ids:
            split_of_id[i] = name

    straddling = 0
    for members in groups.values():
        if len(members) > 1:
            sides = {split_of_id[m] for m in members}
            if len(sides) > 1:
                straddling += 1

    check(
        straddling == 0,
        "split_leakage: no near-duplicate group is split across train/val/test",
        detail=f"{straddling} groups straddled a split boundary",
    )

    total_assigned = sum(len(v) for v in split_ids.values())
    check(
        total_assigned == len(rows),
        "split_completeness: every row is assigned to exactly one split",
    )


def test_temporal_split_excludes_undated_rows_and_is_group_aware():
    rows = [
        make_row(
            0,
            "REAL",
            "A",
            "Some real text about policy that is long enough to matter here.",
            date="January 1, 2016",
        ),
        make_row(
            1,
            "FAKE",
            "B",
            "Some fake text about conspiracy that is long enough to matter too.",
            date="January 1, 2018",
        ),
        make_row(
            2,
            "REAL",
            "C",
            "Undated article text that also has enough words in it to be valid.",
            date="not-a-date",
        ),
    ]
    rows = build_manifest(rows)
    id_to_group, _ = near_duplicate_groups(rows)
    temporal_ids, cutoff, undated_count = temporal_split(rows, id_to_group)

    check(
        undated_count == 1,
        "temporal_split: the one row with an unparseable date is excluded and counted",
    )
    all_temporal_ids = set(temporal_ids["train"]) | set(temporal_ids["test"])
    check(
        "REAL-2" not in all_temporal_ids,
        "temporal_split: the undated row never appears in either temporal split",
    )


def main():
    test_date_parsing()
    test_exact_duplicate_detection()
    test_empty_and_short_text_flagged_not_deleted()
    test_reuters_dateline_regex_matches_real_pattern()
    test_near_duplicate_detection_catches_paraphrase()
    test_split_never_straddles_a_near_duplicate_group()
    test_temporal_split_excludes_undated_rows_and_is_group_aware()

    print(f"\n{passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
