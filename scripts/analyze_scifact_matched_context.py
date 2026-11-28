#!/usr/bin/env python3
"""Claim-clustered paired uncertainty analysis for the SciFact context diagnostic.

This is a research-only analysis of gold-rationale oracle pairs. It does not
measure open retrieval, production verdict accuracy, or release readiness.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

LABELS = ("SUPPORTS", "REFUTES")
PROTOCOL = "truthlens-v2-scifact-matched-context-v1"
OUTPUT_PROTOCOL = "truthlens-v2-scifact-matched-context-bootstrap-v1"


def _metrics(rows: list[dict[str, Any]], prediction_key: str) -> dict[str, float]:
    if not rows:
        raise ValueError("Cannot calculate metrics on an empty paired sample")
    correct = sum(row[prediction_key] == row["gold"] for row in rows)
    per_class: list[float] = []
    for label in LABELS:
        tp = sum(row["gold"] == label and row[prediction_key] == label for row in rows)
        fp = sum(row["gold"] != label and row[prediction_key] == label for row in rows)
        fn = sum(row["gold"] == label and row[prediction_key] != label for row in rows)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        per_class.append(2 * precision * recall / (precision + recall) if precision + recall else 0.0)
    return {"accuracy": correct / len(rows), "macro_f1": sum(per_class) / len(LABELS)}


def _percentile(values: list[float], probability: float) -> float:
    if not values:
        raise ValueError("Bootstrap produced no samples")
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def analyze(report: dict[str, Any], resamples: int = 10_000, seed: int = 20_261_128) -> dict[str, Any]:
    if report.get("protocol_version") != PROTOCOL:
        raise ValueError(f"Expected protocol_version={PROTOCOL!r}")
    rows = report.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("Input report must contain non-empty rows")
    if not isinstance(resamples, int) or resamples < 100:
        raise ValueError("resamples must be an integer >= 100")

    clusters: dict[str, list[dict[str, Any]]] = defaultdict(list)
    controls = Counter()
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or row.get("claim_id") is None:
            raise ValueError(f"Row {index} must be an object with claim_id")
        if row.get("gold") not in LABELS:
            raise ValueError(f"Row {index} has unsupported gold label")
        for key in ("rationale_prediction", "context_window_prediction"):
            if row.get(key) not in (*LABELS, "NEUTRAL", "UNCLEAR"):
                raise ValueError(f"Row {index} has invalid {key}")
        clusters[str(row["claim_id"])].append(row)
        control = row.get("context_only_control_prediction")
        if control is not None:
            if control not in (*LABELS, "NEUTRAL", "UNCLEAR"):
                raise ValueError(f"Row {index} has invalid context-only control prediction")
            controls[control] += 1

    claim_ids = sorted(clusters)
    if len(claim_ids) < 2:
        raise ValueError("At least two distinct claim clusters are required")

    rationale_key, context_key = "rationale_prediction", "context_window_prediction"
    rationale_observed = _metrics(rows, rationale_key)
    context_observed = _metrics(rows, context_key)
    observed_delta = {
        metric: context_observed[metric] - rationale_observed[metric]
        for metric in ("accuracy", "macro_f1")
    }
    rng = random.Random(seed)
    boot = {
        condition: {metric: [] for metric in ("accuracy", "macro_f1")}
        for condition in ("rationale", "context", "delta_context_minus_rationale")
    }
    for _ in range(resamples):
        sampled_ids = [claim_ids[rng.randrange(len(claim_ids))] for _ in claim_ids]
        sample = [row for claim_id in sampled_ids for row in clusters[claim_id]]
        r_metrics = _metrics(sample, rationale_key)
        c_metrics = _metrics(sample, context_key)
        for metric in ("accuracy", "macro_f1"):
            boot["rationale"][metric].append(r_metrics[metric])
            boot["context"][metric].append(c_metrics[metric])
            boot["delta_context_minus_rationale"][metric].append(c_metrics[metric] - r_metrics[metric])

    def summary(observed: dict[str, float], samples: dict[str, list[float]]) -> dict[str, Any]:
        return {
            metric: {
                "estimate": observed[metric],
                "ci_95_percentile": [
                    _percentile(samples[metric], 0.025),
                    _percentile(samples[metric], 0.975),
                ],
            }
            for metric in ("accuracy", "macro_f1")
        }

    dataset = report.get("dataset") or {}
    provenance = report.get("run_provenance") or {}
    return {
        "protocol_version": OUTPUT_PROTOCOL,
        "analysis_only": True,
        "task": "Claim-clustered paired bootstrap uncertainty for gold-rationale SciFact context diagnostics",
        "source": {
            "protocol_version": report["protocol_version"],
            "source_commit_sha": provenance.get("source_commit_sha"),
            "source_ref": provenance.get("source_ref"),
            "claims_sha256": dataset.get("claims_sha256"),
            "corpus_sha256": dataset.get("corpus_sha256"),
        },
        "sampling": {
            "bootstrap_unit": "claim_id; all rationale/document pairs for a sampled claim are kept together",
            "distinct_claim_clusters": len(claim_ids),
            "paired_rationale_document_rows": len(rows),
            "resamples": resamples,
            "seed": seed,
            "interval": "two-sided 95% percentile interval; exploratory, not a release gate",
        },
        "paired_metrics": {
            "rationale_only": summary(rationale_observed, boot["rationale"]),
            "rationale_centered_context": summary(context_observed, boot["context"]),
            "delta_context_minus_rationale": summary(observed_delta, boot["delta_context_minus_rationale"]),
        },
        "context_only_control": {
            "label_counts": {label: controls.get(label, 0) for label in ("SUPPORTS", "REFUTES", "NEUTRAL", "UNCLEAR")},
            "note": "Unlabelled control; no accuracy, F1, or correctness claim is computed.",
        },
        "interpretation_limits": [
            "All evidence pairs use gold-annotated SciFact rationales; this is an oracle component diagnostic, not open retrieval.",
            "The bootstrap resamples claim clusters to account for multiple rationale/document pairs from the same claim.",
            "Macro-F1 is averaged over SUPPORTS and REFUTES because this rationale-pair subset contains only those two gold labels; it is not the three-class end-to-end macro-F1.",
            "Intervals quantify sampling variability on the SciFact dev diagnostic only; they do not establish external generalization or production readiness.",
            "No production model, retrieval, threshold, verdict policy, source rule, or deployment setting is changed.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Matched-context JSON report")
    parser.add_argument("--output", required=True, help="Output JSON path")
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
            "claim_clusters": result["sampling"]["distinct_claim_clusters"],
            "paired_rows": result["sampling"]["paired_rationale_document_rows"],
            "resamples": result["sampling"]["resamples"],
            "delta_accuracy": result["paired_metrics"]["delta_context_minus_rationale"]["accuracy"],
            "delta_macro_f1": result["paired_metrics"]["delta_context_minus_rationale"]["macro_f1"],
            "output": str(output),
        }, indent=2))
        return 0
    except (OSError, json.JSONDecodeError, ValueError, KeyError) as exc:
        print(f"matched-context bootstrap analysis failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
