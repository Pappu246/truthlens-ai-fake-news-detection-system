#!/usr/bin/env python3
"""VALID-only experiment harness for the LIAR claim model.

This script NEVER reads the TEST split. It exists so that model ideas can be
compared honestly before one configuration is frozen and evaluated once by
scripts/train_liar_claim.py.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, roc_auc_score
from sklearn.svm import LinearSVC
from scipy.sparse import csr_matrix, hstack

sys.path.insert(0, str(Path(__file__).resolve().parent))
from liar_common import analyzer, build_splits, meta_features  # noqa: E402

SEED = 42


def platt(raw_va, yva, raw_eval):
    cal = LogisticRegression(C=1e6, max_iter=5000, solver="lbfgs", random_state=SEED)
    cal.fit(raw_va.reshape(-1, 1), yva)
    return cal.predict_proba(raw_eval.reshape(-1, 1))[:, 1]


def ev(y, p):
    pred = (p >= 0.5).astype(int)
    return (accuracy_score(y, pred), f1_score(y, pred, average="macro", zero_division=0),
            roc_auc_score(y, p))


def run(label, Xtr, ytr, Xva, yva, clf):
    clf.fit(Xtr, ytr)
    raw = clf.decision_function(Xva)
    p = platt(raw, yva, raw)  # in-sample Platt: monotone, does not change ranking/threshold much
    a, f, auc = ev(yva, p)
    print(f"{label:<58} acc={a:.4f} macroF1={f:.4f} auc={auc:.4f}")
    return f


def main():
    s = build_splits()
    s.pop("_policy")
    tr, va = s["train"], s["valid"]
    ytr = np.array([r["y"] for r in tr])
    yva = np.array([r["y"] for r in va])
    st_tr = [r["statement"] for r in tr]
    st_va = [r["statement"] for r in va]

    print("=== E1: word tf-idf, LinearSVC vs LogisticRegression ===")
    for mindf in (1, 2, 3):
        v = TfidfVectorizer(analyzer=analyzer, min_df=mindf, sublinear_tf=True)
        A, B = v.fit_transform(st_tr), v.transform(st_va)
        for C in (0.02, 0.05, 0.1, 0.25):
            run(f"word min_df={mindf} SVC C={C}", A, ytr, B, yva,
                LinearSVC(C=C, max_iter=20000, random_state=SEED, dual="auto", class_weight="balanced"))
        for C in (0.5, 1.0, 4.0):
            run(f"word min_df={mindf} LR C={C}", A, ytr, B, yva,
                LogisticRegression(C=C, max_iter=3000, solver="liblinear", random_state=SEED,
                                   class_weight="balanced"))

    print("\n=== E2: char_wb n-grams ===")
    for ng in ((2, 4), (3, 5)):
        v = TfidfVectorizer(analyzer="char_wb", ngram_range=ng, min_df=2, sublinear_tf=True,
                            lowercase=True)
        A, B = v.fit_transform(st_tr), v.transform(st_va)
        for C in (0.05, 0.25, 1.0):
            run(f"char_wb{ng} SVC C={C}", A, ytr, B, yva,
                LinearSVC(C=C, max_iter=20000, random_state=SEED, dual="auto", class_weight="balanced"))

    print("\n=== E3: metadata block, de-leaked (self-count removed) ===")
    v = TfidfVectorizer(analyzer=analyzer, min_df=2, sublinear_tf=True)
    A, B = v.fit_transform(st_tr), v.transform(st_va)
    Mtr = csr_matrix(np.array([meta_features(r, True) for r in tr]))
    Mva = csr_matrix(np.array([meta_features(r, True) for r in va]))
    for C in (0.05, 0.25, 1.0):
        run(f"text+meta(de-leaked) SVC C={C}", hstack([A, Mtr]).tocsr(), ytr,
            hstack([B, Mva]).tocsr(), yva,
            LinearSVC(C=C, max_iter=20000, random_state=SEED, dual="auto", class_weight="balanced"))

    print("\n=== E4: metadata block WITH self-count leakage (diagnostic only) ===")
    Ltr = csr_matrix(np.array([meta_features(r, False) for r in tr]))
    Lva = csr_matrix(np.array([meta_features(r, False) for r in va]))
    for C in (0.05, 0.25, 1.0):
        run(f"text+meta(LEAKY) SVC C={C}", hstack([A, Ltr]).tocsr(), ytr,
            hstack([B, Lva]).tocsr(), yva,
            LinearSVC(C=C, max_iter=20000, random_state=SEED, dual="auto", class_weight="balanced"))

    print("\n=== E5: metadata ONLY (no text) ===")
    for C in (0.25, 1.0):
        run(f"meta-only de-leaked SVC C={C}", Mtr, ytr, Mva, yva,
            LinearSVC(C=C, max_iter=20000, random_state=SEED, dual="auto", class_weight="balanced"))
        run(f"meta-only LEAKY SVC C={C}", Ltr, ytr, Lva, yva,
            LinearSVC(C=C, max_iter=20000, random_state=SEED, dual="auto", class_weight="balanced"))

    print("\n=== E6: word + subject/speaker/context text channels ===")
    def blob(r):
        return " ".join([r["statement"], r["subjects"].replace(",", " "), r["context"]])
    v2 = TfidfVectorizer(analyzer=analyzer, min_df=2, sublinear_tf=True)
    A2, B2 = v2.fit_transform([blob(r) for r in tr]), v2.transform([blob(r) for r in va])
    for C in (0.05, 0.25):
        run(f"statement+subject+context SVC C={C}", A2, ytr, B2, yva,
            LinearSVC(C=C, max_iter=20000, random_state=SEED, dual="auto", class_weight="balanced"))

    print("\n=== E7: word+char union (text only) ===")
    vw = TfidfVectorizer(analyzer=analyzer, min_df=2, sublinear_tf=True)
    vc = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3, sublinear_tf=True)
    Aw, Bw = vw.fit_transform(st_tr), vw.transform(st_va)
    Ac, Bc = vc.fit_transform(st_tr), vc.transform(st_va)
    U, Uv = hstack([Aw, Ac]).tocsr(), hstack([Bw, Bc]).tocsr()
    for C in (0.05, 0.1, 0.25, 1.0):
        run(f"word+char SVC C={C}", U, ytr, Uv, yva,
            LinearSVC(C=C, max_iter=20000, random_state=SEED, dual="auto", class_weight="balanced"))


if __name__ == "__main__":
    main()
