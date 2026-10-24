#!/usr/bin/env python3
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

TOKEN = re.compile(r"[A-Za-z0-9_]+")
JSON_LOADS = orjson.loads if orjson is not None else json.loads

def text_value(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("text", "value", "caption", "title"):
            if isinstance(value.get(key), str):
                return value[key].strip()
    return ""

def extract_elements(page):
    elements = []

    if not isinstance(page, dict):
        return elements

    for key in page.get("order", []):
        value = page.get(key)
        if key.startswith("sentence_") and isinstance(value, str) and value.strip():
            elements.append((key, value.strip(), "SENTENCE"))
        elif key.startswith("section_"):
            value_text = text_value(value)
            if value_text:
                elements.append((key, value_text, "SECTION"))
        elif key.startswith("list_") and isinstance(value, dict):
            for item in value.get("list", []):
                item_id = item.get("id")
                item_text = text_value(item.get("value"))
                if item_id and item_text:
                    elements.append((item_id, item_text, "LIST"))
        elif key.startswith("table_") and isinstance(value, dict):
            caption = text_value(value.get("caption"))
            caption_id = "table_caption_" + key.split("_")[-1]
            if caption:
                elements.append((caption_id, caption, "TABLE_CAPTION"))
            for row in value.get("table", []):
                if not isinstance(row, list):
                    continue
                for cell in row:
                    if not isinstance(cell, dict):
                        continue
                    cell_id = cell.get("id")
                    cell_text = text_value(cell.get("value"))
                    if cell_id and cell_text:
                        kind = "HEADER_CELL" if cell.get("is_header") else "CELL"
                        elements.append((cell_id, cell_text, kind))

    return elements

def fts_query(text):
    tokens = [t for t in TOKEN.findall(text.lower()) if len(t) > 1][:48]
    return " OR ".join('"' + t.replace('"', '""') + '"' for t in tokens)

def index_is_complete(index_path, source_db_path):
    """Only reuse an index that reached its completion marker for this source file."""
    if not index_path.exists():
        return False

    try:
        stat = source_db_path.stat()
        idx = sqlite3.connect(index_path)
        try:
            metadata = dict(idx.execute("SELECT key, value FROM index_metadata"))
            return (
                metadata.get("status") == "complete"
                and metadata.get("source_size") == str(stat.st_size)
                and metadata.get("source_mtime_ns") == str(stat.st_mtime_ns)
            )
        finally:
            idx.close()
    except (OSError, sqlite3.Error, ValueError):
        return False


def build_index(db_path, index_path, batch_size=250):
    src = sqlite3.connect(db_path)
    dst = sqlite3.connect(index_path)
    dst.execute("PRAGMA journal_mode=OFF")
    dst.execute("PRAGMA synchronous=OFF")
    # FEVEROUS pages can contain very large tables. Keep temporary work and the
    # SQLite cache disk-backed/small so a single 2,000-page batch cannot exhaust
    # the GitHub-hosted runner's memory while building FTS5 postings.
    dst.execute("PRAGMA temp_store=FILE")
    dst.execute("PRAGMA cache_size=-65536")
    dst.execute("DROP TABLE IF EXISTS pages_fts")
    dst.execute("DROP TABLE IF EXISTS pages")
    dst.execute("DROP TABLE IF EXISTS index_metadata")
    dst.execute("""
        CREATE TABLE pages(
          page_id TEXT PRIMARY KEY,
          text TEXT NOT NULL
        )
    """)
    dst.execute("""
        CREATE VIRTUAL TABLE pages_fts USING fts5(
          page_id UNINDEXED,
          text,
          content='pages',
          content_rowid='rowid'
        )
    """)
    stat = db_path.stat()
    dst.execute("CREATE TABLE index_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    dst.executemany(
        "INSERT INTO index_metadata(key, value) VALUES(?, ?)",
        [
            ("status", "building"),
            ("source_size", str(stat.st_size)),
            ("source_mtime_ns", str(stat.st_mtime_ns)),
        ],
    )
    # Commit the BUILDING marker separately. If a runner is killed mid-index,
    # the next attempt can detect and discard the partial database safely.
    dst.commit()
    cursor = src.execute("SELECT id, data FROM wiki")
    batch = []
    count = 0
    next_report = 10000
    last_rowid = 0
    batches_since_commit = 0
    dst.execute("BEGIN")

    def flush_batch():
        nonlocal count, next_report, last_rowid, batches_since_commit
        if not batch:
            return

        # The content table is canonical. Ignore duplicate page ids and index
        # only newly inserted rows, avoiding one expensive full FTS5 rebuild.
        dst.executemany("INSERT OR IGNORE INTO pages(page_id,text) VALUES(?,?)", batch)
        fresh_rows = dst.execute(
            "SELECT rowid,page_id,text FROM pages WHERE rowid > ? ORDER BY rowid",
            (last_rowid,),
        ).fetchall()
        if fresh_rows:
            dst.executemany(
                "INSERT INTO pages_fts(rowid,page_id,text) VALUES(?,?,?)",
                fresh_rows,
            )
            last_rowid = fresh_rows[-1][0]
            count += len(fresh_rows)
            while count >= next_report:
                print(f"Indexed FEVEROUS pages: {next_report}", flush=True)
                next_report += 10000

        batch.clear()
        batches_since_commit += 1
        if batches_since_commit >= 20:
            dst.commit()
            dst.execute("BEGIN")
            batches_since_commit = 0

    for page_id, raw in cursor:
        try:
            page = JSON_LOADS(raw)
            pieces = [text for _, text, _ in extract_elements(page)]
            page_text = "\n".join(pieces)
        except Exception:
            continue
        if not page_text.strip():
            continue
        batch.append((page_id, page_text))
        if len(batch) >= batch_size:
            flush_batch()

    flush_batch()
    dst.commit()
    check = dst.execute("PRAGMA integrity_check").fetchone()[0]
    if check != "ok":
        raise RuntimeError(f"FEVEROUS SQLite integrity check failed: {check}")
    # For an external-content FTS5 table, also verify postings against the
    # canonical content table before declaring the index reusable.
    dst.execute("INSERT INTO pages_fts(pages_fts, rank) VALUES('integrity-check', 1)")
    page_count = dst.execute("SELECT COUNT(*) FROM pages").fetchone()[0]
    fts_count = dst.execute("SELECT COUNT(*) FROM pages_fts").fetchone()[0]
    if page_count != fts_count:
        raise RuntimeError(f"FEVEROUS index count mismatch: pages={page_count}, fts={fts_count}")
    dst.execute("UPDATE index_metadata SET value='complete' WHERE key='status'")
    dst.commit()
    dst.close()
    src.close()
    print(f"FEVEROUS page index built: pages={count}, batch_size={batch_size}")

def load_claims(path, limit):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh):
            if not line.strip():
                continue
            if i == 0:
                try:
                    header = JSON_LOADS(line)
                    if "claim" not in header and "label" not in header:
                        continue
                except Exception:
                    pass
            rows.append(JSON_LOADS(line))
            if limit and len(rows) >= limit:
                break
    return rows

