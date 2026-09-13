import os
import json
import joblib
import pandas as pd
import numpy as np
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Tuple

from sklearn.model_selection import train_test_split
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.svm import LinearSVC
from sklearn.calibration import CalibratedClassifierCV

from backend.config import (
    DEFAULT_DATASET_PATH,
    SAMPLE_DATASET_PATH,
    MODEL_ARTIFACT,
    VECTORIZER_ARTIFACT,
    METRICS_ARTIFACT,
    MODELS_DIR
)
from backend.ml.preprocess import clean_text
from backend.ml.evaluate import compute_metrics

def load_and_validate_dataset(custom_path: str = None) -> Tuple[pd.DataFrame, str]:
    """
    Locates and validates the dataset.
    Intelligently identifies text and label columns.
    Normalizes labels to: 1 (FAKE), 0 (REAL).
    """
    target_path = Path(custom_path) if custom_path else DEFAULT_DATASET_PATH
    if not target_path.exists():
        if SAMPLE_DATASET_PATH.exists():
            target_path = SAMPLE_DATASET_PATH
        else:
            raise FileNotFoundError(f"Neither {DEFAULT_DATASET_PATH} nor {SAMPLE_DATASET_PATH} exists.")
            
    df = pd.read_csv(target_path)
    
    if df.empty:
        raise ValueError(f"Dataset at {target_path} is empty.")
        
    cols = [c.lower().strip() for c in df.columns]
    col_map = {orig: lower for orig, lower in zip(df.columns, cols)}
    
    # 1. Identify text column(s)
    text_col = None
    title_col = None
    for orig, lower in col_map.items():
        if lower in ['text', 'content', 'article', 'body']:
            text_col = orig
        elif lower in ['title', 'headline']:
            title_col = orig
            
    if not text_col:
        # Fallback to first string column with average length > 30
        for col in df.columns:
            if df[col].dtype == object and df[col].dropna().astype(str).str.len().mean() > 30:
                text_col = col
                break
                
    if not text_col:
        raise ValueError("Could not automatically locate an article text column in the dataset.")
        
    # Combine title + text if title exists
    if title_col and title_col != text_col:
        df["combined_text"] = df[title_col].fillna("").astype(str) + " " + df[text_col].fillna("").astype(str)
    else:
        df["combined_text"] = df[text_col].fillna("").astype(str)
        
    # 2. Identify label column
    label_col = None
    for orig, lower in col_map.items():
        if lower in ['label', 'target', 'class', 'category', 'fake']:
            label_col = orig
            break
            
    if not label_col:
        raise ValueError("Could not automatically locate a label column in the dataset.")
        
    # Normalize labels: FAKE -> 1, REAL -> 0
    def normalize_label(val):
        s = str(val).strip().upper()
        if s in ['1', 'FAKE', 'FALSE', 'UNRELIABLE', 'SPAM']:
            return 1
        elif s in ['0', 'REAL', 'TRUE', 'RELIABLE']:
            return 0
        try:
            num = int(float(val))
            return 1 if num == 1 else 0
        except Exception:
            return 1 if 'FAKE' in s else 0

    df["normalized_label"] = df[label_col].apply(normalize_label)
    
    # Clean text
    df["cleaned_text"] = df["combined_text"].apply(lambda t: clean_text(t, remove_stopwords=True))
    
    # Filter out empty texts
    df = df[df["cleaned_text"].str.strip().str.len() > 5].reset_index(drop=True)
    
    return df, str(target_path)

