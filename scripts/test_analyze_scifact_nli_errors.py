import copy
import unittest

from analyze_scifact_nli_errors import analyze


class ScifactNliErrorAuditTests(unittest.TestCase):
    def setUp(self):
        self.report = {
            "protocol_version": "truthlens-v2-scifact-end-to-end-v2",
            "benchmark": True,
            "run_provenance": {"source_commit_sha": "a" * 40, "source_ref": "refs/pull/1/merge", "workflow_run_id": "123"},
            "dataset": {
                "claims_evaluated": 4,
                "claims_sha256": "86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217",
                "corpus_sha256": "b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62",
            },
            "rows": [
                {"id": 1, "gold": "SUPPORT", "benchmark_prediction": "CONTRADICT", "evidence_trace": [
                    {"nli_label": "REFUTES", "research_trace": {"relatedness_cosine": 0.49, "raw_probabilities": {"entailment": 0.02, "contradiction": 0.90, "neutral": 0.08}}, "research_decision_trace": {"contributes_to_directional_tally": True}},
                    {"nli_label": "NEUTRAL", "research_trace": {"relatedness_cosine": 0.22, "raw_probabilities": {"entailment": 0.1, "contradiction": 0.2, "neutral": 0.7}}, "research_decision_trace": {"contributes_to_directional_tally": False}},
                ]},
                {"id": 2, "gold": "SUPPORT", "benchmark_prediction": "SUPPORT", "evidence_trace": [
                    {"nli_label": "SUPPORTS", "research_trace": {"relatedness_cosine": 0.7, "raw_probabilities": {"entailment": 0.8, "contradiction": 0.1, "neutral": 0.1}}, "research_decision_trace": {"contributes_to_directional_tally": True}},
                ]},
                {"id": 3, "gold": "CONTRADICT", "benchmark_prediction": "CONTRADICT", "evidence_trace": [
                    {"nli_label": "REFUTES", "research_trace": {"relatedness_cosine": 0.51, "raw_probabilities": {"entailment": 0.01, "contradiction": 0.91, "neutral": 0.08}}, "research_decision_trace": {"contributes_to_directional_tally": True}},
                ]},
                {"id": 4, "gold": "NOT_ENOUGH_INFO", "benchmark_prediction": "CONTRADICT", "evidence_trace": [
                    {"nli_label": "REFUTES", "research_trace": {"relatedness_cosine": 0.4, "raw_probabilities": {"entailment": 0.03, "contradiction": 0.85, "neutral": 0.12}}, "research_decision_trace": {"contributes_to_directional_tally": True}},
                ]},
            ],
        }

    def test_claim_level_rates_and_grouped_trace_statistics(self):
        result = analyze(self.report, resamples=500, seed=5)
        self.assertEqual(result["headline_error_rates"]["gold_support_predicted_contradict"]["numerator"], 1)
        self.assertEqual(result["headline_error_rates"]["gold_support_predicted_contradict"]["denominator"], 2)
        false_group = result["trace_groups"]["gold_support_predicted_contradict"]
        self.assertEqual(false_group["claims"], 1)
        self.assertEqual(false_group["evidence_label_counts"]["REFUTES"], 1)
        self.assertAlmostEqual(false_group["evidence_level_refute_mean_raw_contradiction_probability"], 0.90)
        self.assertAlmostEqual(false_group["evidence_level_refute_mean_relatedness_cosine"], 0.49)
        delta = result["paired_claim_cluster_differences_false_vs_true_refute"]["raw_contradiction_probability"]
        self.assertAlmostEqual(delta["delta_false_minus_true_estimate"], -0.01)

    def test_deterministic_bootstrap(self):
        first = analyze(self.report, resamples=500, seed=8)
        self.assertEqual(first, analyze(self.report, resamples=500, seed=8))

    def test_rejects_wrong_dataset_hash(self):
        report = copy.deepcopy(self.report)
        report["dataset"]["claims_sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            analyze(report, resamples=100)

    def test_rejects_non_benchmark_artifact(self):
        report = copy.deepcopy(self.report)
        report["benchmark"] = False
        with self.assertRaises(ValueError):
            analyze(report, resamples=100)

    def test_rejects_malformed_probability_trace(self):
        report = copy.deepcopy(self.report)
        report["rows"][0]["evidence_trace"][0]["research_trace"]["raw_probabilities"]["contradiction"] = "high"
        with self.assertRaises(ValueError):
            analyze(report, resamples=100)


if __name__ == "__main__":
    unittest.main()