def make_candidates(claims_path, db_path, output, top_pages, per_page_elements, limit, index_batch_size):
    index_path = Path(str(db_path) + ".fts.sqlite")
    if not index_is_complete(index_path, db_path):
        # A previous forced termination may leave an index file in place but
        # incomplete. Never treat mere file existence as proof of readiness.
        for suffix in ("", "-journal", "-wal", "-shm"):
            Path(str(index_path) + suffix).unlink(missing_ok=True)
        build_index(db_path, index_path, index_batch_size)
    else:
        print(f"Reusing complete FEVEROUS page index: {index_path}")

    db = sqlite3.connect(db_path)
    idx = sqlite3.connect(index_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    with output.open("w", encoding="utf-8") as out:
        for row in load_claims(claims_path, limit):
            claim_id = row.get("id") or row.get("annotation_id") or row.get("claim_id")
            query = fts_query(row.get("claim", ""))
            page_hits = []
            if query:
                page_hits = idx.execute(
                    "SELECT page_id, rank FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?",
                    (query, top_pages),
                ).fetchall()

            candidates = []
            for page_id, _score in page_hits:
                raw = db.execute("SELECT data FROM wiki WHERE id = ?", (page_id,)).fetchone()
                if not raw:
                    continue
                try:
                    page = json.loads(raw[0])
                except Exception:
                    continue
                elements = extract_elements(page)[:per_page_elements]
                for element_id, text_value_, kind in elements:
                    candidates.append({
                        "id": f"{page_id}::{element_id}",
                        "url": f"https://feverous.local/wiki/{page_id}#{element_id}",
                        "title": page_id,
                        "snippet": text_value_,
                        "body": text_value_,
                        "contentType": "SUMMARY",
                        "publisher": "FEVEROUS Wikipedia",
                        "publishedAt": None,
                        "retrievedAt": "benchmark",
                        "retrievalMethod": "feverous_sqlite_fts5",
                        "feverous_page": page_id,
                        "feverous_element_id": element_id,
                        "feverous_id": page_id + "_" + element_id,
                        "feverous_type": kind
                    })

            out.write(json.dumps({
                "id": claim_id,
                "claim": row["claim"],
                "label": row.get("label"),
                "gold_evidence": row.get("evidence", []),
                "candidates": candidates
            }) + "\n")

    db.close()
    idx.close()

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", type=Path, required=True)
    p.add_argument("--claims", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--top-pages", type=int, default=25)
    p.add_argument("--elements-per-page", type=int, default=50)
    p.add_argument("--max-claims", type=int, default=0)
    p.add_argument("--index-batch-size", type=int, default=250)
    args = p.parse_args()
    if args.index_batch_size < 1:
        p.error("--index-batch-size must be at least 1")
    make_candidates(
        args.claims, args.db, args.output,
        args.top_pages, args.elements_per_page, args.max_claims,
        args.index_batch_size
    )

if __name__ == "__main__":
    main()
