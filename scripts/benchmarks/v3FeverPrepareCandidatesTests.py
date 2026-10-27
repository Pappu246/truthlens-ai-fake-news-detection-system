#!/usr/bin/env python3
"""Focused regression tests for bounded FEVER SQLite/FTS5 index validation."""
from __future__ import annotations

import importlib.util
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
        con = sqlite3.connect(db_path)
        try:
            actual = con.execute("SELECT COUNT(*) FROM sentences").fetchone()[0]
            assert actual == 3, f"Expected 3 canonical sentence rows, found {actual}"
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

    print("FEVER candidate preparation regression: PASS (exact row count and deterministic FTS probes)")


if __name__ == "__main__":
    main()
