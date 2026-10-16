"""Regression tests for the task-matched WELFake evaluation utility."""
import numpy as np

from scripts.evaluate_welfake_candidate import (
    compute_runtime_policy_metrics,
    neutralize_source_attribution,
)


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



def test_runtime_policy_reports_abstention_separately_and_counts_it_as_not_correct():
    report = compute_runtime_policy_metrics(
        np.asarray([0, 0, 1, 1]),
        np.asarray([0.10, 0.50, 0.80, 0.20]),
    )
    assert report["fake_threshold"] == 0.65
    assert report["real_threshold"] == 0.35
    assert report["coverage"] == 0.75
    assert report["abstention_rate"] == 0.25
    assert report["abstained_real_samples"] == 1
    assert report["fake_recall_all_fake_samples"] == 0.5
    assert report["real_recall_all_real_samples"] == 0.5
    assert report["operational_balanced_accuracy_abstentions_count_as_not_correct"] == 0.5


def test_runtime_policy_does_not_reward_abstaining_on_every_article():
    report = compute_runtime_policy_metrics(
        np.asarray([0, 1, 0, 1]),
        np.asarray([0.50, 0.50, 0.50, 0.50]),
    )
    assert report["coverage"] == 0.0
    assert report["abstention_rate"] == 1.0
    assert report["operational_balanced_accuracy_abstentions_count_as_not_correct"] == 0.0
    assert report["selective_accuracy_on_decided_only"] is None
