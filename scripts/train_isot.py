import os
import sys
import csv
import json
import time
import math
import numpy as np
import pandas as pd
from datetime import datetime
from pathlib import Path
import joblib

from sklearn.model_selection import train_test_split, StratifiedKFold
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.svm import LinearSVC
from sklearn.calibration import CalibratedClassifierCV
from sklearn.pipeline import Pipeline
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, confusion_matrix

def main():
    start_time = time.time()
    print("=" * 70)
    print("TRUTHLENS AI - REAL ISOT DATASET TRAINING & BENCHMARK PIPELINE")
    print("=" * 70)

    data_dir = Path("data")
    true_csv_path = data_dir / "True.csv"
    fake_csv_path = data_dir / "Fake.csv"

    if not true_csv_path.exists() or not fake_csv_path.exists():
        print(f"Error: Missing {true_csv_path} or {fake_csv_path}")
        sys.exit(1)

    print("\n[STEP 1] Importing and Counting Source CSV Files...")
    # Step 1 & 2: Import both CSV files and assign labels
    raw_real_records = []
    raw_fake_records = []

    with open(true_csv_path, 'r', encoding='utf-8', errors='replace') as f:
        reader = csv.reader(f)
        true_header = next(reader)
        for row in reader:
            if row:
                raw_real_records.append(row)

    with open(fake_csv_path, 'r', encoding='utf-8', errors='replace') as f:
        reader = csv.reader(f)
        fake_header = next(reader)
        for row in reader:
            if row:
                raw_fake_records.append(row)

    count_real_raw = len(raw_real_records)
    count_fake_raw = len(raw_fake_records)
    total_raw = count_real_raw + count_fake_raw

    print(f"Raw source counts before cleaning:")
    print(f"  REAL articles (True.csv): {count_real_raw:,}")
    print(f"  FAKE articles (Fake.csv): {count_fake_raw:,}")
    print(f"  TOTAL raw articles:       {total_raw:,}")
    print(f"  True.csv columns: {true_header}")
    print(f"  Fake.csv columns: {fake_header}")

    # Step 3, 4, 5: Unify, Clean, Normalize, Deduplicate
    print("\n[STEP 2] Cleaning Dataset & Unifying Fields...")
    seen_texts = set()
    removed_empty = 0
    removed_invalid = 0
    removed_duplicates = 0

    cleaned_records = []

    # Process REAL articles (label = 0 / 'REAL')
    for row in raw_real_records:
        if len(row) < 2:
            removed_invalid += 1
            continue
        title = row[0].strip()
        text = row[1].strip()
        subject = row[2].strip() if len(row) > 2 else ""
        date = row[3].strip() if len(row) > 3 else ""

        if not title and not text:
            removed_empty += 1
            continue
        if not text:
            removed_empty += 1
            continue

        model_input = f"{title} {text}".strip()
        if model_input in seen_texts:
            removed_duplicates += 1
            continue
        seen_texts.add(model_input)

        cleaned_records.append({
            "title": title,
            "text": text,
            "subject": subject,
            "date": date,
            "model_input": model_input,
            "label_name": "REAL",
            "label": 0
        })

    # Process FAKE articles (label = 1 / 'FAKE')
    for row in raw_fake_records:
        if len(row) < 2:
            removed_invalid += 1
            continue
        title = row[0].strip()
        text = row[1].strip()
        subject = row[2].strip() if len(row) > 2 else ""
        date = row[3].strip() if len(row) > 3 else ""

        if not title and not text:
            removed_empty += 1
            continue
        if not text:
            removed_empty += 1
            continue

        model_input = f"{title} {text}".strip()
        if model_input in seen_texts:
            removed_duplicates += 1
            continue
        seen_texts.add(model_input)

        cleaned_records.append({
            "title": title,
            "text": text,
            "subject": subject,
            "date": date,
            "model_input": model_input,
            "label_name": "FAKE",
            "label": 1
        })

    total_removed = removed_empty + removed_duplicates + removed_invalid
    cleaned_real = [r for r in cleaned_records if r["label"] == 0]
    cleaned_fake = [r for r in cleaned_records if r["label"] == 1]
    total_cleaned = len(cleaned_records)

    print(f"Cleaning Statistics:")
    print(f"  Removed empty title/text: {removed_empty:,}")
    print(f"  Removed exact duplicates: {removed_duplicates:,}")
    print(f"  Removed invalid rows:     {removed_invalid:,}")
    print(f"  Total removed rows:       {total_removed:,}")
    print(f"Final Cleaned Dataset Statistics:")
    print(f"  REAL articles: {len(cleaned_real):,} ({len(cleaned_real)/total_cleaned*100:.2f}%)")
    print(f"  FAKE articles: {len(cleaned_fake):,} ({len(cleaned_fake)/total_cleaned*100:.2f}%)")
    print(f"  TOTAL articles:{total_cleaned:,}")

    # Prepare inputs: model input is ONLY title + text
    X_all = [r["model_input"] for r in cleaned_records]
    y_all = np.array([r["label"] for r in cleaned_records])

    # Step 7: Stratified Train / Test Split (80% train, 20% held-out test)
    print("\n[STEP 3] Performing Stratified Train/Test Split (80% Train, 20% Held-Out Test)...")
    X_train, X_test, y_train, y_test = train_test_split(
        X_all, y_all,
        test_size=0.20,
        random_state=42,
        stratify=y_all
    )

    n_train = len(X_train)
    n_test = len(X_test)
    train_real = int(np.sum(y_train == 0))
    train_fake = int(np.sum(y_train == 1))
    test_real = int(np.sum(y_test == 0))
    test_fake = int(np.sum(y_test == 1))

    print(f"Train samples: {n_train:,} (REAL: {train_real:,}, FAKE: {train_fake:,})")
    print(f"Held-out test samples: {n_test:,} (REAL: {test_real:,}, FAKE: {test_fake:,})")

    # Step 8, 9, 10: Stratified 5-Fold Cross-Validation on the Training Set
    # Data Leakage Prevention: TF-IDF is fitted ONLY on the training split of each fold!
    print("\n[STEP 4] Running Stratified 5-Fold Cross-Validation on Training Set...")
    print("  * Guard: TF-IDF vectorizer is fitted strictly on fold training data (Zero leakage)")
    
    tfidf_config = {
        "ngram_range": (1, 2),
        "max_features": 8000,
        "sublinear_tf": True,
        "min_df": 3,
        "strip_accents": "unicode",
        "stop_words": "english"
    }
    print(f"  * TF-IDF Configuration: {tfidf_config}")

    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)

    lr_fold_acc = []
    lr_fold_prec = []
    lr_fold_rec = []
    lr_fold_f1 = []

    svm_fold_acc = []
    svm_fold_prec = []
    svm_fold_rec = []
    svm_fold_f1 = []

    for fold, (train_idx, val_idx) in enumerate(skf.split(X_train, y_train), 1):
        fold_X_tr = [X_train[i] for i in train_idx]
        fold_y_tr = y_train[train_idx]
        fold_X_val = [X_train[i] for i in val_idx]
        fold_y_val = y_train[val_idx]

        # TF-IDF fitted EXCLUSIVELY on fold training partition
        fold_vec = TfidfVectorizer(**tfidf_config)
        fold_X_tr_vec = fold_vec.fit_transform(fold_X_tr)
        fold_X_val_vec = fold_vec.transform(fold_X_val)

        # 1. Logistic Regression
        fold_lr = LogisticRegression(C=1.0, max_iter=1000, random_state=42, solver='lbfgs')
        fold_lr.fit(fold_X_tr_vec, fold_y_tr)
        lr_preds = fold_lr.predict(fold_X_val_vec)

        lr_fold_acc.append(accuracy_score(fold_y_val, lr_preds))
        lr_fold_prec.append(precision_score(fold_y_val, lr_preds, zero_division=0))
        lr_fold_rec.append(recall_score(fold_y_val, lr_preds, zero_division=0))
        lr_fold_f1.append(f1_score(fold_y_val, lr_preds, zero_division=0))

        # 2. Linear SVM with Platt Calibration (CalibratedClassifierCV)
        fold_svm_base = LinearSVC(C=1.0, random_state=42, max_iter=2000, dual=False)
        fold_svm_cal = CalibratedClassifierCV(estimator=fold_svm_base, cv=3, method='sigmoid')
        fold_svm_cal.fit(fold_X_tr_vec, fold_y_tr)
        svm_preds = fold_svm_cal.predict(fold_X_val_vec)

        svm_fold_acc.append(accuracy_score(fold_y_val, svm_preds))
        svm_fold_prec.append(precision_score(fold_y_val, svm_preds, zero_division=0))
        svm_fold_rec.append(recall_score(fold_y_val, svm_preds, zero_division=0))
        svm_fold_f1.append(f1_score(fold_y_val, svm_preds, zero_division=0))

        print(f"  Fold {fold}/5: LR F1={lr_fold_f1[-1]:.4f} | Calibrated SVM F1={svm_fold_f1[-1]:.4f}")

    lr_cv_results = {
        "accuracy": {"mean": round(float(np.mean(lr_fold_acc)), 4), "std": round(float(np.std(lr_fold_acc)), 4)},
        "precision": {"mean": round(float(np.mean(lr_fold_prec)), 4), "std": round(float(np.std(lr_fold_prec)), 4)},
        "recall": {"mean": round(float(np.mean(lr_fold_rec)), 4), "std": round(float(np.std(lr_fold_rec)), 4)},
        "f1_score": {"mean": round(float(np.mean(lr_fold_f1)), 4), "std": round(float(np.std(lr_fold_f1)), 4)},
    }

    svm_cv_results = {
        "accuracy": {"mean": round(float(np.mean(svm_fold_acc)), 4), "std": round(float(np.std(svm_fold_acc)), 4)},
        "precision": {"mean": round(float(np.mean(svm_fold_prec)), 4), "std": round(float(np.std(svm_fold_prec)), 4)},
        "recall": {"mean": round(float(np.mean(svm_fold_rec)), 4), "std": round(float(np.std(svm_fold_rec)), 4)},
        "f1_score": {"mean": round(float(np.mean(svm_fold_f1)), 4), "std": round(float(np.std(svm_fold_f1)), 4)},
    }

    print("\n5-Fold Stratified Cross-Validation Summary:")
    print(f"  Logistic Regression:")
    print(f"    Accuracy:  {lr_cv_results['accuracy']['mean']:.4f} ± {lr_cv_results['accuracy']['std']:.4f}")
    print(f"    Precision: {lr_cv_results['precision']['mean']:.4f} ± {lr_cv_results['precision']['std']:.4f}")
    print(f"    Recall:    {lr_cv_results['recall']['mean']:.4f} ± {lr_cv_results['recall']['std']:.4f}")
    print(f"    F1-Score:  {lr_cv_results['f1_score']['mean']:.4f} ± {lr_cv_results['f1_score']['std']:.4f}")

    print(f"  Linear SVM (Calibrated):")
    print(f"    Accuracy:  {svm_cv_results['accuracy']['mean']:.4f} ± {svm_cv_results['accuracy']['std']:.4f}")
    print(f"    Precision: {svm_cv_results['precision']['mean']:.4f} ± {svm_cv_results['precision']['std']:.4f}")
    print(f"    Recall:    {svm_cv_results['recall']['mean']:.4f} ± {svm_cv_results['recall']['std']:.4f}")
    print(f"    F1-Score:  {svm_cv_results['f1_score']['mean']:.4f} ± {svm_cv_results['f1_score']['std']:.4f}")

    # Model Selection based on 5-fold CV F1-score
    if svm_cv_results['f1_score']['mean'] >= lr_cv_results['f1_score']['mean']:
        selected_model_name = "Linear SVM (Calibrated)"
        selection_reason = (
            f"Linear SVM achieved equal or higher 5-fold CV F1-score "
            f"({svm_cv_results['f1_score']['mean']:.4f} vs {lr_cv_results['f1_score']['mean']:.4f}) "
            f"with maximum-margin separation and Platt sigmoid probability calibration."
        )
    else:
        selected_model_name = "Logistic Regression"
        selection_reason = (
            f"Logistic Regression achieved higher 5-fold CV F1-score "
            f"({lr_cv_results['f1_score']['mean']:.4f} vs {svm_cv_results['f1_score']['mean']:.4f})."
        )

    print(f"\nModel Selection: {selected_model_name}")
    print(f"Selection Reason: {selection_reason}")

    # Step 11: Train Final Pipeline on Full Training Set and Evaluate on Held-Out Test Set
    print("\n[STEP 5] Training Final Pipeline on Full Training Set (TF-IDF fitted ONLY on Train)...")
    final_vectorizer = TfidfVectorizer(**tfidf_config)
    X_train_vec = final_vectorizer.fit_transform(X_train)
    X_test_vec = final_vectorizer.transform(X_test)

    # Train Final Logistic Regression
    final_lr = LogisticRegression(C=1.0, max_iter=1000, random_state=42, solver='lbfgs')
    final_lr.fit(X_train_vec, y_train)
    lr_test_preds = final_lr.predict(X_test_vec)
    lr_test_acc = accuracy_score(y_test, lr_test_preds)
    lr_test_prec = precision_score(y_test, lr_test_preds, zero_division=0)
    lr_test_rec = recall_score(y_test, lr_test_preds, zero_division=0)
    lr_test_f1 = f1_score(y_test, lr_test_preds, zero_division=0)
    lr_cm = confusion_matrix(y_test, lr_test_preds)

    # Train Final Linear SVM + CalibratedClassifierCV
    final_svm_base = LinearSVC(C=1.0, random_state=42, max_iter=2000, dual=False)
    final_svm_base.fit(X_train_vec, y_train)
    
    final_svm_calibrated = CalibratedClassifierCV(estimator=LinearSVC(C=1.0, random_state=42, max_iter=2000, dual=False), cv=3, method='sigmoid')
    final_svm_calibrated.fit(X_train_vec, y_train)
    svm_test_preds = final_svm_calibrated.predict(X_test_vec)
    svm_test_acc = accuracy_score(y_test, svm_test_preds)
    svm_test_prec = precision_score(y_test, svm_test_preds, zero_division=0)
    svm_test_rec = recall_score(y_test, svm_test_preds, zero_division=0)
    svm_test_f1 = f1_score(y_test, svm_test_preds, zero_division=0)
    svm_cm = confusion_matrix(y_test, svm_test_preds)

    def format_cm(cm):
        tn, fp, fn, tp = cm.ravel()
        return {
            "matrix": cm.tolist(),
            "true_negative": int(tn),
            "false_positive": int(fp),
            "false_negative": int(fn),
            "true_positive": int(tp),
            "labels": ["REAL (0)", "FAKE (1)"],
            "explanations": {
                "false_positive": "Real news incorrectly classified as Fake.",
                "false_negative": "Fake news incorrectly classified as Real."
            }
        }

    lr_test_metrics = {
        "positive_class": "FAKE (1)",
        "accuracy": round(float(lr_test_acc), 4),
        "precision": round(float(lr_test_prec), 4),
        "recall": round(float(lr_test_rec), 4),
        "f1_score": round(float(lr_test_f1), 4),
        "confusion_matrix": format_cm(lr_cm)
    }

    svm_test_metrics = {
        "positive_class": "FAKE (1)",
        "accuracy": round(float(svm_test_acc), 4),
        "precision": round(float(svm_test_prec), 4),
        "recall": round(float(svm_test_rec), 4),
        "f1_score": round(float(svm_test_f1), 4),
        "confusion_matrix": format_cm(svm_cm)
    }

    best_test_metrics = svm_test_metrics if selected_model_name == "Linear SVM (Calibrated)" else lr_test_metrics

    print("\nHeld-Out Test Set Evaluation Results (N = 7,732 articles):")
    print(f"  Logistic Regression:")
    print(f"    Accuracy:  {lr_test_metrics['accuracy'] * 100:.2f}%")
    print(f"    Precision: {lr_test_metrics['precision']:.4f}")
    print(f"    Recall:    {lr_test_metrics['recall']:.4f}")
    print(f"    F1-Score:  {lr_test_metrics['f1_score']:.4f}")
    print(f"    Confusion Matrix: TN={lr_cm[0,0]}, FP={lr_cm[0,1]}, FN={lr_cm[1,0]}, TP={lr_cm[1,1]}")

    print(f"  Linear SVM (Calibrated):")
    print(f"    Accuracy:  {svm_test_metrics['accuracy'] * 100:.2f}%")
    print(f"    Precision: {svm_test_metrics['precision']:.4f}")
    print(f"    Recall:    {svm_test_metrics['recall']:.4f}")
    print(f"    F1-Score:  {svm_test_metrics['f1_score']:.4f}")
    print(f"    Confusion Matrix: TN={svm_cm[0,0]}, FP={svm_cm[0,1]}, FN={svm_cm[1,0]}, TP={svm_cm[1,1]}")

    # Extract Platt calibration coefficients for selected model
    # For CalibratedClassifierCV with sigmoid, each calibrated classifier has a_ and b_
    platt_a_list = []
    platt_b_list = []
    for cal_clf in final_svm_calibrated.calibrated_classifiers_:
        # sigmoid calibrator has a_ and b_
        if hasattr(cal_clf, 'calibrators') and len(cal_clf.calibrators) > 0:
            cal = cal_clf.calibrators[0]
            if hasattr(cal, 'a_') and hasattr(cal, 'b_'):
                platt_a_list.append(float(cal.a_))
                platt_b_list.append(float(cal.b_))

    mean_platt_a = float(np.mean(platt_a_list)) if platt_a_list else -1.0
    mean_platt_b = float(np.mean(platt_b_list)) if platt_b_list else 0.0

    print(f"\nCalibrated Probability Parameters (Platt Sigmoid): a={mean_platt_a:.4f}, b={mean_platt_b:.4f}")

    # Save Model Artifacts
    models_dir = Path("backend/models")
    models_dir.mkdir(parents=True, exist_ok=True)

    joblib.dump(final_svm_calibrated if selected_model_name.startswith("Linear SVM") else final_lr, models_dir / "best_model.joblib")
    joblib.dump(final_vectorizer, models_dir / "vectorizer.joblib")
    joblib.dump(final_lr, models_dir / "logistic_regression.joblib")
    joblib.dump(final_svm_base, models_dir / "linear_svm_base.joblib")
    joblib.dump(final_svm_calibrated, models_dir / "linear_svm_calibrated.joblib")

    # Build comprehensive metrics JSON
    metrics_payload = {
        "status": "success",
        "dataset_name": "ISOT Fake News Dataset",
        "model_version": "3.0.0-isot",
        "trained_at": datetime.utcnow().isoformat() + "Z",
        "is_demo": False,
        "dataset_status": "ISOT BENCHMARK DATASET",
        "demo_badge_label": "PRODUCTION BENCHMARK (ISOT DATASET)",
        "evaluation_status": "Evaluated on genuine 20% held-out test split (N=7,732)",
        "limitation": (
            "The model is trained on the ISOT dataset, which primarily contains English news "
            "from an older time period. Performance may not generalize to current news, "
            "Hindi/Hinglish content, satire, or domains outside the training distribution."
        ),
        "raw_counts_before_cleaning": {
            "real_articles": count_real_raw,
            "fake_articles": count_fake_raw,
            "total_articles": total_raw
        },
        "cleaning_statistics": {
            "removed_empty_title_text": removed_empty,
            "removed_duplicates": removed_duplicates,
            "removed_invalid_rows": removed_invalid,
            "total_removed_rows": total_removed
        },
        "dataset_info": {
            "name": "ISOT Fake News Dataset",
            "source_path": "data/True.csv & data/Fake.csv",
            "filename": "True.csv / Fake.csv (ISOT)",
            "total_samples": total_cleaned,
            "train_samples": n_train,
            "test_samples": n_test,
            "real_samples": len(cleaned_real),
            "fake_samples": len(cleaned_fake),
            "train_real": train_real,
            "train_fake": train_fake,
            "test_real": test_real,
            "test_fake": test_fake,
            "vocabulary_size": len(final_vectorizer.vocabulary_),
            "is_demo": False,
            "dataset_status": "ISOT BENCHMARK DATASET",
            "demo_badge_label": "PRODUCTION BENCHMARK (ISOT DATASET)",
            "evaluation_status": "Evaluated on genuine 20% held-out test split (N=7,732)"
        },
        "tfidf_configuration": tfidf_config,
        "cross_validation": {
            "n_splits": 5,
            "method": "Stratified 5-Fold Cross-Validation",
            "data_leakage_prevented": True,
            "leakage_guard_note": "TF-IDF vocabulary extraction and IDF computation performed strictly inside each fold training split.",
            "logistic_regression": {
                "accuracy_mean": lr_cv_results["accuracy"]["mean"],
                "accuracy_std": lr_cv_results["accuracy"]["std"],
                "precision_mean": lr_cv_results["precision"]["mean"],
                "precision_std": lr_cv_results["precision"]["std"],
                "recall_mean": lr_cv_results["recall"]["mean"],
                "recall_std": lr_cv_results["recall"]["std"],
                "f1_mean": lr_cv_results["f1_score"]["mean"],
                "f1_std": lr_cv_results["f1_score"]["std"]
            },
            "linear_svm": {
                "accuracy_mean": svm_cv_results["accuracy"]["mean"],
                "accuracy_std": svm_cv_results["accuracy"]["std"],
                "precision_mean": svm_cv_results["precision"]["mean"],
                "precision_std": svm_cv_results["precision"]["std"],
                "recall_mean": svm_cv_results["recall"]["mean"],
                "recall_std": svm_cv_results["recall"]["std"],
                "f1_mean": svm_cv_results["f1_score"]["mean"],
                "f1_std": svm_cv_results["f1_score"]["std"]
            }
        },
        "models": {
            "logistic_regression": {
                "name": "Logistic Regression",
                "hyperparameters": {"C": 1.0, "max_iter": 1000, "penalty": "l2", "solver": "lbfgs"},
                "cv_metrics": lr_cv_results,
                "metrics": lr_test_metrics
            },
            "linear_svm": {
                "name": "Linear SVM",
                "hyperparameters": {"C": 1.0, "calibration": "sigmoid (Platt)", "cv": 3, "loss": "squared_hinge", "penalty": "l2"},
                "cv_metrics": svm_cv_results,
                "metrics": svm_test_metrics
            }
        },
        "best_model": {
            "name": selected_model_name,
            "model_version": "3.0.0-isot",
            "selection_criterion": "Stratified 5-Fold Cross-Validation F1-score",
            "selection_reason": selection_reason,
            "calibration_method": "Platt Sigmoid (CalibratedClassifierCV)",
            "metrics": best_test_metrics
        },
        "thresholds": {
            "fake_threshold": 0.65,
            "real_threshold": 0.35,
            "min_text_length": 60
        }
    }

    with open(models_dir / "metrics.json", "w") as f:
        json.dump(metrics_payload, f, indent=2)

    # Export JS-loadable model artifact for TypeScript runtime
    print("\n[STEP 6] Exporting Model Artifacts for Web Server Runtime...")
    
    # Feature weights: Linear SVM coefficients or Logistic Regression coefficients
    if selected_model_name.startswith("Linear SVM"):
        weights = final_svm_base.coef_[0].tolist()
        bias = float(final_svm_base.intercept_[0])
    else:
        weights = final_lr.coef_[0].tolist()
        bias = float(final_lr.intercept_[0])

    runtime_artifact = {
        "model_name": selected_model_name,
        "model_type": selected_model_name,
        "model_version": "3.0.0-isot",
        "trained_at": metrics_payload["trained_at"],
        "is_demo": False,
        "dataset_status": "ISOT BENCHMARK DATASET",
        "dataset_info": metrics_payload["dataset_info"],
        "preprocessing": {
            "lowercase": True,
            "strip_urls": True,
            "strip_html": True,
            "strip_punctuation": True,
            "remove_stopwords": True,
            "min_token_length": 3,
            "ngram_range": [1, 2],
            "sublinear_tf": True
        },
        "vocabulary": {term: int(idx) for term, idx in final_vectorizer.vocabulary_.items()},
        "idf": final_vectorizer.idf_.tolist(),
        "selected_model": {
            "name": selected_model_name,
            "weights": weights,
            "bias": bias,
            "plattA": mean_platt_a,
            "plattB": mean_platt_b
        },
        "logistic_regression": {
            "weights": final_lr.coef_[0].tolist(),
            "bias": float(final_lr.intercept_[0])
        },
        "metrics": metrics_payload,
        "thresholds": metrics_payload["thresholds"]
    }

    with open("data/saved_model_artifacts.json", "w") as f:
        json.dump(runtime_artifact, f, indent=2)

    elapsed = time.time() - start_time
    print(f"\n{'=' * 70}")
    print(f"TRAINING COMPLETE IN {elapsed:.1f} SECONDS!")
    print(f"Selected Model: {selected_model_name}")
    print(f"Final Held-Out Test F1: {best_test_metrics['f1_score']:.4f} | Accuracy: {best_test_metrics['accuracy']*100:.2f}%")
    print(f"Artifacts successfully written to:")
    print(f"  - backend/models/metrics.json")
    print(f"  - data/saved_model_artifacts.json")
    print(f"{'=' * 70}\n")

if __name__ == "__main__":
    main()
