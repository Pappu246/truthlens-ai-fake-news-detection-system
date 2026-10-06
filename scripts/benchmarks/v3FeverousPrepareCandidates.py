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

def build_index(db_path, index_path):
    src = sqlite3.connect(db_path)
    dst = sqlite3.connect(index_path)
    dst.execute("PRAGMA journal_mode=OFF")
    dst.execute("PRAGMA synchronous=OFF")
    dst.execute("PRAGMA temp_store=MEMORY")
    dst.execute("PRAGMA cache_size=-262144")
    dst.execute("DROP TABLE IF EXISTS pages")
    dst.execute("DROP TABLE IF EXISTS pages_fts")
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
    cursor = src.execute("SELECT id, data FROM wiki")
    batch = []
    count = 0
    for page_id, raw in cursor:
        try:
            page = JSON_LOADS(raw)
            pieces = [text for _, text, _ in extract_elements(page)]
            page_text = "\\n".join(pieces)
        except Exception:
            continue
        if not page_text.strip():
            continue
        batch.append((page_id, page_text))
        if len(batch) >= 2000:
            dst.executemany("INSERT OR REPLACE INTO pages(page_id,text) VALUES(?,?)", batch)
            dst.commit()
            batch.clear()
            count += 2000
            if count % 10000 == 0:
                print(f"Indexed FEVEROUS pages: {count}", flush=True)
    if batch:
        dst.executemany("INSERT OR REPLACE INTO pages(page_id,text) VALUES(?,?)", batch)
        dst.commit()
        count += len(batch)
    dst.execute("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')")
    dst.commit()
    check = dst.execute("PRAGMA integrity_check").fetchone()[0]
    if check != "ok":
        raise RuntimeError(f"FEVEROUS SQLite integrity check failed: {check}")
    dst.close()
    src.close()
    print(f"FEVEROUS page index built: pages={count}")

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

def make_candidates(claims_path, db_path, output, top_pages, per_page_elements, limit):
    index_path = Path(str(db_path) + ".fts.sqlite")
    if not index_path.exists():
        build_index(db_path, index_path)

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
                    "SELECT page_id, bm25(pages_fts) FROM pages_fts WHERE pages_fts MATCH ? ORDER BY bm25(pages_fts) LIMIT ?",
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
            }) + "\\n")

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
    args = p.parse_args()
    make_candidates(
        args.claims, args.db, args.output,
        args.top_pages, args.elements_per_page, args.max_claims
    )

if __name__ == "__main__":
    main()
