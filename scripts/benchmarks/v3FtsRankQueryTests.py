#!/usr/bin/env python3
"""Regression tests for SQLite FTS5 top-k ranking used by phase 2 candidate builders."""
from __future__ import annotations

import math
import sqlite3
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="truthlens-ft5-rank-") as temp:
        db = sqlite3.connect(Path(temp) / "rank.sqlite")
        db.execute("CREATE VIRTUAL TABLE docs USING fts5(title, body)")
        db.executemany(
            "INSERT INTO docs(title, body) VALUES(?, ?)",
            [
                ("Moon", "Apollo 11 landed on the Moon in July 1969"),
                ("Space", "Apollo missions explored the Moon"),
                ("History", "The mission landed on the Moon"),
                ("Ocean", "The Pacific Ocean is large"),
                ("Apollo", "Apollo 11 was the first lunar landing"),
            ],
        )
        query = '"apollo" OR "moon" OR "landed"'
        bm25 = db.execute(
            "SELECT rowid, bm25(docs) AS score FROM docs "
            "WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT 3",
            (query,),
        ).fetchall()
        rank = db.execute(
            "SELECT rowid, rank AS score FROM docs "
            "WHERE docs MATCH ? ORDER BY rank LIMIT 3",
            (query,),
        ).fetchall()
        assert [row[0] for row in bm25] == [row[0] for row in rank], (bm25, rank)
        assert all(math.isclose(a[1], b[1], rel_tol=1e-10, abs_tol=1e-12)
                   for a, b in zip(bm25, rank)), (bm25, rank)
        db.close()

    fever = (ROOT / "scripts/benchmarks/v3FeverPrepareCandidates.py").read_text()
    feverous = (ROOT / "scripts/benchmarks/v3FeverousPrepareCandidates.py").read_text()
    assert "ORDER BY rank" in fever and "ORDER BY bm25(" not in fever
    assert "ORDER BY rank" in feverous and "ORDER BY bm25(" not in feverous
    print("FTS rank-query regression: PASS (rank equals BM25 and uses ordered top-k retrieval)")


if __name__ == "__main__":
    main()
