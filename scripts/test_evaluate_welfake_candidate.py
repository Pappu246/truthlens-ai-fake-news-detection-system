"""Regression tests for the task-matched WELFake evaluation utility."""
from scripts.evaluate_welfake_candidate import neutralize_source_attribution


def test_removes_common_wire_service_byline_and_title_suffix():
    result = neutralize_source_attribution(
        "Jobs report surprises markets - Reuters",
        "WASHINGTON (Reuters) - Employers added jobs after the monthly report."
    )
    assert result == "Jobs report surprises markets Employers added jobs after the monthly report."


def test_removes_wire_service_lead_without_city():
    result = neutralize_source_attribution(
        "News title",
        "Reuters - The agency published the annual results today."
    )
    assert result == "News title The agency published the annual results today."


def test_does_not_remove_publisher_mentioned_inside_factual_prose():
    body = "Researchers cited Reuters data in the report. The data were published in March."
    assert neutralize_source_attribution("Research report", body) == "Research report " + body


def test_ablation_does_not_delete_the_actual_claim_predicate_or_number():
    result = neutralize_source_attribution(
        "Unemployment rate declined - Reuters",
        "WASHINGTON (Reuters) - The unemployment rate fell to 4.1 percent in March."
    )
    assert "fell to 4.1 percent" in result
    assert "Reuters" not in result
