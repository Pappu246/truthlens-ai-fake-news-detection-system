#!/usr/bin/env python3
"""Focused regression tests for bounded FEVER SQLite/FTS5 index validation."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sqlite3
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("v3FeverPrepareCandidates.py").resolve()
SPEC = importlib.util.spec_from_file_location("v3_fever_prepare_candidates", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> None:
    expected_query = '"apollo" AND "landed" AND "1969"'
    claim_text = "The Apollo Apollo landed on the Moon in July 1969 and Apollo 12"
    assert MODULE.fts_query(claim_text) == expected_query
    assert MODULE.fts_query(claim_text) == MODULE.fts_query(claim_text)
    assert '"not"' in MODULE.fts_query("Apollo was not the cause")
    long_query = MODULE.fts_query("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar")
    assert len(long_query.split(" AND ")) <= MODULE.MAX_QUERY_TERMS
    variants = MODULE.fts_query_variants(claim_text)
    assert variants == ['"apollo" AND "landed" AND "1969"', '"apollo" AND "landed"']
    assert MODULE.fts_query_variants("a") == []
    assert MODULE.fts_query_variants("Apollo") == ['"apollo"']

    with tempfile.TemporaryDirectory(prefix="truthlens-fever-index-test-") as temp:
        root = Path(temp)
        wiki_dir = root / "wiki"
        wiki_dir.mkdir()
        db_path = root / "fever.sqlite"
        shard = wiki_dir / "wiki-001.jsonl"
        pages = [
            {"id": "apollo", "lines": "0\tApollo 11 landed on the Moon in July 1969.\n1\tThe crew returned safely to Earth."},
            {"id": "lunar", "lines": "0\tApollo 12 was a later lunar mission in November 1969."},
        ]
        shard.write_text("\n".join(json.dumps(page) for page in pages) + "\n", encoding="utf-8")

        MODULE.build_index(wiki_dir, db_path)
        claims_path = root / "claims.jsonl"
        candidates_path = root / "candidates.jsonl"
        claims = [
            {"id": "claim-1", "claim": "Apollo 11 landed on the Moon in July 1969.", "label": "SUPPORTS", "evidence": []},
            {"id": "claim-2", "claim": "Apollo 12 was a later lunar mission in November 1969.", "label": "SUPPORTS", "evidence": []},
        ]
        claims_path.write_text("".join(json.dumps(row) + "\n" for row in claims), encoding="utf-8")
        old_interval = MODULE.PROGRESS_INTERVAL
        MODULE.PROGRESS_INTERVAL = 1
        captured = io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):
                MODULE.make_candidates(claims_path, db_path, candidates_path, top_k=5)
        finally:
            MODULE.PROGRESS_INTERVAL = old_interval
        progress = captured.getvalue()
        assert "FEVER candidate retrieval started" in progress
        assert "FEVER candidate retrieval progress: claims_processed=1" in progress
        assert "FEVER candidate retrieval complete: claims_processed=2" in progress
        candidate_rows = [json.loads(line) for line in candidates_path.read_text(encoding="utf-8").splitlines()]
        assert len(candidate_rows) == 2, f"Expected 2 candidate rows, found {len(candidate_rows)}"

        con = sqlite3.connect(db_path)
        try:
            actual = con.execute("SELECT COUNT(*) FROM sentences").fetchone()[0]
            assert actual == 3, f"Expected 3 canonical sentence rows, found {actual}"
            MODULE.validate_index(con, 3)
            expected_probe = '"extraordinary" AND "and" AND "the"'
            assert MODULE.deterministic_probe_query("the and extraordinary") == expected_probe
            assert MODULE.deterministic_probe_query("the and extraordinary") == expected_probe
            assert MODULE.deterministic_probe_query("a") == ""

            # A missing deterministic midpoint must fail the bounded row-count check.
            middle = con.execute(
                "SELECT page, line_id, text FROM sentences WHERE rowid = 2"
            ).fetchone()
            con.execute("DELETE FROM sentences WHERE rowid = 2")
            con.commit()
            try:
                MODULE.validate_index(con, 3)
            except RuntimeError as error:
                assert "row-count probe" in str(error), str(error)
            else:
                raise AssertionError("Missing FEVER midpoint row was accepted")
            con.execute(
                "INSERT INTO sentences(rowid, page, line_id, text) VALUES(2, ?, ?, ?)",
                middle,
            )
            con.commit()
            MODULE.validate_index(con, 3)

            # Simulate a stale external-content FTS index while preserving the
            # canonical sentence table/count. The deterministic probes must catch it.
            con.execute("INSERT INTO sentences_fts(sentences_fts) VALUES('delete-all')")
            con.commit()
            try:
                MODULE.validate_index(con, 3)
            except RuntimeError as error:
                assert "FTS probe failed" in str(error), str(error)
            else:
                raise AssertionError("FTS probes accepted a deleted external-content index")
        finally:
            con.close()

        source = SCRIPT.read_text(encoding="utf-8")
        assert "PRAGMA integrity_check" not in source
        assert "integrity-check" not in source
        assert "SELECT COUNT(*) FROM sentences" not in source
        assert "SELECT COUNT(*) FROM sentences_fts" not in source
        assert "FTS probe start rowid=" in source
        assert "source traversal complete" in source
        assert "FEVER closing index connection" in source
        assert "FEVER candidate retrieval progress:" in source

    print("FEVER candidate preparation regression: PASS (exact row count and deterministic FTS probes)")


if __name__ == "__main__":
    main()
