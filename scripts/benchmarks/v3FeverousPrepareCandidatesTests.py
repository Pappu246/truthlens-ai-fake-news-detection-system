#!/usr/bin/env python3
"""Small regression for the FEVEROUS candidate-preparation pipeline."""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("v3FeverousPrepareCandidates.py").resolve()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="truthlens-feverous-test-") as temp:
        root = Path(temp)
        db_path = root / "wiki.db"
        claims_path = root / "claims.jsonl"
        output_path = root / "candidates.jsonl"

        pages = [
            {
                "order": ["sentence_0", "sentence_1"],
                "sentence_0": "Apollo 11 landed on the Moon on July 20 1969.",
                "sentence_1": "The crew returned safely to Earth."
            },
            {
                "order": ["sentence_0"],
                "sentence_0": "Apollo 12 was a later crewed lunar mission in November 1969."
            }
        ]
        con = sqlite3.connect(db_path)
        con.execute("CREATE TABLE wiki (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        con.executemany(
            "INSERT INTO wiki(id, data) VALUES(?, ?)",
            [(f"page-{i}", json.dumps(page)) for i, page in enumerate(pages)]
        )
        con.commit()
        con.close()

        claims = [
            {"id": "claim-1", "claim": "Apollo 11 landed on the Moon", "label": "SUPPORTS", "evidence": []},
            {"id": "claim-2", "claim": "Apollo 12 was a later lunar mission", "label": "SUPPORTS", "evidence": []}
        ]
        claims_path.write_text("".join(json.dumps(row) + "\n" for row in claims), encoding="utf-8")

        subprocess.run(
            [
                sys.executable, str(SCRIPT),
                f"--db={db_path}",
                f"--claims={claims_path}",
                f"--output={output_path}",
                "--top-pages=5",
                "--elements-per-page=10"
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=60
        )

        lines = output_path.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 2, f"Expected two JSONL records, found {len(lines)}"
        records = [json.loads(line) for line in lines]
        assert [row["id"] for row in records] == ["claim-1", "claim-2"]
        assert all(row["candidates"] for row in records), "FTS retrieval returned no candidates"

        indexed = sqlite3.connect(f"{db_path}.fts.sqlite")
        try:
            fts_count = indexed.execute("SELECT COUNT(*) FROM pages_fts").fetchone()[0]
            assert fts_count == 2, f"Expected 2 indexed pages, found {fts_count}"
        finally:
            indexed.close()

    print("FEVEROUS candidate preparation regression: PASS (JSONL, row boundaries, incremental FTS5)")


if __name__ == "__main__":
    main()
