#!/usr/bin/env python3
"""
TruthLens V3 Phase 2 FEVER candidate preparation.

Builds a disk-backed SQLite FTS5 index from the official FEVER wiki-pages
JSONL shards, then creates an open-retrieval candidate file for a selected
FEVER split. Gold evidence is never inserted into the candidate set.
"""
from __future__ import annotations
import argparse
import json
import re
import sqlite3
from pathlib import Path
try:
    import orjson
except ImportError:
    orjson = None
from typing import Iterable

TOKEN = re.compile(r"[A-Za-z0-9_]+")
JSON_LOADS = orjson.loads if orjson is not None else json.loads

def parse_line(raw: str):
    raw = raw.rstrip("\n")
    if "\t" not in raw:
        return None
    line_id, text = raw.split("\t", 1)
    try:
        return int(line_id), text
    except ValueError:
        return None

def iter_pages(wiki_dir: Path) -> Iterable[tuple[str, str, int, str]]:
    for shard in sorted(wiki_dir.glob("wiki-*.jsonl")):
        with shard.open("r", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                obj = JSON_LOADS(line)
                page = obj.get("id") or obj.get("title")
                if not page:
                    continue
                lines = obj.get("lines", "")
                if isinstance(lines, str):
                    for raw in lines.splitlines():
                        parsed = parse_line(raw)
                        if parsed:
                            line_id, text = parsed
                            yield page, page, line_id, text

def build_index(wiki_dir: Path, db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.execute("PRAGMA journal_mode=OFF")
    con.execute("PRAGMA synchronous=OFF")
    # Keep temporary sorting/index work on disk instead of allowing a large
    # full-corpus FTS rebuild to consume the runner's memory.
    con.execute("PRAGMA temp_store=FILE")
    con.execute("PRAGMA cache_size=-262144")
    con.execute("DROP TABLE IF EXISTS sentences_fts")
    con.execute("DROP TABLE IF EXISTS sentences")
    con.execute("""
        CREATE TABLE sentences(
          rowid INTEGER PRIMARY KEY,
          page TEXT NOT NULL,
          line_id INTEGER NOT NULL,
          text TEXT NOT NULL,
          UNIQUE(page, line_id)
        )
    """)
    con.execute("""
        CREATE VIRTUAL TABLE sentences_fts USING fts5(
          page,
          line_id UNINDEXED,
          text,
          content='sentences',
          content_rowid='rowid'
        )
    """)
    batch = []
    processed_rows = 0
    next_report = 100_000
    last_rowid = 0
    batches_since_commit = 0
    con.execute("BEGIN")

    def flush_batch() -> None:
        nonlocal processed_rows, next_report, last_rowid, batches_since_commit
        if not batch:
            return

        # Insert the canonical rows first, preserving the existing
        # (page, line_id) deduplication contract.
        con.executemany(
            "INSERT OR IGNORE INTO sentences(page,line_id,text) VALUES(?,?,?)",
            batch,
        )

        # Index only newly inserted rows, in rowid order. This keeps the FTS
        # index incrementally in sync with the content table and avoids the
        # multi-hour single-shot FTS5 'rebuild' seen on the full FEVER corpus.
        fresh_rows = con.execute(
            "SELECT rowid,page,line_id,text FROM sentences WHERE rowid > ? ORDER BY rowid",
            (last_rowid,),
        ).fetchall()
        if fresh_rows:
            con.executemany(
                "INSERT INTO sentences_fts(rowid,page,line_id,text) VALUES(?,?,?,?)",
                fresh_rows,
            )
            last_rowid = fresh_rows[-1][0]
            processed_rows += len(fresh_rows)
            while processed_rows >= next_report:
                print(f"Indexed FEVER rows: {next_report}", flush=True)
                next_report += 100_000

        batch.clear()
        batches_since_commit += 1
        # Bound transaction growth while keeping commits infrequent enough
        # not to turn each small input batch into a separate disk sync.
        if batches_since_commit >= 20:
            con.commit()
            con.execute("BEGIN")
            batches_since_commit = 0

    for page, _title, line_id, text in iter_pages(wiki_dir):
        if text.strip():
            batch.append((page, line_id, text))
        if len(batch) >= 5000:
            flush_batch()
    flush_batch()
    con.commit()

    check = con.execute("PRAGMA integrity_check").fetchone()[0]
    if check != "ok":
        raise RuntimeError(f"FEVER SQLite integrity check failed: {check}")
    con.close()
    print(f"Built FEVER sentence index: rows={processed_rows} db={db_path}")

def fts_query(text: str) -> str:
    tokens = TOKEN.findall(text.lower())
    tokens = [t for t in tokens if len(t) > 1]
    if not tokens:
        return ""
    return " OR ".join('"' + t.replace('"', '""') + '"' for t in tokens[:32])

def load_claims(path: Path, limit: int | None):
    rows = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                rows.append(json.loads(line))
                if limit and len(rows) >= limit:
                    break
    return rows

def make_candidates(claims_path: Path, db_path: Path, output: Path, top_k: int):
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as out:
        with claims_path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                if not raw.strip():
                    continue
                claim = JSON_LOADS(raw)
                q = fts_query(claim.get("claim", ""))
                hits = []
                if q:
                    try:
                        hits = cur.execute(
                            """
                            SELECT page, line_id, text, rank
                            FROM sentences_fts
                            WHERE sentences_fts MATCH ?
                            ORDER BY rank
                            LIMIT ?
                            """,
                            (q, top_k)
                        ).fetchall()
                    except sqlite3.OperationalError:
                        hits = []
                candidates = []
                for page, line_id, text, score in hits:
                    candidates.append({
                        "id": f"{page}::{line_id}",
                        "url": f"https://fever.local/wiki/{page}#L{line_id}",
                        "title": page,
                        "snippet": text,
                        "body": text,
                        "contentType": "SUMMARY",
                        "publisher": "FEVER Wikipedia",
                        "publishedAt": None,
                        "retrievedAt": "benchmark",
                        "retrievalMethod": "fever_sqlite_fts5",
                        "fever_page": page,
                        "fever_line": int(line_id),
                        "fts_score": float(score)
                    })
                out.write(json.dumps({
                    "id": claim["id"],
                    "claim": claim["claim"],
                    "label": claim.get("label"),
                    "gold_evidence": claim.get("evidence", []),
                    "candidates": candidates
                }) + "\n")
    con.close()

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--wiki-dir", type=Path, required=True)
    p.add_argument("--claims", type=Path, required=True)
    p.add_argument("--db", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--build-index", action="store_true")
    p.add_argument("--top-k", type=int, default=100)
    args = p.parse_args()
    if args.build_index or not args.db.exists():
        build_index(args.wiki_dir, args.db)
    make_candidates(args.claims, args.db, args.output, args.top_k)

if __name__ == "__main__":
    main()
