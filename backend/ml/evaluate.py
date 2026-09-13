import numpy as np
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, confusion_matrix
from typing import Dict, Any, List

def compute_metrics(y_true: List[int], y_pred: List[int]) -> Dict[str, Any]:
    """
    Computes real, non-invented evaluation metrics on the test dataset.
    Positive label = 1 (FAKE), Negative label = 0 (REAL).
    """
    y_true_arr = np.array(y_true)
    y_pred_arr = np.array(y_pred)
    
    acc = float(accuracy_score(y_true_arr, y_pred_arr))
    prec = float(precision_score(y_true_arr, y_pred_arr, zero_division=0))
    rec = float(recall_score(y_true_arr, y_pred_arr, zero_division=0))
    f1 = float(f1_score(y_true_arr, y_pred_arr, zero_division=0))
    
    cm = confusion_matrix(y_true_arr, y_pred_arr)
    # cm format:
    # [[True Negatives (Real as Real), False Positives (Real as Fake)],
    #  [False Negatives (Fake as Real), True Positives (Fake as Fake)]]
    if cm.shape == (2, 2):
        tn, fp, fn, tp = cm.ravel()
    else:
        # Fallback if only 1 class in sample
        tn, fp, fn, tp = int(cm[0, 0]), 0, 0, 0
        
    return {
        "accuracy": round(acc, 4),
        "precision": round(prec, 4),
        "recall": round(rec, 4),
        "f1_score": round(f1, 4),
        "confusion_matrix": {
            "matrix": cm.tolist(),
            "true_negative": int(tn),
            "false_positive": int(fp),
            "false_negative": int(fn),
            "true_positive": int(tp),
            "labels": ["REAL (0)", "FAKE (1)"]
        }
    }
