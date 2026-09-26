#!/usr/bin/env python3
"""Train the TruthLens dedicated CLAIM model on the LIAR dataset.

Two variants are trained from the SAME split and the SAME tokenizer:

  text_only  -- statement text only. This is the variant used for serving
                whenever the caller supplies no speaker metadata, because
                serving a metadata-trained model with zeroed metadata would
                be a silently mis-specified model.
  text_meta  -- statement text + de-leaked speaker credit-history block.
                Used only when the caller supplies real metadata.

Protocol guarantees:
  * hyper-parameter selection and Platt calibration use TRAIN/VALID only,
  * TEST is read exactly once, at the end, for reporting,
  * the decision threshold is fixed at 0.50 and is never tuned on TEST,
  * no row of VALID/TEST is dropped, no label is ever rewritten.

Outputs data/claim_model_artifacts.json (the runtime artifact consumed by
server/claimModel.ts) and docs/claim_model_report.json.
"""
from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, average_precision_score,
                             brier_score_loss, confusion_matrix, f1_score,
                             precision_score, recall_score, roc_auc_score)
from sklearn.svm import LinearSVC

sys.path.insert(0, str(Path(__file__).resolve().parent))
from liar_common import (DATA, META_FEATURE_NAMES, ROOT, analyzer,  # noqa: E402
                         build_splits, dataset_fingerprint, meta_features)

SEED = 42
MODEL_VERSION = "1.1.0-liar-claim"
DECISION_THRESHOLD = 0.50
TFIDF = {"analyzer": analyzer, "min_df": 2, "sublinear_tf": True, "norm": "l2",
         "smooth_idf": True, "use_idf": True}
# Candidate grid explored on VALID only.
C_GRID = (0.05, 0.1, 0.25, 0.5, 1.0, 2.0)


def git_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    except Exception:
        return "unknown"


def score_metrics(y: np.ndarray, p: np.ndarray, thr: float = DECISION_THRESHOLD) -> dict:
    pred = (p >= thr).astype(int)
    return {
        "n": int(len(y)),
        "threshold": thr,
        "accuracy": float(accuracy_score(y, pred)),
        "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)),
        "f1": float(f1_score(y, pred, zero_division=0)),
        "macro_f1": float(f1_score(y, pred, average="macro", zero_division=0)),
        "roc_auc": float(roc_auc_score(y, p)),
        "pr_auc": float(average_precision_score(y, p)),
        "brier": float(brier_score_loss(y, p)),
        "confusion_matrix": confusion_matrix(y, pred, labels=[0, 1]).tolist(),
        "confusion_matrix_layout": "[[TN, FP], [FN, TP]] with 1 = TRUE claim",
    }


def platt_fit(raw_val: np.ndarray, y_val: np.ndarray):
    """Fit the Platt sigmoid on the disjoint VALID split only."""
    cal = LogisticRegression(C=1e6, max_iter=5000, solver="lbfgs", random_state=SEED)
    cal.fit(raw_val.reshape(-1, 1), y_val)
    coef = float(cal.coef_[0, 0])
    inter = float(cal.intercept_[0])
    # Runtime form: P = 1 / (1 + exp(A*z + B))
    return -coef, -inter


def platt_apply(z: np.ndarray, a: float, b: float) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(np.clip(a * z + b, -50, 50)))


def stack(text_matrix, meta: np.ndarray | None):
    if meta is None:
        return text_matrix
    from scipy.sparse import csr_matrix, hstack
    return hstack([text_matrix, csr_matrix(meta)]).tocsr()


