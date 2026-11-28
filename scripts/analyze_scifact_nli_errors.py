#!/usr/bin/env python3
"""Claim-clustered error audit for SciFact end-to-end NLI evidence traces.

This diagnostic describes where the current NLI component emits false
contradictions. It does not tune thresholds or change production decisions.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path
from statistics import mean
from typing import Any

PROTOCOL = "truthlens-v2-scifact-end-to-end-v2"
OUTPUT_PROTOCOL = "truthlens-v2-scifact-nli-error-audit-v1"
EXPECTED_CLAIMS_SHA = "86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217"
EXPECTED_CORPUS_SHA = "b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62"
LABELS = ("SUPPORT", "CONTRADICT", "NOT_ENOUGH_INFO")


def _percentile(values: list[float], probability: float) -> float:
    if not values:
        raise ValueError("No bootstrap samples")
    ordered = sorted(values)
    pos = (len(ordered) - 1) * probability
    lo = int(pos)
    hi = min(lo + 1, len(ordered) - 1)
    frac = pos - lo
    return ordered[lo] * (1 - frac) + ordered[hi] * frac


def _ci(values: list[float], resamples: int, seed: int) -> list[float]:
    if not values:
        return [0.0, 0.0]
    rng = random.Random(seed)
    samples = [
        mean(values[rng.randrange(len(values))] for _ in values)
        for _ in range(resamples)
    ]
    return [_percentile(samples, 0.025), _percentile(samples, 0.975)]


def _claim_group_stats(rows: list[dict[str, Any]]) -> dict[str, Any]:
    label_counts = Counter()
    evidence_rows: list[dict[str, Any]] = []
    claim_refute_rates: list[float] = []
    claim_contradiction_means: list[float] = []
    claim_cosine_means: list[float] = []
    claims_with_refute_vote = 0

    for row in rows:
        traces = []
        for entry in row.get("evidence_trace", []):
            label = entry.get("nli_label")
            label_counts[label] += 1
            trace = entry.get("research_trace") or {}
            raw = trace.get("raw_probabilities")
            if not isinstance(raw, dict):
                continue
            if not all(isinstance(raw.get(key), (int, float)) for key in ("entailment", "contradiction", "neutral")):
                raise ValueError("Evidence trace contains malformed raw NLI probabilities")
            cosine = trace.get("relatedness_cosine")
            if not isinstance(cosine, (int, float)):
                raise ValueError("Evidence trace missing numeric relatedness cosine")
            traces.append({
                "label": label,
                "contradiction_probability": float(raw["contradiction"]),
                "relatedness_cosine": float(cosine),
                "contributes": bool((entry.get("research_decision_trace") or {}).get("contributes_to_directional_tally")),
            })
            evidence_rows.append(traces[-1])

        if traces:
            claim_refute_rates.append(sum(item["label"] == "REFUTES" for item in traces) / len(traces))
            refutes = [item for item in traces if item["label"] == "REFUTES"]
            if refutes:
                claim_contradiction_means.append(mean(item["contradiction_probability"] for item in refutes))
                claim_cosine_means.append(mean(item["relatedness_cosine"] for item in refutes))
            if any(item["label"] == "REFUTES" and item["contributes"] for item in traces):
                claims_with_refute_vote += 1

    return {
        "claims": len(rows),
        "claims_with_at_least_one_directional_refute_vote": claims_with_refute_vote,
        "evidence_label_counts": {label: label_counts.get(label, 0) for label in ("SUPPORTS", "REFUTES", "NEUTRAL", "UNCLEAR")},
        "claims_mean_refute_evidence_share": mean(claim_refute_rates) if claim_refute_rates else None,
        "claims_mean_raw_contradiction_probability_among_refutes": mean(claim_contradiction_means) if claim_contradiction_means else None,
        "claims_mean_relatedness_cosine_among_refutes": mean(claim_cosine_means) if claim_cosine_means else None,
        "evidence_level_refute_count": sum(item["label"] == "REFUTES" for item in evidence_rows),
        "evidence_level_refute_mean_raw_contradiction_probability": mean(item["contradiction_probability"] for item in evidence_rows if item["label"] == "REFUTES") if any(item["label"] == "REFUTES" for item in evidence_rows) else None,
        "evidence_level_refute_mean_relatedness_cosine": mean(item["relatedness_cosine"] for item in evidence_rows if item["label"] == "REFUTES") if any(item["label"] == "REFUTES" for item in evidence_rows) else None,
    }


def analyze(report: dict[str, Any], resamples: int = 10_000, seed: int = 20_261_128) -> dict[str, Any]:
    if report.get("protocol_version") != PROTOCOL or report.get("benchmark") is not True:
        raise ValueError("Input must be a completed SciFact end-to-end benchmark artifact")
    if not isinstance(resamples, int) or resamples < 100:
        raise ValueError("resamples must be an integer >= 100")
    provenance = report.get("run_provenance") or {}
    dataset = report.get("dataset") or {}
    if dataset.get("claims_sha256") != EXPECTED_CLAIMS_SHA or dataset.get("corpus_sha256") != EXPECTED_CORPUS_SHA:
        raise ValueError("SciFact dataset hashes do not match the frozen dev inputs")
    rows = report.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("Input artifact has no claim rows")
    if dataset.get("claims_evaluated") != len(rows):
        raise ValueError("Claim row count does not match dataset provenance")

    groups: dict[str, list[dict[str, Any]]] = {
        "gold_support_predicted_contradict": [r for r in rows if r.get("gold") == "SUPPORT" and r.get("benchmark_prediction") == "CONTRADICT"],
        "gold_contradict_predicted_contradict": [r for r in rows if r.get("gold") == "CONTRADICT" and r.get("benchmark_prediction") == "CONTRADICT"],
        "gold_not_enough_info_predicted_contradict": [r for r in rows if r.get("gold") == "NOT_ENOUGH_INFO" and r.get("benchmark_prediction") == "CONTRADICT"],
    }
    all_support = [r for r in rows if r.get("gold") == "SUPPORT"]
    all_nei = [r for r in rows if r.get("gold") == "NOT_ENOUGH_INFO"]
    if not all_support or not all_nei:
        raise ValueError("Expected SUPPORT and NOT_ENOUGH_INFO SciFact claims")

    group_stats = {name: _claim_group_stats(group) for name, group in groups.items()}
    support_false_rate = len(groups["gold_support_predicted_contradict"]) / len(all_support)
    nei_false_rate = len(groups["gold_not_enough_info_predicted_contradict"]) / len(all_nei)

    false_refute_claim_means = []
    true_refute_claim_means = []
    false_refute_cosines = []
    true_refute_cosines = []
    for name, target_means, target_cosines in (
        ("gold_support_predicted_contradict", false_refute_claim_means, false_refute_cosines),
        ("gold_contradict_predicted_contradict", true_refute_claim_means, true_refute_cosines),
    ):
        for row in groups[name]:
            refutes = [
                entry for entry in row.get("evidence_trace", [])
                if entry.get("nli_label") == "REFUTES"
                and isinstance((entry.get("research_trace") or {}).get("raw_probabilities"), dict)
            ]
            if refutes:
                target_means.append(mean(float(entry["research_trace"]["raw_probabilities"]["contradiction"]) for entry in refutes))
                target_cosines.append(mean(float(entry["research_trace"]["relatedness_cosine"]) for entry in refutes))

    rng = random.Random(seed)
    delta_contradiction_samples: list[float] = []
    delta_cosine_samples: list[float] = []
    if false_refute_claim_means and true_refute_claim_means:
        for _ in range(resamples):
            false_sample = mean(false_refute_claim_means[rng.randrange(len(false_refute_claim_means))] for _ in false_refute_claim_means)
            true_sample = mean(true_refute_claim_means[rng.randrange(len(true_refute_claim_means))] for _ in true_refute_claim_means)
            delta_contradiction_samples.append(false_sample - true_sample)
            false_cos = mean(false_refute_cosines[rng.randrange(len(false_refute_cosines))] for _ in false_refute_cosines)
            true_cos = mean(true_refute_cosines[rng.randrange(len(true_refute_cosines))] for _ in true_refute_cosines)
            delta_cosine_samples.append(false_cos - true_cos)

    def rate_record(numerator: int, denominator: int, seed_offset: int) -> dict[str, Any]:
        values = [1.0] * numerator + [0.0] * (denominator - numerator)
        return {"numerator": numerator, "denominator": denominator, "estimate": numerator / denominator, "ci_95_claim_bootstrap": _ci(values, resamples, seed + seed_offset)}

    return {
        "protocol_version": OUTPUT_PROTOCOL,
        "analysis_only": True,
        "task": "Claim-clustered audit of NLI contradiction errors in the frozen SciFact dev end-to-end trace",
        "source": {
            "source_commit_sha": provenance.get("source_commit_sha"),
            "source_ref": provenance.get("source_ref"),
            "workflow_run_id": provenance.get("workflow_run_id"),
            "claims_sha256": dataset.get("claims_sha256"),
            "corpus_sha256": dataset.get("corpus_sha256"),
        },
        "sampling": {
            "bootstrap_unit": "claim row; all top-k evidence traces remain grouped within each claim",
            "resamples": resamples,
            "seed": seed,
            "interval": "two-sided 95% percentile interval; exploratory diagnostic only",
        },
        "headline_error_rates": {
            "gold_support_predicted_contradict": rate_record(len(groups["gold_support_predicted_contradict"]), len(all_support), 11),
            "gold_not_enough_info_predicted_contradict": rate_record(len(groups["gold_not_enough_info_predicted_contradict"]), len(all_nei), 23),
        },
        "trace_groups": group_stats,
        "paired_claim_cluster_differences_false_vs_true_refute": {
            "raw_contradiction_probability": {
                "false_refute_claims": len(false_refute_claim_means),
                "true_refute_claims": len(true_refute_claim_means),
                "delta_false_minus_true_estimate": mean(false_refute_claim_means) - mean(true_refute_claim_means) if false_refute_claim_means and true_refute_claim_means else None,
                "ci_95_claim_bootstrap": [_percentile(delta_contradiction_samples, 0.025), _percentile(delta_contradiction_samples, 0.975)] if delta_contradiction_samples else None,
            },
            "relatedness_cosine": {
                "false_refute_claims": len(false_refute_cosines),
                "true_refute_claims": len(true_refute_cosines),
                "delta_false_minus_true_estimate": mean(false_refute_cosines) - mean(true_refute_cosines) if false_refute_cosines and true_refute_cosines else None,
                "ci_95_claim_bootstrap": [_percentile(delta_cosine_samples, 0.025), _percentile(delta_cosine_samples, 0.975)] if delta_cosine_samples else None,
            },
        },
        "interpretation_limits": [
            "The audit uses top-k evidence already selected by the frozen retrieval pipeline; it does not measure retrieval recall.",
            "Claims, not evidence passages, are the bootstrap unit; evidence pairs within a claim are not treated as independent.",
            "Similar cosine distributions do not prove semantic relevance or entailment; cosine is only a relatedness signal.",
            "A false CONTRADICT prediction can arise from retrieval, NLI, evidence aggregation, or benchmark annotation; this report does not attribute causality to NLI alone.",
            "No thresholds, models, weights, retrieval, verdict policy, or source rules are tuned or changed.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--resamples", type=int, default=10_000)
    parser.add_argument("--seed", type=int, default=20_261_128)
    args = parser.parse_args()
    try:
        report = json.loads(Path(args.input).read_text(encoding="utf-8"))
        result = analyze(report, args.resamples, args.seed)
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps({
            "status": "PASS",
            "source_commit_sha": result["source"]["source_commit_sha"],
            "claims": report["dataset"]["claims_evaluated"],
            "false_refute_rate": result["headline_error_rates"]["gold_support_predicted_contradict"]["estimate"],
            "nei_false_refute_rate": result["headline_error_rates"]["gold_not_enough_info_predicted_contradict"]["estimate"],
            "output": str(output),
        }, indent=2))
        return 0
    except (OSError, json.JSONDecodeError, ValueError, KeyError) as exc:
        print(f"SciFact NLI error audit failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
