import copy
import unittest

from analyze_scifact_matched_context import analyze


class MatchedContextBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.report = {
            "protocol_version": "truthlens-v2-scifact-matched-context-v1",
            "run_provenance": {"source_commit_sha": "a" * 40, "source_ref": "refs/pull/1/merge"},
            "dataset": {"claims_sha256": "b" * 64, "corpus_sha256": "c" * 64},
            "rows": [
                {"claim_id": 1, "gold": "SUPPORTS", "rationale_prediction": "SUPPORTS", "context_window_prediction": "NEUTRAL", "context_only_control_prediction": "NEUTRAL"},
                {"claim_id": 1, "gold": "REFUTES", "rationale_prediction": "REFUTES", "context_window_prediction": "REFUTES", "context_only_control_prediction": "NEUTRAL"},
                {"claim_id": 2, "gold": "SUPPORTS", "rationale_prediction": "NEUTRAL", "context_window_prediction": "SUPPORTS", "context_only_control_prediction": None},
                {"claim_id": 3, "gold": "REFUTES", "rationale_prediction": "NEUTRAL", "context_window_prediction": "NEUTRAL", "context_only_control_prediction": "UNCLEAR"},
            ],
        }

    def test_deterministic_claim_cluster_bootstrap(self):
        first = analyze(self.report, resamples=500, seed=7)
        self.assertEqual(first, analyze(self.report, resamples=500, seed=7))
        self.assertEqual(first["sampling"]["distinct_claim_clusters"], 3)
        self.assertEqual(first["sampling"]["paired_rationale_document_rows"], 4)
        self.assertEqual(first["paired_metrics"]["rationale_only"]["accuracy"]["estimate"], 0.5)
        self.assertEqual(first["paired_metrics"]["rationale_centered_context"]["accuracy"]["estimate"], 0.5)
        self.assertEqual(first["paired_metrics"]["delta_context_minus_rationale"]["accuracy"]["estimate"], 0.0)
        self.assertEqual(first["context_only_control"]["label_counts"]["NEUTRAL"], 2)
        self.assertNotIn("accuracy", first["context_only_control"])

    def test_rejects_unknown_protocol(self):
        report = copy.deepcopy(self.report)
        report["protocol_version"] = "unknown"
        with self.assertRaises(ValueError):
            analyze(report, resamples=100)

    def test_rejects_missing_claim_cluster(self):
        report = copy.deepcopy(self.report)
        del report["rows"][0]["claim_id"]
        with self.assertRaises(ValueError):
            analyze(report, resamples=100)

    def test_rejects_single_cluster(self):
        report = copy.deepcopy(self.report)
        for row in report["rows"]:
            row["claim_id"] = 1
        with self.assertRaises(ValueError):
            analyze(report, resamples=100)

    def test_rejects_too_few_resamples(self):
        with self.assertRaises(ValueError):
            analyze(self.report, resamples=99)


if __name__ == "__main__":
    unittest.main()