def train_variant(name, splits, use_meta, log, remove_self=True):
    tr, va, te = splits["train"], splits["valid"], splits["test"]
    ytr = np.array([r["y"] for r in tr])
    yva = np.array([r["y"] for r in va])
    yte = np.array([r["y"] for r in te])

    vec = TfidfVectorizer(**TFIDF)
    Xtr_t = vec.fit_transform([r["statement"] for r in tr])
    Xva_t = vec.transform([r["statement"] for r in va])
    Xte_t = vec.transform([r["statement"] for r in te])

    if use_meta:
        Mtr = np.array([meta_features(r, remove_self) for r in tr], dtype=float)
        Mva = np.array([meta_features(r, remove_self) for r in va], dtype=float)
        Mte = np.array([meta_features(r, remove_self) for r in te], dtype=float)
    else:
        Mtr = Mva = Mte = None

    Xtr, Xva, Xte = stack(Xtr_t, Mtr), stack(Xva_t, Mva), stack(Xte_t, Mte)

    # ---- model + hyper-parameter selection on VALID only -------------------
    search = []
    best = None
    for C in C_GRID:
        svm = LinearSVC(C=C, max_iter=20000, random_state=SEED, dual="auto",
                        class_weight="balanced")
        svm.fit(Xtr, ytr)
        raw_va = svm.decision_function(Xva)
        a, b = platt_fit(raw_va, yva)
        pva = platt_apply(raw_va, a, b)
        m = score_metrics(yva, pva)
        search.append({"C": C, "valid_macro_f1": m["macro_f1"], "valid_accuracy": m["accuracy"]})
        log(f"  [{name}] C={C:<5} valid macro-F1={m['macro_f1']:.4f} acc={m['accuracy']:.4f}")
        if best is None or m["macro_f1"] > best["valid"]["macro_f1"]:
            best = {"C": C, "svm": svm, "a": a, "b": b, "valid": m}

    svm, a, b = best["svm"], best["a"], best["b"]
    log(f"  [{name}] selected C={best['C']} on VALID macro-F1={best['valid']['macro_f1']:.4f}")

    # ---- TEST is touched exactly here, once -------------------------------
    pte = platt_apply(svm.decision_function(Xte), a, b)
    test_metrics = score_metrics(yte, pte)
    log(f"  [{name}] TEST accuracy={test_metrics['accuracy']:.4f} "
        f"macro-F1={test_metrics['macro_f1']:.4f}")

    vocab = {t: int(i) for t, i in vec.vocabulary_.items()}
    weights = svm.coef_[0].astype(float).tolist()
    return {
        "variant": name,
        "uses_metadata": use_meta,
        "self_count_removed": bool(remove_self) if use_meta else None,
        "hyperparameters": {"C": best["C"], "class_weight": "balanced",
                            "loss": "squared_hinge", "max_iter": 20000, "seed": SEED},
        "hyperparameter_search": search,
        "vocabulary": vocab,
        "idf": [float(x) for x in vec.idf_],
        "meta_feature_names": list(META_FEATURE_NAMES) if use_meta else [],
        "weights": weights,
        "bias": float(svm.intercept_[0]),
        "plattA": a,
        "plattB": b,
        "metrics": {"valid": best["valid"], "test": test_metrics},
    }, (Xte, yte, pte, [r["statement"] for r in te], te)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DATA / "claim_model_artifacts.json"))
    ap.add_argument("--report", default=str(ROOT / "docs" / "claim_model_report.json"))
    ap.add_argument("--parity-fixtures", default=str(DATA / "claim_parity_fixtures.json"))
    args = ap.parse_args()

    def log(msg):
        print(msg, flush=True)

    splits = build_splits()
    policy = splits.pop("_policy")
    log("LIAR binary split (TRUE = true|mostly-true, FALSE = false|pants-fire)")
    for k in ("train", "valid", "test"):
        rows = splits[k]
        pos = sum(r["y"] for r in rows)
        log(f"  {k.upper():5} n={len(rows):5}  TRUE={pos:4}  FALSE={len(rows)-pos:4}")
    log(f"  TRAIN duplicates removed        : {policy['train_duplicates_removed']}")
    log(f"  TRAIN cross-split leaks removed : {policy['train_leakage_rows_removed']}")

    log("\nTraining text_only variant (serving default)")
    text_only, holdout = train_variant("text_only", splits, False, log)
    log("\nTraining text_meta variant (metadata-conditioned benchmark)")
    text_meta, _ = train_variant("text_meta", splits, True, log)
    log("\nTraining text_meta_raw_credit variant (LEAKAGE DIAGNOSTIC -- never served)")
    leaky, _ = train_variant("text_meta_raw_credit", splits, True, log, remove_self=False)

    fingerprint = dataset_fingerprint()
    artifact = {
        "model_name": "TruthLens Claim Model (LIAR)",
        "model_type": "Linear SVM (Calibrated)",
        "model_version": MODEL_VERSION,
        "model_role": "claim_model",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "git_sha": git_sha(),
        "python": platform.python_version(),
        "dataset": {
            "name": "LIAR (Wang, 2017)",
            "task": "binary claim veracity",
            "label_mapping": {"1": "TRUE (true, mostly-true)", "0": "FALSE (false, pants-fire)"},
            "excluded_labels": ["half-true", "barely-true"],
            "exclusion_rationale": (
                "half-true and barely-true are ordinal middle classes; collapsing them "
                "into either pole injects label noise, so they are excluded from all splits."
            ),
            "split_policy": (
                "TRAIN: binary filter -> intra-split statement de-duplication -> removal of "
                "statements that also occur in VALID or TEST. VALID and TEST: binary filter only; "
                "no row is ever removed from a held-out split."
            ),
            "counts": {k: len(splits[k]) for k in ("train", "valid", "test")},
            "train_duplicates_removed": policy["train_duplicates_removed"],
            "train_leakage_rows_removed": policy["train_leakage_rows_removed"],
            "fingerprint_sha256": fingerprint,
        },
        "preprocessing": {
            "lowercase": True, "strip_urls": True, "strip_html": True,
            "strip_punctuation": True, "remove_stopwords": True,
            "min_token_length": 3, "ngram_range": [1, 2], "sublinear_tf": True,
            "norm": "l2", "min_df": 2,
            "tokenizer_contract": "scripts/liar_common.py::analyzer == server/claimModel.ts::tokenize",
        },
        "decision_threshold": DECISION_THRESHOLD,
        "threshold_policy": "Fixed at 0.50. Never tuned on TEST.",
        "calibration": "Platt sigmoid fitted on the disjoint VALID split",
        "variants": {"text_only": text_only, "text_meta": text_meta},
        "serving": {
            "default_variant": "text_only",
            "metadata_variant": "text_meta",
            "metadata_required_fields": ["speaker_credit_history"],
            "limitation": (
                "text_meta was trained with a speaker credit-history block. It is used ONLY when the "
                "caller supplies that metadata. When metadata is absent the API serves text_only and "
                "reports metadata_available=false; it never evaluates text_meta with zero-filled "
                "metadata, because that is a mis-specified model and its accuracy claim would not hold."
            ),
        },
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(artifact, separators=(",", ":")))
    log(f"\nWrote runtime artifact -> {out} ({out.stat().st_size/1024:.0f} KB)")

    # Parity fixtures: full TEST set scored by Python, for the Node parity check.
    Xte, yte, pte, statements, te_rows = holdout
    # Metadata-variant fixtures use the same de-leaked credit counts the API
    # receives from a caller, so the Node scorer is exercised end to end.
    from liar_common import credit_counts as _cc
    mv = artifact["variants"]["text_meta"]
    mvocab, midf, mW = mv["vocabulary"], mv["idf"], mv["weights"]
    mV = len(mvocab)
    import math as _math
    from collections import Counter as _Counter

    def _meta_prob(rec):
        c = _Counter(analyzer(rec["statement"]))
        vec, nsq = [], 0.0
        for t, k in c.items():
            i = mvocab.get(t)
            if i is None:
                continue
            val = (1.0 + _math.log(k)) * midf[i]
            vec.append((i, val))
            nsq += val * val
        nrm = _math.sqrt(nsq) or 1.0
        z = mv["bias"] + sum(mW[i] * (val / nrm) for i, val in vec)
        mf = meta_features(rec, True)
        z += sum(mW[mV + j] * mf[j] for j in range(len(mf)))
        return 1.0 / (1.0 + _math.exp(max(-50.0, min(50.0, mv["plattA"] * z + mv["plattB"]))))

    meta_rows = []
    order = ["barely_true_count", "false_count", "half_true_count",
             "mostly_true_count", "pants_on_fire_count"]
    for rec in te_rows:
        cc = _cc(rec, True)
        meta_rows.append({
            "id": rec["id"],
            "statement": rec["statement"],
            "y": rec["y"],
            "metadata": {"speaker": rec["speaker"], "party": rec["party"],
                         "credit_history": {k: cc[k] for k in order}},
            "python_probability": _meta_prob(rec),
        })
    meta_probs = None
    fixtures = {
        "model_version": MODEL_VERSION,
        "variant": "text_only",
        "threshold": DECISION_THRESHOLD,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "rows": [
            {"id": te_rows[i]["id"], "statement": statements[i],
             "y": int(yte[i]), "python_probability": float(pte[i])}
            for i in range(len(statements))
        ],
        "meta_rows": meta_rows,
    }
    fx = Path(args.parity_fixtures)
    fx.write_text(json.dumps(fixtures, separators=(",", ":")))
    log(f"Wrote parity fixtures  -> {fx} ({len(fixtures['rows'])} text_only rows, "
        f"{len(meta_rows)} text_meta rows)")

    report = {
        "model_version": MODEL_VERSION,
        "generated_at": artifact["trained_at"],
        "git_sha": artifact["git_sha"],
        "dataset": artifact["dataset"],
        "protocol": {
            "selection": "LinearSVC C grid searched on VALID macro-F1 only",
            "calibration": artifact["calibration"],
            "threshold": DECISION_THRESHOLD,
            "test_usage": "read once, after selection and calibration were frozen",
            "forbidden": ["training on test", "tuning on test", "dropping test rows",
                          "rewriting labels", "threshold tuning for score inflation"],
        },
        "results": {
            "text_only": {"valid": text_only["metrics"]["valid"], "test": text_only["metrics"]["test"],
                          "selected_C": text_only["hyperparameters"]["C"]},
            "text_meta": {"valid": text_meta["metrics"]["valid"], "test": text_meta["metrics"]["test"],
                          "selected_C": text_meta["hyperparameters"]["C"]},
            "text_meta_raw_credit_DIAGNOSTIC_ONLY": {
                "valid": leaky["metrics"]["valid"], "test": leaky["metrics"]["test"],
                "selected_C": leaky["hyperparameters"]["C"],
                "why_not_served": (
                    "Trained with the LIAR speaker credit-history columns exactly as shipped. Those "
                    "columns already contain the current statement's own verdict, so the target label "
                    "is present in the features. A metadata-only model with these raw counts and no "
                    "text at all reaches ~0.76 accuracy, which is where inflated 'LIAR ~76%' figures "
                    "come from. This variant is trained only to quantify that leak. It is never "
                    "exported to the runtime artifact and never served."
                ),
            },
        },
        "leakage_audit": {
            "finding": (
                "LIAR's five credit-history count columns include the verdict of the statement they "
                "accompany. Left untouched they leak the label."
            ),
            "mitigation": "The statement's own contribution is subtracted before the features are built.",
            "measured_effect_on_test_accuracy": round(
                leaky["metrics"]["test"]["accuracy"] - text_meta["metrics"]["test"]["accuracy"], 4),
            "metadata_only_probe": "see docs/CLAIM_MODEL.md",
        },
        "known_limitations": [
            "LIAR speaker credit-history counts aggregate a speaker's record across the whole "
            "corpus. The current statement's own contribution is subtracted, but statements by "
            "the same speaker in other splits still inform the counts. text_meta numbers must be "
            "read as metadata-conditioned, not as text-understanding performance.",
            "half-true and barely-true claims are out of scope for this binary model.",
            "LIAR is US political fact-checking from 2007-2016; performance on other domains or "
            "later periods is not established by these numbers.",
        ],
    }
    rp = Path(args.report)
    rp.parent.mkdir(parents=True, exist_ok=True)
    rp.write_text(json.dumps(report, indent=2) + "\n")
    log(f"Wrote report           -> {rp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
