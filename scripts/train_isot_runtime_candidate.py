#!/usr/bin/env python3
"""Train an exact compact production-runtime calibrated candidate.

Without --welfake, this reproduces an ISOT-only research candidate. With the
verified WELFake CSV, it trains on ISOT's leak-aware train split plus WELFake's
40% train partition, fits calibration/model selection on the combined ISOT and
WELFake validation partitions, and reserves a disjoint 50% WELFake hash holdout
that is never used for fitting/calibration/selection. Exact normalized-text
overlaps with the complete ISOT corpus and duplicate/conflicting WELFake groups
are removed first. The artifact format remains the exact runtime SVM + Platt
calibrator contract. This script NEVER modifies production model artifacts.
"""
import argparse
import csv
import hashlib
import json
import math
import platform
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score, average_precision_score, balanced_accuracy_score, brier_score_loss,
    confusion_matrix, f1_score, precision_score, recall_score, roc_auc_score,
)
from sklearn.model_selection import train_test_split
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PREP = DATA / "isot_prepared"
DEFAULT_OUT = ROOT / "artifacts" / "models"
SEED = 42
# Match the frozen production runtime policy exactly. Policy changes are versioned
# into the candidate fingerprint and never alter the deployed artifact.
FAKE_THRESHOLD = 0.98
REAL_THRESHOLD = 0.35
LOW_VOCABULARY_COVERAGE_THRESHOLD = 0.10
OOD_SHORT_WORD_COUNT = 100
OOD_COVERAGE_THRESHOLD = 0.35

STOPWORDS = {
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are',
    "aren't", 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both',
    'but', 'by', 'can', 'cannot', 'could', "couldn't", 'did', "didn't", 'do', 'does', "doesn't",
    'doing', "don't", 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', "hadn't",
    'has', "hasn't", 'have', "haven't", 'having', 'he', "he'd", "he'll", "he's", 'her', 'here',
    "here's", 'hers', 'herself', 'him', 'himself', 'his', 'how', "how's", 'i', "i'd", "i'll",
    "i'm", "i've", 'if', 'in', 'into', 'is', "isn't", 'it', "it's", 'its', 'itself', "let's", 'me',
    'more', 'most', "mustn't", 'my', 'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only',
    'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', "shan't",
    'she', "she'd", "she'll", "she's", 'should', "shouldn't", 'so', 'some', 'such', 'than', 'that',
    "that's", 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', "there's", 'these',
    'they', "they'd", "they'll", "they're", "they've", 'this', 'those', 'through', 'to', 'too',
    'under', 'until', 'up', 'very', 'was', "wasn't", 'we', "we'd", "we'll", "we're", "we've",
    'were', "weren't", 'what', "what's", 'when', "when's", 'where', "where's", 'which', 'while',
    'who', "who's", 'whom', 'why', "why's", 'with', "won't", 'would', "wouldn't", 'you', "you'd",
    "you'll", "you're", "you've", 'your', 'yours', 'yourself', 'yourselves'
}

PUNCT_RE = re.compile(r'[.,/#!$%\^&\*;:{}=\-_\`~()?"\'\[\]]')
URL_RE = re.compile(r'https?://\S+|www\.\S+')
HTML_RE = re.compile(r'<.*?>')
WIRE_DATELINE_RE = re.compile(
    r"(?:[A-Z][A-Z0-9 .,'’/-]{2,60}\s+)?\(\s*(?:Reuters|Associated Press|AP News|AP|AFP|Agence France-Presse|Bloomberg News)\s*\)\s*[-—:]\s*",
    re.IGNORECASE,
)
WIRE_BYLINE_SUFFIX_RE = re.compile(
    r"\s*[-|–—]\s*(?:Reuters|Associated Press|AP News|AFP|Agence France-Presse|Bloomberg News)(?=\s|$)",
    re.IGNORECASE,
)
SOCIAL_CTA_RE = re.compile(
    r"\b(?:please\s+)?share\s+(?:this|the\s+(?:story|article|post|news))\s+before\b[^.!?\n]*(?:[.!?]|$)"
    r"|\b(?:like\s+and\s+share|subscribe\s+to\s+(?:our|the)\s+newsletter|click\s+here\s+to\s+read\s+more)\b[^.!?\n]*(?:[.!?]|$)",
    re.IGNORECASE,
)


