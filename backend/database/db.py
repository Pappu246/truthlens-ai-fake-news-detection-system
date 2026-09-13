import sqlite3
import json
from datetime import datetime
from typing import List, Dict, Any, Optional
from backend.config import DB_PATH

def get_connection():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text_preview TEXT NOT NULL,
        full_text TEXT NOT NULL,
        source_url TEXT,
        prediction TEXT NOT NULL,
        confidence REAL,
        fake_probability REAL,
        real_probability REAL,
        risk_level TEXT NOT NULL,
        model_name TEXT NOT NULL,
        indicators_json TEXT,
        explanation_json TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)
    # Migration: databases created before the verdict contract declared the
    # score columns NOT NULL. Rebuild once so guarded (NEEDS MORE CONTEXT)
    # results can store NULL = "not available".
    try:
        cols = cursor.execute("PRAGMA table_info(history)").fetchall()
        notnull_cols = {row[1] for row in cols if row[3]}
        if notnull_cols & {"confidence", "fake_probability", "real_probability"}:
            cursor.executescript("""
                CREATE TABLE IF NOT EXISTS history_migrated (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text_preview TEXT NOT NULL,
                    full_text TEXT NOT NULL,
                    source_url TEXT,
                    prediction TEXT NOT NULL,
                    confidence REAL,
                    fake_probability REAL,
                    real_probability REAL,
                    risk_level TEXT NOT NULL,
                    model_name TEXT NOT NULL,
                    indicators_json TEXT,
                    explanation_json TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO history_migrated (
                    id, text_preview, full_text, source_url, prediction,
                    confidence, fake_probability, real_probability,
                    risk_level, model_name, indicators_json,
                    explanation_json, timestamp
                )
                SELECT id, text_preview, full_text, source_url, prediction,
                    confidence, fake_probability, real_probability,
                    risk_level, model_name, indicators_json,
                    explanation_json, timestamp
                FROM history;
                DROP TABLE history;
                ALTER TABLE history_migrated RENAME TO history;
            """)
            print("[TruthLens] Migrated history table to nullable score columns")
    except Exception as e:
        print(f"[TruthLens] History table migration failed (non-fatal): {e}")
    conn.commit()
    conn.close()

# Auto-initialize table schema
init_db()

def insert_history(
    full_text: str,
    prediction: str,
    confidence: Optional[float],
    fake_probability: Optional[float],
    real_probability: Optional[float],
    risk_level: str,
    model_name: str,
    source_url: Optional[str] = None,
    indicators: Optional[List[Dict[str, Any]]] = None,
    explanation: Optional[List[Dict[str, Any]]] = None,
) -> int:
    conn = get_connection()
    cursor = conn.cursor()
    text_preview = full_text.strip()[:140] + ("..." if len(full_text.strip()) > 140 else "")
    cursor.execute("""
    INSERT INTO history (
        text_preview, full_text, source_url, prediction,
        confidence, fake_probability, real_probability, risk_level,
        model_name, indicators_json, explanation_json, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        text_preview,
        full_text,
        source_url or "",
        prediction,
        confidence,
        fake_probability,
        real_probability,
        risk_level,
        model_name,
        json.dumps(indicators or []),
        json.dumps(explanation or []),
        datetime.utcnow().isoformat()
    ))
    record_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return record_id

def get_all_history(limit: int = 50) -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT id, text_preview, source_url, prediction, confidence,
           fake_probability, real_probability, risk_level, model_name, timestamp
    FROM history
    ORDER BY id DESC
    LIMIT ?
    """, (limit,))
    rows = cursor.fetchall()
    results = [dict(row) for row in rows]
    conn.close()
    return results

def get_history_by_id(record_id: int) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM history WHERE id = ?", (record_id,))
    row = cursor.fetchone()
    conn.close()
    if not row:
        return None
    data = dict(row)
    data["indicators"] = json.loads(data.get("indicators_json") or "[]")
    data["explanation"] = json.loads(data.get("explanation_json") or "[]")
    return data

def delete_history_item(record_id: int) -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM history WHERE id = ?", (record_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted

def clear_all_history() -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM history")
    count = cursor.rowcount
    conn.commit()
    conn.close()
    return count
