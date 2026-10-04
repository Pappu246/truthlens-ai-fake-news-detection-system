#!/usr/bin/env python3
"""Train an exact, compact production-runtime ISOT candidate.

This pipeline is deliberately separate from scripts/train_isot.py:
- uses the verified Phase 2 group-aware splits;
- reproduces the Node tokenizer/TF-IDF term construction exactly;
- trains LinearSVC on train, fits Platt calibration only on disjoint validation;
- evaluates untouched test + temporal test;
- evaluates the exact same runtime scorer on LIAR OOD;
- writes a compact candidate artifact with one SVM + one Platt calibrator.
It NEVER modifies data/saved_model_artifacts.json.
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
    accuracy_score, average_precision_score, brier_score_loss,
    confusion_matrix, f1_score, precision_score, recall_score, roc_auc_score,
)
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PREP = DATA / "isot_prepared"
DEFAULT_OUT = ROOT / "artifacts" / "models"
SEED = 42

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

def clean_text(text: str) -> str:
    if not text:
        return ""
    cleaned = text.lower()
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
    args = parser.parse_args()

    fake = DATA / "Fake.csv"
    true = DATA / "True.csv"
    if not fake.exists() or not true.exists():
        raise SystemExit("Real ISOT CSVs are required; refusing to train on demo data.")
    if not (PREP / "stats.json").exists():
        raise SystemExit("Phase 2 preparation is missing.")

    articles = read_isot()
    split = {name: load_ids(name) for name in ["train", "val", "test", "temporal_test"]}

    train_x = [clean_text(article_text(articles[i])) for i in split["train"]]
    val_x = [clean_text(article_text(articles[i])) for i in split["val"]]
    test_x = [clean_text(article_text(articles[i])) for i in split["test"]]
    temp_x = [clean_text(article_text(articles[i])) for i in split["temporal_test"]]

    train_y = np.array([articles[i]["label"] for i in split["train"]])
    val_y = np.array([articles[i]["label"] for i in split["val"]])
    test_y = np.array([articles[i]["label"] for i in split["test"]])
    temp_y = np.array([articles[i]["label"] for i in split["temporal_test"]])

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
        "seed": SEED,
        "max_features": args.max_features,
        "tokenizer": "TruthLens Node cleanText + unigram/bigram analyzer",
    }
    version = "isot-runtime-svm-" + hashlib.sha256(
        json.dumps(version_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:12]
    out = Path(args.output_dir) / version
    out.mkdir(parents=True, exist_ok=False)

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
        "dataset_status": "ISOT CANDIDATE",
        "dataset_info": {
            "name": "ISOT Fake News Dataset",
            "source_path": "data/True.csv & data/Fake.csv",
            "total_samples": len(articles),
            "train_samples": len(train_x),
            "test_samples": len(test_x),
            "real_samples": sum(a["label"] == 0 for a in articles.values()),
            "fake_samples": sum(a["label"] == 1 for a in articles.values()),
            "vocabulary_size": len(vocab),
            "is_demo": False,
            "dataset_status": "ISOT CANDIDATE",
            "evaluation_status": "Group-aware Phase 2 split; candidate only",
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
            "fake_threshold": 0.65,
            "real_threshold": 0.35,
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

    liar_path = ROOT / "test.tsv"
    if not liar_path.exists():
        raise SystemExit("LIAR test.tsv is required for the OOD gate.")
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
        "dataset_name": "ISOT Fake News Dataset",
        "dataset_fingerprint": version_payload,
        "preparation_config": {
            "phase2_splits": "group-aware near-duplicate split + temporal split",
            "seed": SEED,
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
        "test": selected_test,
        "temporal_test": selected_temp,
        "ood_liar": ood,
        "artifact_sha256": manifest["artifact_sha256"],
        "production_artifact_modified": False,
    }, indent=2))

if __name__ == "__main__":
    main()
