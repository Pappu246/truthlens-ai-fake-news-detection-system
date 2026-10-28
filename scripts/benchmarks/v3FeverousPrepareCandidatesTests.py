#!/usr/bin/env python3
"""Small regression for the FEVEROUS candidate-preparation pipeline."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("v3FeverousPrepareCandidates.py").resolve()
SPEC = importlib.util.spec_from_file_location("v3_feverous_prepare_candidates", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> None:
    expected_query = '"apollo" OR "landed" OR "1969" OR "july" OR "moon" OR "12"'
    claim_text = "The Apollo Apollo landed on the Moon in July 1969 and Apollo 12"
    assert MODULE.fts_query(claim_text) == expected_query
    assert MODULE.fts_query(claim_text) == MODULE.fts_query(claim_text)
    assert '"not"' in MODULE.fts_query("Apollo was not the cause")
    long_query = MODULE.fts_query("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar")
    assert len(long_query.split(" OR ")) <= MODULE.MAX_QUERY_TERMS

    expected_probe = '"extraordinary" AND "and" AND "the"'
    assert MODULE.deterministic_probe_query("the and extraordinary") == expected_probe
    assert MODULE.deterministic_probe_query("the and extraordinary") == expected_probe
    assert MODULE.deterministic_probe_query("a") == ""
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
            },
            {
                "order": ["sentence_0"],
                "sentence_0": "Astrophotography observations documented extraordinary planetary alignment."
            }
        ]
        element_page = {
            "order": ["sentence_0", "section_0", "list_0", "table_0"],
            "sentence_0": "first sentence",
            "section_0": {"text": "section text"},
            "list_0": {"list": [{"id": "item-1", "value": "one"}, {"id": "item-2", "value": "two"}]},
            "table_0": {
                "caption": "table caption",
                "table": [[
                    {"id": "header-1", "value": "Header", "is_header": True},
                    {"id": "cell-1", "value": "Cell"},
                ]],
            },
        }
        all_elements = MODULE.extract_elements(element_page)
        assert len(all_elements) >= 6
        assert MODULE.extract_elements_limited(element_page, 0) == []
        for limit in (1, 2, 4, len(all_elements), len(all_elements) + 2):
            assert MODULE.extract_elements_limited(element_page, limit) == all_elements[:limit]

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

        first_run = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                f"--db={db_path}",
                f"--claims={claims_path}",
                f"--output={output_path}",
                "--top-pages=5",
                "--elements-per-page=10",
                "--index-batch-size=1"
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=60
        )
        assert "FEVEROUS candidate retrieval started: claims_total=2" in first_run.stdout
        assert "FEVEROUS candidate retrieval complete: claims_processed=2" in first_run.stdout

        old_interval = MODULE.PROGRESS_INTERVAL
        MODULE.PROGRESS_INTERVAL = 1
        captured = io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):
                MODULE.make_candidates(claims_path, db_path, output_path, 5, 10, 0, 1)
        finally:
            MODULE.PROGRESS_INTERVAL = old_interval
        progress = captured.getvalue()
        assert "FEVEROUS candidate retrieval progress: claims_processed=1/2" in progress
        assert "FEVEROUS candidate retrieval complete: claims_processed=2" in progress

        lines = output_path.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 2, f"Expected two JSONL records, found {len(lines)}"
        records = [json.loads(line) for line in lines]
        assert [row["id"] for row in records] == ["claim-1", "claim-2"]
        assert all(row["candidates"] for row in records), "FTS retrieval returned no candidates"

        index_path = Path(f"{db_path}.fts.sqlite")
        indexed = sqlite3.connect(index_path)
        try:
            status = indexed.execute(
                "SELECT value FROM index_metadata WHERE key='status'"
            ).fetchone()[0]
            assert status == "complete", f"Expected complete index marker, found {status}"
            indexed_page_count = indexed.execute(
                "SELECT value FROM index_metadata WHERE key='indexed_page_count'"
            ).fetchone()[0]
            assert indexed_page_count == "3", f"Expected exact indexed page count 2, found {indexed_page_count}"
            indexed.execute(
                "UPDATE index_metadata SET value='building' WHERE key='status'"
            )
            indexed.commit()
        finally:
            indexed.close()

        # Simulate a runner being interrupted mid-build. A file exists, but its
        # BUILDING marker must force a clean rebuild instead of reusing partial data.
        subprocess.run(
            [
                sys.executable, str(SCRIPT),
                f"--db={db_path}",
                f"--claims={claims_path}",
                f"--output={output_path}",
                "--top-pages=5",
                "--elements-per-page=10",
                "--index-batch-size=1"
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=60
        )
        lines_after_rebuild = output_path.read_text(encoding="utf-8").splitlines()
        assert len(lines_after_rebuild) == 2, (
            f"Expected two records after rebuilding incomplete index, found {len(lines_after_rebuild)}"
        )

        indexed = sqlite3.connect(index_path)
        try:
            fts_count = indexed.execute("SELECT COUNT(*) FROM pages_fts").fetchone()[0]
            status = indexed.execute(
                "SELECT value FROM index_metadata WHERE key='status'"
            ).fetchone()[0]
            assert fts_count == 3, f"Expected 2 indexed pages after rebuild, found {fts_count}"
            assert status == "complete", f"Rebuild did not seal the index: {status}"
            indexed_page_count = indexed.execute(
                "SELECT value FROM index_metadata WHERE key='indexed_page_count'"
            ).fetchone()[0]
            assert indexed_page_count == "3", f"Rebuild did not record exact count: {indexed_page_count}"
            # A complete marker must not hide a stale row count: reuse validation
            # should reject this index and rebuild it from the source wiki DB.
            indexed.execute("DELETE FROM pages_fts WHERE rowid=2")
            indexed.commit()
        finally:
            indexed.close()

        subprocess.run(
            [
                sys.executable, str(SCRIPT),
                f"--db={db_path}",
                f"--claims={claims_path}",
                f"--output={output_path}",
                "--top-pages=5",
                "--elements-per-page=10",
                "--index-batch-size=1"
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=60
        )
        indexed = sqlite3.connect(index_path)
        try:
            fts_count = indexed.execute("SELECT COUNT(*) FROM pages_fts").fetchone()[0]
            indexed_page_count = indexed.execute(
                "SELECT value FROM index_metadata WHERE key='indexed_page_count'"
            ).fetchone()[0]
            assert fts_count == 3 and indexed_page_count == "3", (
                f"Row-count mismatch was not repaired: actual={fts_count}, metadata={indexed_page_count}"
            )
        finally:
            indexed.close()

        source = SCRIPT.read_text(encoding="utf-8")
        assert "PRAGMA integrity_check" not in source
        assert "VALUES('integrity-check')" not in source
        assert "SELECT COUNT(*) FROM pages_fts" not in source
        assert "deterministic_probe_query" in source
        assert "FTS probe start rowid=" in source
        assert "source traversal complete" in source
        assert "FEVEROUS closing index connection" in source
        assert "FEVEROUS candidate retrieval progress:" in source

    print("FEVEROUS candidate preparation regression: PASS (exact counts, bounded FTS probes, interrupted/stale-index recovery)")


if __name__ == "__main__":
    main()
