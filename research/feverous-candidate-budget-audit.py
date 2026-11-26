#!/usr/bin/env python3
"""Compare FEVEROUS candidate budgets against a same-claim baseline."""
from __future__ import annotations
import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any

def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        raise ValueError(f"empty candidate file: {path}")
    return rows

def gold_groups(value: Any) -> list[set[str]]:
    groups: list[set[str]] = []
    if not isinstance(value, list):
        return groups
    for group in value:
        if not isinstance(group, dict):
            continue
        content = group.get("content")
        if isinstance(content, list):
            ids = {item for item in content if isinstance(item, str) and item}
            if ids:
                groups.append(ids)
    return groups

def percentile(values: list[int], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    pos = (len(ordered) - 1) * p
    lo, hi = math.floor(pos), math.ceil(pos)
    if lo == hi:
        return float(ordered[lo])
    return ordered[lo] * (hi - pos) + ordered[hi] * (pos - lo)

def score(rows: list[dict[str, Any]]) -> dict[str, Any]:
    denominator = any_hit = complete_group_hit = gold_element_total = gold_element_hit = 0
    counts: list[int] = []
    for row in rows:
        candidates = row.get("candidates") or []
        candidate_ids = {
            str(item.get("feverous_id"))
            for item in candidates
            if isinstance(item, dict) and item.get("feverous_id")
        }
        counts.append(len(candidates))
        groups = gold_groups(row.get("gold_evidence"))
        if not groups:
            continue
        denominator += 1
        all_gold = set().union(*groups)
        hits = all_gold & candidate_ids
        gold_element_total += len(all_gold)
        gold_element_hit += len(hits)
        if hits:
            any_hit += 1
        if any(group.issubset(candidate_ids) for group in groups):
            complete_group_hit += 1
    return {
        "claims": len(rows),
        "gold_evidence_claims": denominator,
        "claim_any_gold_element_hits": any_hit,
        "claim_any_gold_element_recall": any_hit / denominator if denominator else None,
        "claims_with_complete_gold_group": complete_group_hit,
        "complete_gold_group_recall": complete_group_hit / denominator if denominator else None,
        "gold_elements_recalled": gold_element_hit,
        "gold_elements_total": gold_element_total,
        "gold_element_recall": gold_element_hit / gold_element_total if gold_element_total else None,
        "candidate_count": {
            "mean": statistics.mean(counts) if counts else 0,
            "median": statistics.median(counts) if counts else 0,
            "p95": percentile(counts, 0.95),
            "max": max(counts, default=0)
        }
    }

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--medium", required=True, type=Path)
    parser.add_argument("--small", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    files = {"baseline_25x50": args.baseline, "medium_10x20": args.medium, "small_5x10": args.small}
    datasets = {name: read_jsonl(path) for name, path in files.items()}
    baseline_ids = [(row.get("id"), row.get("claim"), row.get("label")) for row in datasets["baseline_25x50"]]
    for name, rows in datasets.items():
        ids = [(row.get("id"), row.get("claim"), row.get("label")) for row in rows]
        if ids != baseline_ids:
            raise ValueError(f"sample mismatch between baseline and {name}")
    metrics = {name: score(rows) for name, rows in datasets.items()}
    baseline = metrics["baseline_25x50"]
    comparisons = {}
    for name, result in metrics.items():
        comparisons[name] = {
            **result,
            "retention_vs_baseline": {
                key: (
                    result[key] / baseline[key]
                    if baseline.get(key) not in (None, 0) and result.get(key) is not None
                    else None
                )
                for key in ("claim_any_gold_element_recall", "complete_gold_group_recall", "gold_element_recall")
            }
        }
    eligible_smaller = []
    for name, result in comparisons.items():
        if name == "baseline_25x50":
            continue
        retention = result["retention_vs_baseline"]
        if all(
            retention[key] is not None and retention[key] >= threshold
            for key, threshold in (
                ("claim_any_gold_element_recall", 0.97),
                ("complete_gold_group_recall", 0.90),
                ("gold_element_recall", 0.90)
            )
        ):
            eligible_smaller.append((result["candidate_count"]["mean"], name))
    recommended = min(eligible_smaller)[1] if eligible_smaller else None
    report = {
        "protocol": "feverous-candidate-budget-audit-v1",
        "sample_method": "deterministic evenly spaced across full FEVEROUS dev split",
        "thresholds_vs_baseline": {
            "claim_any_gold_element_recall_retention": 0.97,
            "complete_gold_group_recall_retention": 0.90,
            "gold_element_recall_retention": 0.90
        },
        "budgets": comparisons,
        "recommended_budget": recommended,
        "decision": "CANDIDATE_BUDGET_IDENTIFIED" if recommended else "NO_SMALLER_BUDGET_MEETS_RECALL_GATES",
        "limitations": [
            "This is a deterministic sample-based retrieval-budget diagnostic, not the full FEVEROUS benchmark.",
            "Recall is measured against annotated evidence element IDs; it does not measure NLI correctness.",
            "The baseline is the existing 25-pages x 50-elements-per-page candidate builder configuration."
        ]
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()
