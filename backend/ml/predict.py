import joblib
import json
import re
from urllib.parse import urlparse
from typing import Dict, Any, Optional

from backend.config import (
    MODEL_ARTIFACT,
    VECTORIZER_ARTIFACT,
    METRICS_ARTIFACT,
    get_thresholds
)
from backend.ml.preprocess import clean_text
from backend.ml.explain import build_complete_explanation
from backend.database.db import insert_history

# Global cache for loaded model
_MODEL_CACHE = {
    "model": None,
    "vectorizer": None,
    "model_name": "Linear SVM (Calibrated)"
}

def load_artifacts():
    if _MODEL_CACHE["model"] is None:
        if not MODEL_ARTIFACT.exists() or not VECTORIZER_ARTIFACT.exists():
            from backend.ml.train import train_and_evaluate
            train_and_evaluate()
            
        _MODEL_CACHE["model"] = joblib.load(MODEL_ARTIFACT)
        _MODEL_CACHE["vectorizer"] = joblib.load(VECTORIZER_ARTIFACT)
        
        # Determine model name from metrics
        if METRICS_ARTIFACT.exists():
            try:
                with open(METRICS_ARTIFACT, "r") as f:
                    metrics_data = json.load(f)
                    _MODEL_CACHE["model_name"] = metrics_data.get("best_model", {}).get("name", "Linear SVM (Calibrated)")
            except Exception:
                _MODEL_CACHE["model_name"] = "Linear SVM (Calibrated)"
                
    return _MODEL_CACHE["model"], _MODEL_CACHE["vectorizer"], _MODEL_CACHE["model_name"]

def reload_artifacts():
    _MODEL_CACHE["model"] = None
    _MODEL_CACHE["vectorizer"] = None
    return load_artifacts()

def analyze_news_article(
    raw_text: str,
    source_url: Optional[str] = None,
    fake_threshold: Optional[float] = None,
    real_threshold: Optional[float] = None
) -> Dict[str, Any]:
    """Core ML inference routine for a single article."""
    model, vectorizer, model_name = load_artifacts()
    
    # 1. Input Validation
    text_clean_raw = (raw_text or "").strip()
    if len(text_clean_raw) < 15:
        raise ValueError("Article text is too short to perform meaningful linguistic analysis (minimum 15 characters).")
        
    if len(text_clean_raw) > 50000:
        raise ValueError("Article text exceeds the safe processing limit of 50,000 characters.")
        
    cleaned = clean_text(text_clean_raw)
    if len(cleaned.strip()) == 0:
        raise ValueError("Article text contains only punctuation, stop words, or symbols.")

    # Short snippets do not contain enough context for a reliable fake-news verdict.
    # Keep the ML score for transparency, but force an uncertainty result unless a
    # source URL is supplied. This prevents generic headlines/snippets from being
    # displayed as highly confident factual judgments.
    word_count = len(text_clean_raw.split())
    short_context_without_source = word_count < 40 and not (source_url and source_url.strip())
        
    # 2. Vectorization & Inference using trained pipeline
    X_vec = vectorizer.transform([cleaned])
    
    if not hasattr(model, "predict_proba"):
        raise RuntimeError(
            f"Active model '{model_name}' does not implement predict_proba. "
            "SVM decision scores must not be presented as probabilities without genuine CalibratedClassifierCV calibration."
        )
    
    probs = model.predict_proba(X_vec)[0]
    real_prob = round(float(probs[0]), 4)
    fake_prob = round(float(probs[1]), 4)
    real_prob = round(1.0 - fake_prob, 4)
    
    # 3. Decision Thresholds
    active_thresholds = get_thresholds()
    t_fake = fake_threshold if fake_threshold is not None else active_thresholds["fake_threshold"]
    t_real = real_threshold if real_threshold is not None else active_thresholds["real_threshold"]
    
    if t_real >= t_fake:
        raise ValueError(f"real_threshold ({t_real}) must be strictly less than fake_threshold ({t_fake})")
        
    uncertainty_score = round(1.0 - abs(fake_prob - real_prob), 4)
    
    if short_context_without_source:
        prediction = "SUSPICIOUS"
        risk_level = "MODERATE"
        confidence = round(max(fake_prob, real_prob), 4)
    elif fake_prob >= t_fake:
        prediction = "LIKELY FAKE"
        risk_level = "HIGH"
        confidence = fake_prob
    elif fake_prob <= t_real:
        prediction = "LIKELY REAL"
        risk_level = "LOW"
        confidence = real_prob
    else:
        prediction = "SUSPICIOUS"
        risk_level = "MODERATE"
        confidence = round(max(fake_prob, real_prob), 4)
        
    # 4. Explainable AI & Indicators
    explanation_data = build_complete_explanation(text_clean_raw, source_url or "")
    indicators = explanation_data["linguistic_indicators"]
    features = explanation_data["feature_attributions"]
    summary_reasons = explanation_data["summary_reasons"]
    
    # 5. Source URL Processing
    source_info = {
        "url": source_url or None,
        "provided": bool(source_url and source_url.strip()),
        "domain": None,
        "status_note": "No source URL was provided for analysis." if not source_url else ""
    }
    if source_url and source_url.strip():
        parsed = urlparse(source_url.strip())
        domain = parsed.netloc or parsed.path.split('/')[0]
        source_info["domain"] = domain
        source_info["status_note"] = f"Domain '{domain}' extracted. Source attribution recorded."
        
    evidence_verification = {
        "status": "Automated evidence verification is not enabled.",
        "note": "Independent external factual retrieval requires active search indexing and live fact-checking APIs."
    }
    
    record_id = insert_history(
        full_text=text_clean_raw,
        prediction=prediction,
        confidence=confidence,
        fake_probability=fake_prob,
        real_probability=real_prob,
        risk_level=risk_level,
        model_name=model_name,
        source_url=source_url,
        indicators=indicators,
        explanation=features
    )
    
    return {
        "id": record_id,
        "prediction": prediction,
        "fake_probability": fake_prob,
        "real_probability": real_prob,
        "confidence": confidence,
        "confidence_score": round(confidence * 100, 1),
        "uncertainty_score": uncertainty_score,
        "risk_level": risk_level,
        "thresholds": {
            "fake_threshold": t_fake,
            "real_threshold": t_real,
            "suspicious_zone": f"{t_real} - {t_fake}"
        },
        "indicators": indicators,
        "explanation": summary_reasons,
        "feature_attributions": features,
        "model": model_name,
        "model_used": model_name,
        "calibration": "CalibratedClassifierCV (Platt Scaling via Sigmoid)",
        "vectorizer": "TF-IDF (1-2 ngrams, sublinear tf)",
        "source_info": source_info,
        "evidence_verification": evidence_verification,
        "disclaimer": "This system predicts based on statistical patterns learned from its training data. It does not establish factual truth by itself."
    }