def train_and_evaluate(custom_path: str = None) -> Dict[str, Any]:
    """
    Executes the full training, evaluation, comparison, and saving pipeline.
    """
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    
    df, dataset_source = load_and_validate_dataset(custom_path)
    
    X = df["cleaned_text"].values
    y = df["normalized_label"].values
    
    # Check class balance
    class_counts = pd.Series(y).value_counts().to_dict()
    fake_count = int(class_counts.get(1, 0))
    real_count = int(class_counts.get(0, 0))
    
    # Train / Test split
    test_size = 0.25 if len(X) >= 40 else 0.20
    stratify = y if min(fake_count, real_count) >= 2 else None
    
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=42, stratify=stratify
    )
    
    # TF-IDF Vectorization
    vectorizer = TfidfVectorizer(
        ngram_range=(1, 2),
        max_features=5000,
        sublinear_tf=True,
        min_df=1
    )
    X_train_vec = vectorizer.fit_transform(X_train)
    X_test_vec = vectorizer.transform(X_test)
    
    # 1. Model A: Logistic Regression
    lr_model = LogisticRegression(C=1.0, max_iter=1000, random_state=42)
    lr_model.fit(X_train_vec, y_train)
    lr_pred = lr_model.predict(X_test_vec)
    lr_metrics = compute_metrics(y_test, lr_pred)
    
    # 2. Model B: Linear SVM (Calibrated for well-behaved probabilistic outputs)
    svm_base = LinearSVC(C=1.0, random_state=42, dual=False, max_iter=2000)
    svm_base.fit(X_train_vec, y_train)
    # CalibratedClassifierCV ensures Linear SVM outputs valid probabilities via Platt scaling
    svm_calibrated = CalibratedClassifierCV(estimator=LinearSVC(C=1.0, random_state=42, dual=False, max_iter=2000), cv=2)
    svm_calibrated.fit(X_train_vec, y_train)
    svm_pred = svm_calibrated.predict(X_test_vec)
    svm_metrics = compute_metrics(y_test, svm_pred)
    
    # Model Selection: primarily based on F1-score, with accuracy as tie-breaker
    lr_f1 = lr_metrics["f1_score"]
    svm_f1 = svm_metrics["f1_score"]
    
    if svm_f1 > lr_f1:
        best_name = "Linear SVM (Calibrated)"
        best_model = svm_calibrated
        best_metrics = svm_metrics
        selection_reason = f"Linear SVM achieved higher F1-score ({svm_f1:.4f} vs {lr_f1:.4f})."
    elif lr_f1 > svm_f1:
        best_name = "Logistic Regression"
        best_model = lr_model
        best_metrics = lr_metrics
        selection_reason = f"Logistic Regression achieved higher F1-score ({lr_f1:.4f} vs {svm_f1:.4f})."
    else:
        # Tie-breaker on accuracy
        if svm_metrics["accuracy"] >= lr_metrics["accuracy"]:
            best_name = "Linear SVM (Calibrated)"
            best_model = svm_calibrated
            best_metrics = svm_metrics
            selection_reason = "Linear SVM selected as superior margin classifier with equal or better accuracy."
        else:
            best_name = "Logistic Regression"
            best_model = lr_model
            best_metrics = lr_metrics
            selection_reason = "Logistic Regression selected based on accuracy tie-breaker."
            
    # Save best model, vectorizer, and both raw models for feature inspection
    joblib.dump(best_model, MODEL_ARTIFACT)
    joblib.dump(vectorizer, VECTORIZER_ARTIFACT)
    joblib.dump(lr_model, MODELS_DIR / "logistic_regression.joblib")
    joblib.dump(svm_base, MODELS_DIR / "linear_svm_base.joblib")
    
    # Compile performance payload
    results = {
        "status": "success",
        "trained_at": datetime.utcnow().isoformat(),
        "dataset_info": {
            "source_path": dataset_source,
            "total_samples": len(df),
            "train_samples": len(X_train),
            "test_samples": len(X_test),
            "real_samples": real_count,
            "fake_samples": fake_count,
            "vocabulary_size": len(vectorizer.vocabulary_)
        },
        "models": {
            "logistic_regression": {
                "name": "Logistic Regression",
                "hyperparameters": {"C": 1.0, "max_iter": 1000},
                "metrics": lr_metrics
            },
            "linear_svm": {
                "name": "Linear SVM",
                "hyperparameters": {"C": 1.0, "calibration": "sigmoid (Platt)"},
                "metrics": svm_metrics
            }
        },
        "best_model": {
            "name": best_name,
            "selection_criterion": "Primary: F1-score, Secondary: Accuracy",
            "selection_reason": selection_reason,
            "metrics": best_metrics
        }
    }
    
    with open(METRICS_ARTIFACT, "w") as f:
        json.dump(results, f, indent=2)
        
    print(f"[TruthLens] Training pipeline completed successfully. Best Model: {best_name}")
    print(f"Metrics: Acc={best_metrics['accuracy']}, Prec={best_metrics['precision']}, Rec={best_metrics['recall']}, F1={best_metrics['f1_score']}")
    
    return results

if __name__ == "__main__":
    train_and_evaluate()