def normalize_editorial_boilerplate(text: str) -> str:
    """Remove narrow wire-service byline and explicit social CTA boilerplate."""
    normalized = text or ""
    normalized = WIRE_DATELINE_RE.sub(" ", normalized)
    normalized = WIRE_BYLINE_SUFFIX_RE.sub(" ", normalized)
    normalized = SOCIAL_CTA_RE.sub(" ", normalized)
    return re.sub(r'\s+', ' ', normalized).strip()


def clean_text(text: str) -> str:
    if not text:
        return ""
    cleaned = normalize_editorial_boilerplate(text).lower()
    cleaned = URL_RE.sub(" ", cleaned)
    cleaned = HTML_RE.sub(" ", cleaned)
    cleaned = PUNCT_RE.sub(" ", cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return " ".join(t for t in cleaned.split(" ") if t not in STOPWORDS and len(t) >= 3)

def runtime_analyzer(doc: str):
    words = doc.split()
    terms = [w for w in words if len(w) >= 3]
    terms.extend(
        f"{words[i]} {words[i+1]}"
        for i in range(len(words)-1)
        if len(words[i]) >= 3 and len(words[i+1]) >= 3
    )
    return terms

def read_isot():
    rows = []
    for filename, label in [("True.csv", 0), ("Fake.csv", 1)]:
        path = DATA / filename
        if not path.exists():
            raise SystemExit(f"Missing {path}; real ISOT data is required.")
        df = pd.read_csv(path, dtype=str, keep_default_na=False)
        expected = ["title", "text", "subject", "date"]
        if list(df.columns) != expected:
            raise SystemExit(f"{filename} schema mismatch: {list(df.columns)}")
        for i, row in df.iterrows():
            rows.append({
                "id": ("REAL" if label == 0 else "FAKE") + f"-{i}",
                "title": row["title"].strip(),
                "text": row["text"].strip(),
                "label": label,
            })
    return {r["id"]: r for r in rows}

def load_ids(name: str):
    path = PREP / "splits" / f"{name}_ids.txt"
    if not path.exists():
        raise SystemExit(f"Missing split file {path}; run the verified Phase 2 data pipeline first.")
    return [x for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]

def article_text(article):
    return f"{article['title']} {article['text']}".strip()

def metrics(y_true, p):
    pred = (p >= 0.5).astype(int)
    return {
        "accuracy": float(accuracy_score(y_true, pred)),
        "balanced_accuracy": float(balanced_accuracy_score(y_true, pred)),
        "precision": float(precision_score(y_true, pred, zero_division=0)),
        "recall": float(recall_score(y_true, pred, zero_division=0)),
        "f1": float(f1_score(y_true, pred, zero_division=0)),
        "macro_f1": float(f1_score(y_true, pred, average="macro", zero_division=0)),
        "roc_auc": float(roc_auc_score(y_true, p)),
        "pr_auc": float(average_precision_score(y_true, p)),
        "brier": float(brier_score_loss(y_true, p)),
        "confusion_matrix": confusion_matrix(y_true, pred).tolist(),
    }

def ece(y_true, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        mask = (p >= lo) & (p <= hi if hi == 1 else p < hi)
        if mask.any():
            total += mask.mean() * abs(float(p[mask].mean()) - float(y_true[mask].mean()))
    return float(total)

def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()



def file_md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_text_hash(text: str) -> str | None:
    normalized = clean_text(text)
    if not normalized:
        return None
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def prepare_welfake_partitions(welfake_path: Path, isot_articles: dict) -> dict:
    """Create deterministic source-overlap-free WELFake train/val/holdout partitions.

    WELFake labels: 0=FAKE, 1=REAL. Runtime labels: 1=FAKE, 0=REAL.
    All normalized exact-text overlaps with the complete ISOT corpus are removed
    before any split. Duplicate groups are deduplicated; conflicting-label groups
    are excluded. Only train and validation are returned for model fitting;
    holdout texts and labels are never used by fitting/calibration/model selection.
    """
    if not welfake_path.is_file():
        raise SystemExit(f"WELFake CSV is required but missing: {welfake_path}")
    dataset_md5 = file_md5(welfake_path)
    expected_md5 = "73c9675a4b3d09f86a6933d0b8d7d908"
    if dataset_md5.lower() != expected_md5:
        raise SystemExit(f"WELFake checksum mismatch: expected {expected_md5}, got {dataset_md5}")

    isot_hashes = {
        digest for digest in (
            normalized_text_hash(article_text(article)) for article in isot_articles.values()
        ) if digest
    }
    frame = pd.read_csv(welfake_path, dtype=str, keep_default_na=False, low_memory=False)
    frame.columns = [str(column).strip().lower() for column in frame.columns]
    required = {"title", "text", "label"}
    if not required.issubset(frame.columns):
        raise SystemExit(f"WELFake schema mismatch; expected {sorted(required)}, got {list(frame.columns)}")

    counters = {
        "rows_read": int(len(frame)),
        "invalid_label_rows": 0,
        "short_or_empty_rows": 0,
        "isot_exact_overlap_rows_removed": 0,
        "same_label_duplicate_rows_removed": 0,
        "conflicting_duplicate_group_rows_removed": 0,
    }
    grouped: dict[str, list[dict]] = {}
    for row in frame[["title", "text", "label"]].to_dict("records"):
        try:
            label = int(str(row["label"]).strip())
        except (TypeError, ValueError):
            counters["invalid_label_rows"] += 1
            continue
        if label not in (0, 1):
            counters["invalid_label_rows"] += 1
            continue
        title = str(row["title"]).strip()
        body = str(row["text"]).strip()
        article = (title + " " + body).strip()
        if len(article) < 300 or len(article.split()) < 50:
            counters["short_or_empty_rows"] += 1
            continue
        digest = normalized_text_hash(article)
        if not digest:
            counters["short_or_empty_rows"] += 1
            continue
        if digest in isot_hashes:
            counters["isot_exact_overlap_rows_removed"] += 1
            continue
        grouped.setdefault(digest, []).append({
            "hash": digest,
            "text": article,
            "label": 1 if label == 0 else 0,
        })

    records = []
    for digest, duplicates in sorted(grouped.items()):
        labels = {item["label"] for item in duplicates}
        if len(labels) != 1:
            counters["conflicting_duplicate_group_rows_removed"] += len(duplicates)
            continue
        counters["same_label_duplicate_rows_removed"] += max(0, len(duplicates) - 1)
        records.append(duplicates[0])

    if len(records) < 12_000:
        raise SystemExit(f"WELFake overlap/quality filtering left only {len(records)} unique rows; refusing a weak split.")

    labels = np.asarray([item["label"] for item in records], dtype=int)
    all_indices = np.arange(len(records))
    # Reserve 50% as a never-touched holdout so it remains >=10k after filtering.
    trainval_indices, holdout_indices = train_test_split(
        all_indices, test_size=0.50, random_state=SEED, stratify=labels
    )
    train_indices, val_indices = train_test_split(
        trainval_indices, test_size=0.20, random_state=SEED + 1,
        stratify=labels[trainval_indices]
    )

    partitions = {
        "train": [records[int(i)] for i in train_indices],
        "validation": [records[int(i)] for i in val_indices],
        "holdout": [records[int(i)] for i in holdout_indices],
    }
    hash_sets = {name: sorted(item["hash"] for item in values) for name, values in partitions.items()}
    if (set(hash_sets["train"]) & set(hash_sets["validation"]) or
            set(hash_sets["train"]) & set(hash_sets["holdout"]) or
            set(hash_sets["validation"]) & set(hash_sets["holdout"])):
        raise SystemExit("WELFake split integrity failure: normalized article hashes overlap between partitions.")

    split_manifest = {
        "schema_version": 1,
        "dataset": "WELFake (Zenodo record 4561253)",
        "dataset_md5": dataset_md5,
        "label_mapping": {"source_0": "FAKE", "source_1": "REAL", "runtime_fake_positive": 1},
        "is_source_independent_external_test": False,
        "split_method": "deterministic stratified hash-group split; 40% train, 10% validation/calibration, 50% untouched holdout; seed=42",
        "purpose": "WELFake train partition augments the ISOT training partition; validation is used for calibration/model selection; holdout is never passed to training, calibration, or model selection.",
        "normalized_exact_text_hashes_only": True,
        "isot_exact_overlap_hash_count": len(isot_hashes),
        "eligible_unique_articles_after_filtering": len(records),
        "split_counts": {name: len(values) for name, values in partitions.items()},
        "label_counts": {
            name: {
                "fake": sum(item["label"] == 1 for item in values),
                "real": sum(item["label"] == 0 for item in values),
            } for name, values in partitions.items()
        },
        "deduplication": counters,
        "train_hashes": hash_sets["train"],
        "validation_hashes": hash_sets["validation"],
        "holdout_hashes": hash_sets["holdout"],
        "note": "Hash identifiers only; no article text is stored in this manifest. This is a same-corpus held-out partition, not independent source-domain validation.",
    }
    return {"partitions": partitions, "manifest": split_manifest}

def score_runtime(text, artifact):
    cleaned = clean_text(text)
    words = cleaned.split()
    counts = Counter(words)
    for i in range(len(words) - 1):
        if len(words[i]) >= 3 and len(words[i+1]) >= 3:
            counts[f"{words[i]} {words[i+1]}"] += 1

    vals = []
    norm_sq = 0.0
    for term, count in counts.items():
        idx = artifact["vocabulary"].get(term)
        if idx is None:
            continue
        v = (1.0 + math.log(count)) * artifact["idf"][idx]
        vals.append((idx, v))
        norm_sq += v * v
    norm = math.sqrt(norm_sq) or 1.0

    model = artifact["selected_model"]
    z = model["bias"]
    for idx, value in vals:
        z += model["weights"][idx] * (value / norm)

    exponent = max(-50.0, min(50.0, model["plattA"] * z + model["plattB"]))
    p = 1.0 / (1.0 + math.exp(exponent))
    return p, len(counts), len(vals)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default=str(DEFAULT_OUT))
    parser.add_argument("--max-features", type=int, default=8000)
    parser.add_argument("--welfake", default=None, help="optional verified WELFake CSV for multi-source candidate training")
    args = parser.parse_args()

    fake = DATA / "Fake.csv"
    true = DATA / "True.csv"
    if not fake.exists() or not true.exists():
        raise SystemExit("Real ISOT CSVs are required; refusing to train on demo data.")
    if not (PREP / "stats.json").exists():
        raise SystemExit("Phase 2 preparation is missing.")

    articles = read_isot()
    split = {name: load_ids(name) for name in ["train", "val", "test", "temporal_test"]}
    welfake = prepare_welfake_partitions(Path(args.welfake), articles) if args.welfake else None

    train_x = [clean_text(article_text(articles[i])) for i in split["train"]]
    val_x = [clean_text(article_text(articles[i])) for i in split["val"]]
    test_x = [clean_text(article_text(articles[i])) for i in split["test"]]
    temp_x = [clean_text(article_text(articles[i])) for i in split["temporal_test"]]

    train_y = np.array([articles[i]["label"] for i in split["train"]])
    val_y = np.array([articles[i]["label"] for i in split["val"]])
    test_y = np.array([articles[i]["label"] for i in split["test"]])
    temp_y = np.array([articles[i]["label"] for i in split["temporal_test"]])

    if welfake:
        wf_train = welfake["partitions"]["train"]
        wf_val = welfake["partitions"]["validation"]
        train_x.extend(clean_text(item["text"]) for item in wf_train)
        val_x.extend(clean_text(item["text"]) for item in wf_val)
        train_y = np.concatenate([train_y, np.asarray([item["label"] for item in wf_train], dtype=int)])
        val_y = np.concatenate([val_y, np.asarray([item["label"] for item in wf_val], dtype=int)])

    vec = TfidfVectorizer(
        analyzer=runtime_analyzer,
        lowercase=False,
        token_pattern=None,
        max_features=args.max_features,
        min_df=3,
        sublinear_tf=True,
        norm="l2",
    )
    Xtr = vec.fit_transform(train_x)
    Xv = vec.transform(val_x)
    Xt = vec.transform(test_x)
    Xtemp = vec.transform(temp_x)

    lr = LogisticRegression(C=1.0, max_iter=1500, solver="liblinear", random_state=SEED)
    svm = LinearSVC(C=1.0, max_iter=3000, random_state=SEED)
    lr.fit(Xtr, train_y)
    svm.fit(Xtr, train_y)

    lr_val = lr.predict_proba(Xv)[:, 1]
    svm_val_margin = svm.decision_function(Xv)

    calibrator = LogisticRegression(C=1e6, max_iter=2000, solver="lbfgs", random_state=SEED)
    calibrator.fit(svm_val_margin.reshape(-1, 1), val_y)
    cal_p_val = calibrator.predict_proba(svm_val_margin.reshape(-1, 1))[:, 1]
    svm_test_p = calibrator.predict_proba(svm.decision_function(Xt).reshape(-1, 1))[:, 1]
    svm_temp_p = calibrator.predict_proba(svm.decision_function(Xtemp).reshape(-1, 1))[:, 1]
    lr_test_p = lr.predict_proba(Xt)[:, 1]

    svm_val_f1 = f1_score(val_y, cal_p_val >= 0.5, zero_division=0)
    lr_val_f1 = f1_score(val_y, lr_val >= 0.5, zero_division=0)
    if svm_val_f1 < lr_val_f1:
        raise SystemExit(
            f"Linear SVM calibration lost validation F1 ({svm_val_f1:.6f} < {lr_val_f1:.6f}); "
            "refusing to produce a calibrated-SVM runtime candidate."
        )

    version_payload = {
        "source_fake_sha256": sha256(fake),
        "source_true_sha256": sha256(true),
        "prep_stats_sha256": sha256(PREP / "stats.json"),
        "welfake_source_md5": welfake["manifest"]["dataset_md5"] if welfake else None,
        "welfake_split_method": welfake["manifest"]["split_method"] if welfake else None,
        "seed": SEED,
        "max_features": args.max_features,
        "tokenizer": "TruthLens Node cleanText + unigram/bigram analyzer",
        "text_normalizer": "wire-byline-and-explicit-social-CTA-removal-v1",
        "runtime_policy": {
            "fake_threshold": FAKE_THRESHOLD,
            "real_threshold": REAL_THRESHOLD,
            "low_vocabulary_coverage_threshold": LOW_VOCABULARY_COVERAGE_THRESHOLD,
            "ood_short_word_count": OOD_SHORT_WORD_COUNT,
            "ood_coverage_threshold": OOD_COVERAGE_THRESHOLD,
        },
    }
    version_prefix = "multisource-runtime-svm-" if welfake else "isot-runtime-svm-"
    version = version_prefix + hashlib.sha256(
        json.dumps(version_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:12]
    out = Path(args.output_dir) / version
    out.mkdir(parents=True, exist_ok=False)
    if welfake:
        (out / "welfake_split_manifest.json").write_text(
            json.dumps(welfake["manifest"], separators=(",", ":")), encoding="utf-8"
        )

    selected_test = metrics(test_y, svm_test_p)
    selected_temp = metrics(temp_y, svm_temp_p)
    selected_val = metrics(val_y, cal_p_val)

    vocab = {term: int(idx) for term, idx in vec.vocabulary_.items()}
    model = {
        "name": "Linear SVM (Calibrated)",
        "inference_mode": "single_calibrated_svm",
        "weights": svm.coef_[0].astype(float).tolist(),
        "bias": float(svm.intercept_[0]),
        "plattA": -float(calibrator.coef_[0, 0]),
        "plattB": -float(calibrator.intercept_[0]),
    }

    artifact = {
        "model_name": "Linear SVM (Calibrated)",
        "model_type": "linear_svm_calibrated",
        "model_version": version,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "is_demo": False,
        "dataset_status": "MULTI-SOURCE CANDIDATE" if welfake else "ISOT CANDIDATE",
        "dataset_info": {
            "name": "ISOT + WELFake" if welfake else "ISOT Fake News Dataset",
            "source_path": "data/True.csv & data/Fake.csv plus WELFake train/validation partitions" if welfake else "data/True.csv & data/Fake.csv",
            "total_samples": len(articles) + welfake["manifest"]["eligible_unique_articles_after_filtering"] if welfake else len(articles),
            "train_samples": len(train_x),
            "validation_samples": len(val_x),
            "test_samples": len(test_x),
            "holdout_samples": len(welfake["partitions"]["holdout"]) if welfake else 0,
            "real_samples": int(np.sum(train_y == 0) + np.sum(val_y == 0)),
            "fake_samples": int(np.sum(train_y == 1) + np.sum(val_y == 1)),
            "vocabulary_size": len(vocab),
            "is_demo": False,
            "dataset_status": "MULTI-SOURCE CANDIDATE" if welfake else "ISOT CANDIDATE",
            "evaluation_status": "ISOT leak-aware splits plus WELFake hash-group train/validation/untouched holdout; holdout is not source-independent external validation" if welfake else "Group-aware Phase 2 split; candidate only",
        },
        "preprocessing": {
            "lowercase": True,
            "strip_urls": True,
            "strip_html": True,
            "strip_punctuation": True,
            "remove_stopwords": True,
            "min_token_length": 3,
            "ngram_range": [1, 2],
            "sublinear_tf": True,
        },
        "vocabulary": vocab,
        "idf": vec.idf_.astype(float).tolist(),
        "selected_model": model,
        "logistic_regression": {
            "weights": lr.coef_[0].astype(float).tolist(),
            "bias": float(lr.intercept_[0]),
        },
        "metrics": {
            "validation": selected_val,
            "test": selected_test,
            "temporal_test": selected_temp,
            "calibration": {
                "method": "Platt sigmoid fitted on disjoint validation set",
                "brier_test": selected_test["brier"],
                "ece_10_test": ece(test_y, svm_test_p),
                "ece_10_temporal": ece(temp_y, svm_temp_p),
            },
            "candidates": {
                "logistic_regression_validation": metrics(val_y, lr_val),
                "linear_svm_calibrated_validation": selected_val,
            },
        },
        "thresholds": {
            "fake_threshold": FAKE_THRESHOLD,
            "real_threshold": REAL_THRESHOLD,
            "min_text_length": 60,
            "min_word_count": 20,
        },
        "training_contract": version_payload,
    }

    artifact_path = out / "model_artifact.json"
    artifact_path.write_text(json.dumps(artifact, separators=(",", ":")), encoding="utf-8")

    fixture_indices = split["test"][:20]
    fixtures = []
    for article_id in fixture_indices:
        item = articles[article_id]
        text_value = article_text(item)
        p_runtime, candidate_terms, matched_terms = score_runtime(text_value, artifact)
        # Independent sklearn oracle: the expected value must come from the
        # fitted SVM + fitted calibrator, not from the serialized runtime scorer.
        x_oracle = vec.transform([clean_text(text_value)])
        p_oracle = float(
            calibrator.predict_proba(svm.decision_function(x_oracle).reshape(-1, 1))[0, 1]
        )
        drift = abs(p_runtime - p_oracle)
        if drift > 1e-12:
            raise SystemExit(
                f"Runtime serialization drift for {article_id}: {drift:.3e} > 1e-12"
            )
        fixtures.append({
            "id": article_id,
            "text": text_value,
            "expected_fake_probability": p_oracle,
            "candidate_terms": candidate_terms,
            "matched_terms": matched_terms,
        })
    (out / "runtime_parity_fixtures.json").write_text(json.dumps(fixtures, indent=2), encoding="utf-8")

    # The tracked LIAR fixture is stored under data/ in this repository. Keep
    # compatibility with the original root-level location for CI/materialized data.
    liar_path = ROOT / "test.tsv"
    if not liar_path.exists():
        liar_path = DATA / "test.tsv"
    if not liar_path.exists():
        raise SystemExit("LIAR test.tsv is required for the OOD gate (checked repository root and data/).")
    mapping = {"pants-fire": 1, "false": 1, "mostly-true": 0, "true": 0}
    y = []
    p = []
    for row in csv.reader(liar_path.open(encoding="utf-8"), delimiter="\t"):
        if len(row) < 3:
            continue
        label = row[1].strip().lower()
        if label not in mapping:
            continue
        prob, _, _ = score_runtime(row[2], artifact)
        y.append(mapping[label])
        p.append(prob)
    y = np.array(y)
    p = np.array(p)
    ood = {
        "status": "COMPLETED",
        "dataset": "LIAR Benchmark",
        "eligible_binary_samples": int(len(y)),
        "excluded_samples": int(1283 - len(y)),
        "metrics": metrics(y, p),
        "note": "Out-of-domain diagnostic. Not merged with ISOT headline metrics.",
    }
    (out / "external_validation.json").write_text(json.dumps(ood, indent=2), encoding="utf-8")

    manifest = {
        "schema_version": 2,
        "model_version": version,
        "created_at": artifact["trained_at"],
        "git_commit": "runtime-candidate-pipeline",
        "dataset_name": "ISOT + WELFake" if welfake else "ISOT Fake News Dataset",
        "dataset_fingerprint": version_payload,
        # Explicit field consumed by the promotion gate; it includes thresholds
        # and OOD constants and is bound into the candidate version hash.
        "training_contract": version_payload,
        "preparation_config": {
            "phase2_splits": "group-aware near-duplicate split + temporal split",
            "seed": SEED,
            "welfake_partitioning": welfake["manifest"]["split_method"] if welfake else None,
        },
        "software": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pandas": pd.__version__,
        },
        "model": {
            "family": "linear_svm_calibrated",
            "name": "Linear SVM (Calibrated)",
            "calibration": "Platt sigmoid on disjoint validation split",
            "tfidf": {
                "max_features": args.max_features,
                "min_df": 3,
                "sublinear_tf": True,
                "norm": "l2",
                "analyzer": "TruthLens runtime analyzer",
            },
        },
        "split_counts": {k: len(v) for k, v in split.items()},
        "welfake_data": ({
            "source_md5": welfake["manifest"]["dataset_md5"],
            "deduplication": welfake["manifest"]["deduplication"],
            "split_counts": welfake["manifest"]["split_counts"],
            "label_counts": welfake["manifest"]["label_counts"],
            "holdout_is_source_independent": False,
            "split_manifest": "welfake_split_manifest.json",
        } if welfake else None),
        "metrics": artifact["metrics"],
        "external_validation": {
            "status": "COMPLETED",
            "path": "external_validation.json",
            "eligible_binary_samples": int(len(y)),
            "accuracy": ood["metrics"]["accuracy"],
            "macro_f1": ood["metrics"]["macro_f1"],
        },
        "artifact_sha256": sha256(artifact_path),
        "parity_fixture_count": len(fixtures),
        "production_artifact": "data/saved_model_artifacts.json",
        "production_eligible": False,
        "promotion_status": "CANDIDATE_ONLY",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(json.dumps({
        "model_version": version,
        "candidate": str(out),
        "training_sources": ["ISOT", "WELFake train partition"] if welfake else ["ISOT"],
        "validation_sources": ["ISOT validation", "WELFake validation partition"] if welfake else ["ISOT validation"],
        "welfake_partitions": welfake["manifest"]["split_counts"] if welfake else None,
        "welfake_holdout_is_source_independent": False if welfake else None,
        "test": selected_test,
        "temporal_test": selected_temp,
        "ood_liar": ood,
        "artifact_sha256": manifest["artifact_sha256"],
        "production_artifact_modified": False,
    }, indent=2))

if __name__ == "__main__":
    main()
