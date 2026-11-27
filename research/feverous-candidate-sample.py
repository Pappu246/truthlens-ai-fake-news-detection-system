#!/usr/bin/env python3
"""Create a deterministic, evenly spaced FEVEROUS claim sample."""
from __future__ import annotations
import argparse
import json
from pathlib import Path

VALID_LABELS = {"SUPPORTS", "REFUTES", "NOT ENOUGH INFO"}

def valid_claim(row: object) -> bool:
    if not isinstance(row, dict):
        return False
    claim_id = row.get("id") or row.get("annotation_id") or row.get("claim_id")
    claim = row.get("claim")
    label = row.get("label")
    return bool(str(claim_id or "").strip()) and isinstance(claim, str) and bool(claim.strip()) and label in VALID_LABELS

def load_claim_rows(path: Path) -> list[tuple[str, dict]]:
    rows: list[tuple[str, dict]] = []
    raw_lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    for line_number, line in enumerate(raw_lines, 1):
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid JSON at line {line_number}: {error}") from error
        if valid_claim(row):
            rows.append((line, row))
        elif line_number == 1 and not valid_claim(row):
            # The frozen Zenodo JSONL starts with a non-claim preamble row.
            continue
        else:
            raise ValueError(f"Malformed FEVEROUS claim row at line {line_number}")
    return rows

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--sample-size", type=int, default=200)
    parser.add_argument("--expected-claims", type=int, default=7890)
    args = parser.parse_args()
    rows = load_claim_rows(args.input)
    if len(rows) != args.expected_claims:
        raise SystemExit(f"Expected {args.expected_claims} valid FEVEROUS claims, found {len(rows)}")
    if args.sample_size < 2 or args.sample_size > len(rows):
        raise SystemExit(f"sample-size must be between 2 and {len(rows)}")
    indices = [round(i * (len(rows) - 1) / (args.sample_size - 1)) for i in range(args.sample_size)]
    if len(set(indices)) != args.sample_size:
        raise SystemExit("Sampling produced duplicate row indices")
    selected = [rows[i] for i in indices]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(line for line, _ in selected) + "\n", encoding="utf-8")
    first = selected[0][1]
    last = selected[-1][1]
    print(json.dumps({
        "total_claims": len(rows),
        "sample_claims": len(selected),
        "sampling": "deterministic_evenly_spaced_valid_claims_only",
        "first_claim_id": first.get("id", first.get("annotation_id", first.get("claim_id"))),
        "last_claim_id": last.get("id", last.get("annotation_id", last.get("claim_id"))),
        "output": str(args.output)
    }, indent=2))

if __name__ == "__main__":
    main()
