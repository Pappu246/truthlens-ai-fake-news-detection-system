import pandas as pd
import pytest

from evaluate_polyglot_independent_candidate import (
    label_from_filename,
    parse_textual_label,
    records_from_frame,
    select_article_columns,
)


LONG_BODY = " ".join(
    [
        "Officials published detailed results after a documented investigation and review."
        " The report describes the findings, methods, dates, evidence, and limitations."
    ] * 8
)


def test_class_separated_workbook_names_are_explicit():
    assert label_from_filename("Fake.xlsx") == 1
    assert label_from_filename("Real.xlsx") == 0
    with pytest.raises(ValueError):
        label_from_filename("Mixed.xlsx")


def test_textual_label_mapping_is_explicit_and_numeric_labels_are_not_guessed():
    assert parse_textual_label("fake news") == 1
    assert parse_textual_label("non-fake") == 0
    assert parse_textual_label(0) is None
    with pytest.raises(ValueError):
        parse_textual_label("uncertain label")


def test_english_translation_is_preferred_over_original_language_text():
    frame = pd.DataFrame({
        "Original Headline": ["Example headline"],
        "Original Text": ["Texto en español " * 100],
        "English Translated Text": [LONG_BODY],
        "Language": ["Spanish"],
        "Label": ["fake"],
    })
    _, body, _, _, translated = select_article_columns(frame, "Fake.xlsx")
    assert body == "English Translated Text"
    assert translated is True
    records, stats = records_from_frame(frame, "Fake.xlsx", "Sheet1")
    assert len(records) == 1
    assert records[0]["y_fake"] == 1
    assert records[0]["body"] == LONG_BODY
    assert stats["uses_english_translation"] is True


def test_published_polyglot_workbook_column_names_are_supported():
    # Exact headers observed in the official PolyglotFakeFacts v2.0 archive.
    frame = pd.DataFrame({
        "Gathering date": ["2024-01-01"],
        "News date": ["2024-01-02"],
        "Language": ["Spanish"],
        "URL": ["https://example.test/article"],
        "Domain": ["example.test"],
        "Keywords": ["research, public"],
        "News headline": ["Example headline"],
        "News original text": ["Texto en español " * 100],
        "English translated version": [LONG_BODY],
        "Label": ["fake"],
    })
    title, body, lang, label, translated = select_article_columns(frame, "Fake.xlsx")
    assert title == "News headline"
    assert body == "English translated version"
    assert lang == "Language"
    assert label == "Label"
    assert translated is True

    records, stats = records_from_frame(frame, "Fake.xlsx", "Sheet1")
    assert len(records) == 1
    assert records[0]["body"] == LONG_BODY
    assert records[0]["y_fake"] == 1
    assert stats["uses_english_translation"] is True


def test_unrecognized_body_columns_fail_closed_instead_of_selecting_first_column():
    frame = pd.DataFrame({
        "Headline": ["Example headline"],
        "Language": ["English"],
        "Label": ["fake"],
        "Comments": ["This is not the article body."],
    })
    with pytest.raises(ValueError, match="no recognized article-text column"):
        select_article_columns(frame, "Fake.xlsx")


def test_original_non_english_text_without_translation_is_rejected():
    frame = pd.DataFrame({
        "Original Headline": ["Ejemplo"],
        "Original Text": ["Texto en español " * 100],
        "Language": ["Spanish"],
        "Label": ["fake"],
    })
    with pytest.raises(ValueError, match="no English-translated body column"):
        select_article_columns(frame, "Fake.xlsx")


def test_textual_label_conflict_with_class_workbook_fails_closed():
    frame = pd.DataFrame({
        "Original Headline": ["Example headline"],
        "English Translated Text": [LONG_BODY],
        "Label": ["real"],
    })
    with pytest.raises(ValueError, match="Label conflict"):
        records_from_frame(frame, "Fake.xlsx", "Sheet1")


def test_short_articles_are_excluded_instead_of_being_treated_as_full_text():
    frame = pd.DataFrame({
        "Original Headline": ["Short"],
        "English Translated Text": ["Only a short snippet."],
        "Label": ["real"],
    })
    records, stats = records_from_frame(frame, "Real.xlsx", "Sheet1")
    assert records == []
    assert stats["rejected_short_or_partial"] == 1
