"""
TruthLens AI - Dataset Validation Module
Audits the training dataset for:
- Missing columns
- Invalid or unmapped labels
- Empty or very short text (< 60 chars)
- Duplicate articles
- Class balance / imbalance
"""

import csv
import os
import sys
from typing import Dict, Any, List

def validate_dataset(csv_path: str) -> Dict[str, Any]:
    if not os.path.exists(csv_path):
        return {
            "status": "ERROR",
            "message": f"Dataset file not found at {csv_path}",
            "filename": os.path.basename(csv_path),
            "file_path": csv_path,
            "total_samples": 0,
            "available_columns": [],
            "text_columns": [],
            "label_column": None,
            "real_samples": 0,
            "fake_samples": 0,
            "class_distribution": {},
            "missing_values": 0,
            "duplicate_articles": 0,
            "short_articles": 0,
            "issues": [f"File does not exist: {csv_path}"]
        }

    issues: List[str] = []
    total_samples = 0
    real_samples = 0
    fake_samples = 0
    missing_values = 0
    short_articles = 0
    duplicate_articles = 0
    seen_texts = set()

    with open(csv_path, "r", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        header = next(reader, None)

        if not header:
            return {
                "status": "ERROR",
                "message": "Dataset file is completely empty",
                "filename": os.path.basename(csv_path),
                "file_path": csv_path,
                "total_samples": 0,
                "issues": ["Dataset is empty"]
            }

        expected_cols = ["title", "text", "label"]
        available_columns = header
        for col in expected_cols:
            if col not in header:
                issues.append(f"Missing expected column: '{col}'")

        title_idx = header.index("title") if "title" in header else 0
        text_idx = header.index("text") if "text" in header else 1
        label_idx = header.index("label") if "label" in header else 2

        row_index = 1
        for row in reader:
            row_index += 1
            if not row or all(c.strip() == "" for c in row):
                continue
            total_samples += 1

            title = row[title_idx].strip() if len(row) > title_idx else ""
            body = row[text_idx].strip() if len(row) > text_idx else ""
            label = row[label_idx].strip().upper() if len(row) > label_idx else ""

            # Missing content check
            if not body and not title:
                missing_values += 1
                issues.append(f"Row {row_index}: Both title and text are empty.")

            # Short text check (< 60 chars)
            full_text = f"{title} {body}".strip()
            if len(full_text) < 60:
                short_articles += 1

            # Duplicate check
            norm_text = full_text.lower()
            if norm_text in seen_texts:
                duplicate_articles += 1
            else:
                seen_texts.add(norm_text)

            # Label validation
            if label in ("REAL", "0"):
                real_samples += 1
            elif label in ("FAKE", "1"):
                fake_samples += 1
            else:
                issues.append(f"Row {row_index}: Invalid label '{label}' (expected 'REAL' or 'FAKE').")

    real_pct = round((real_samples / total_samples * 100), 2) if total_samples > 0 else 0
    fake_pct = round((fake_samples / total_samples * 100), 2) if total_samples > 0 else 0

    imbalance_ratio = round(max(real_samples, fake_samples) / max(1, min(real_samples, fake_samples)), 2)
    has_class_imbalance = imbalance_ratio > 1.5

    status = "VALID" if not issues and total_samples > 0 else ("WARNING" if total_samples > 0 else "ERROR")

    return {
        "status": status,
        "filename": os.path.basename(csv_path),
        "file_path": csv_path,
        "total_samples": total_samples,
        "available_columns": available_columns,
        "text_columns": ["title", "text"],
        "label_column": "label",
        "real_samples": real_samples,
        "fake_samples": fake_samples,
        "class_distribution": {
            "REAL": {"count": real_samples, "percentage": real_pct},
            "FAKE": {"count": fake_samples, "percentage": fake_pct}
        },
        "class_balance": "BALANCED" if not has_class_imbalance else f"IMBALANCED (ratio {imbalance_ratio}:1)",
        "missing_values": missing_values,
        "duplicate_articles": duplicate_articles,
        "short_articles": short_articles,
        "issues": issues
    }

if __name__ == "__main__":
    path_to_check = sys.argv[1] if len(sys.argv) > 1 else "data/news.csv"
    res = validate_dataset(path_to_check)
    import json
    print(json.dumps(res, indent=2))
