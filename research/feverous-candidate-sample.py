#!/usr/bin/env python3
"""Create a deterministic, evenly spaced FEVEROUS claim sample."""
from __future__ import annotations
import argparse
import json
from pathlib import Path

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--sample-size", type=int, default=200)
    args = parser.parse_args()
    rows = [line for line in args.input.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        raise SystemExit("FEVEROUS claims input is empty")
    if args.sample_size < 2 or args.sample_size > len(rows):
        raise SystemExit(f"sample-size must be between 2 and {len(rows)}")
    indices = [round(i * (len(rows) - 1) / (args.sample_size - 1)) for i in range(args.sample_size)]
    if len(set(indices)) != args.sample_size:
        raise SystemExit("Sampling produced duplicate row indices")
    selected = [rows[i] for i in indices]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(selected) + "\n", encoding="utf-8")
    first = json.loads(selected[0])
    last = json.loads(selected[-1])
    print(json.dumps({
        "total_claims": len(rows),
        "sample_claims": len(selected),
        "sampling": "deterministic_evenly_spaced",
        "first_claim_id": first.get("id", first.get("annotation_id", first.get("claim_id"))),
        "last_claim_id": last.get("id", last.get("annotation_id", last.get("claim_id"))),
        "output": str(args.output)
    }, indent=2))

if __name__ == "__main__":
    main()
