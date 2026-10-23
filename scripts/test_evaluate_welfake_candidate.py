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



def test_runtime_policy_uses_frozen_production_thresholds_and_counts_abstentions_as_not_correct():
    report = compute_runtime_policy_metrics(
        np.asarray([0, 0, 1, 1]),
        np.asarray([0.35, 0.36, 0.98, 0.97]),
        coverage_ratio=np.asarray([0.90, 0.90, 0.90, 0.90]),
        candidate_term_count=np.asarray([200, 200, 200, 200]),
    )
    assert report["fake_threshold"] == 0.98
    assert report["real_threshold"] == 0.35
    assert report["coverage"] == 0.5
    assert report["abstention_rate"] == 0.5
    assert report["abstained_real_samples"] == 1
    assert report["abstained_fake_samples"] == 1
    assert report["fake_recall_all_fake_samples"] == 0.5
    assert report["real_recall_all_real_samples"] == 0.5
    assert report["operational_balanced_accuracy_abstentions_count_as_not_correct"] == 0.5


def test_runtime_policy_rejects_threshold_drift_from_production():
    import pytest

    with pytest.raises(ValueError, match="frozen production policy"):
        compute_runtime_policy_metrics(
            np.asarray([0, 1]), np.asarray([0.1, 0.9]),
            fake_threshold=0.65, real_threshold=0.35,
        )


def test_runtime_policy_does_not_reward_abstaining_on_every_article():
    report = compute_runtime_policy_metrics(
        np.asarray([0, 1, 0, 1]),
        np.asarray([0.50, 0.50, 0.50, 0.50]),
    )
    assert report["coverage"] == 0.0
    assert report["abstention_rate"] == 1.0
    assert report["operational_balanced_accuracy_abstentions_count_as_not_correct"] == 0.0
    assert report["selective_accuracy_on_decided_only"] is None


def test_runtime_policy_mirrors_low_vocabulary_abstention():
    report = compute_runtime_policy_metrics(
        np.asarray([0, 1]),
        np.asarray([0.10, 0.99]),
        texts=["real item", "fake item"],
        coverage_ratio=np.asarray([0.01, 0.90]),
        candidate_term_count=np.asarray([200, 200]),
    )
    assert report["coverage"] == 0.5
    assert report["low_vocabulary_abstentions"] == 1
    assert report["abstained_real_samples"] == 1
    assert report["fake_recall_all_fake_samples"] == 1.0
    assert report["real_recall_all_real_samples"] == 0.0


def test_runtime_policy_mirrors_short_input_and_low_coverage_guard():
    report = compute_runtime_policy_metrics(
        np.asarray([1, 1, 1]),
        np.asarray([0.99, 0.99, 0.99]),
        texts=["short low coverage", "long low coverage", "short good coverage"],
        coverage_ratio=np.asarray([0.30, 0.30, 0.90]),
        candidate_term_count=np.asarray([80, 150, 80]),
    )
    # Only the short + low-coverage item abstains; high probability cannot
    # override the deployed OOD guard, while either single condition alone
    # does not trigger that specific guard.
    assert report["short_low_coverage_abstentions"] == 1
    assert report["coverage"] == 2 / 3
    assert report["abstained_fake_samples"] == 1
    assert report["fake_recall_all_fake_samples"] == 2 / 3


def test_runtime_policy_does_not_abstain_on_short_but_well_covered_input():
    report = compute_runtime_policy_metrics(
        np.asarray([0]),
        np.asarray([0.10]),
        texts=["A whistleblower exposed secret records in a report after the committee released a statement."],
        coverage_ratio=np.asarray([0.90]),
        candidate_term_count=np.asarray([18]),
    )
    assert report["coverage"] == 1.0
    assert report["short_low_coverage_abstentions"] == 0
    assert report["real_recall_all_real_samples"] == 1.0


def test_research_style_conflict_rule_abstains_on_real_leaning_sensational_text():
    report = compute_runtime_policy_metrics(
        np.asarray([1]),
        np.asarray([0.10]),
        texts=[
            "SHOCKING SECRET EXPOSED by alien whistleblower! The conspiracy is hidden. "
            "This is an undeniable guaranteed miracle."
        ],
        coverage_ratio=np.asarray([0.90]),
        candidate_term_count=np.asarray([180]),
        sensational_conflict_guard_enabled=True,
    )
    assert report["sensational_conflict_guard"]["enabled"] is True
    assert report["sensational_conflict_abstentions"] == 1
    assert report["coverage"] == 0.0
    assert report["fake_recall_all_fake_samples"] == 0.0


def test_research_style_conflict_rule_never_overrides_high_fake_probability():
    report = compute_runtime_policy_metrics(
        np.asarray([1]),
        np.asarray([0.99]),
        texts=[
            "SHOCKING SECRET EXPOSED by alien whistleblower! The conspiracy is hidden. "
            "This is an undeniable guaranteed miracle."
        ],
        coverage_ratio=np.asarray([0.90]),
        candidate_term_count=np.asarray([180]),
        sensational_conflict_guard_enabled=True,
    )
    assert report["sensational_conflict_abstentions"] == 0
    assert report["coverage"] == 1.0
    assert report["fake_recall_all_fake_samples"] == 1.0
