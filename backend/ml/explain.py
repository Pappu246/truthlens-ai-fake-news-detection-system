import joblib
import numpy as np
from pathlib import Path
from typing import List, Dict, Any

from backend.config import MODELS_DIR, VECTORIZER_ARTIFACT
from backend.ml.preprocess import clean_text, extract_linguistic_indicators

def get_text_feature_explanations(raw_text: str, top_k: int = 8) -> List[Dict[str, Any]]:
    """
    Computes lightweight, exact linear feature attributions (Sparse Linear SHAP / Coefficient weighting).
    Multiplies the TF-IDF feature vector of the input text by the linear model weights
    to calculate each word/n-gram's mathematical contribution toward FAKE (positive) or REAL (negative).
    """
    vectorizer_path = VECTORIZER_ARTIFACT
    # Check if we have linear_svm_base or logistic_regression
    svm_path = MODELS_DIR / "linear_svm_base.joblib"
    lr_path = MODELS_DIR / "logistic_regression.joblib"
    
    model_to_use = None
    if svm_path.exists():
        model_to_use = joblib.load(svm_path)
    elif lr_path.exists():
        model_to_use = joblib.load(lr_path)
        
    if not model_to_use or not vectorizer_path.exists():
        return []
        
    vectorizer = joblib.load(vectorizer_path)
    cleaned = clean_text(raw_text)
    if not cleaned:
        return []
        
    tfidf_vec = vectorizer.transform([cleaned])
    
    # Feature names
    feature_names = np.array(vectorizer.get_feature_names_out())
    
    # Model coefficients
    if hasattr(model_to_use, "coef_"):
        coefs = model_to_use.coef_[0]
    else:
        return []
        
    # Non-zero indices in current document
    non_zero_indices = tfidf_vec.indices
    if len(non_zero_indices) == 0:
        return []
        
    # Contributions = TF-IDF value * model coefficient
    contributions = []
    for idx in non_zero_indices:
        tfidf_val = tfidf_vec[0, idx]
        weight = coefs[idx]
        impact = tfidf_val * weight
        contributions.append({
            "term": str(feature_names[idx]),
            "tfidf_value": round(float(tfidf_val), 4),
            "coefficient": round(float(weight), 4),
            "impact_score": round(float(impact), 4),
            # Positive impact pushes model toward FAKE, negative toward REAL
            "signal_direction": "fake" if impact > 0 else "real",
            "signal_label": "Contributing signal toward FAKE" if impact > 0 else "Contributing signal toward REAL",
            "intensity": round(abs(float(impact)), 4)
        })
        
    # Sort by absolute impact magnitude
    contributions.sort(key=lambda x: x["intensity"], reverse=True)
    
    return contributions[:top_k]

def build_complete_explanation(raw_text: str, source_url: str = "") -> Dict[str, Any]:
    """
    Combines linguistic indicators and machine learning feature attributions.
    """
    indicators = extract_linguistic_indicators(raw_text, source_url)
    features = get_text_feature_explanations(raw_text, top_k=8)
    
    summary_reasons = []
    
    # Summarize top features
    fake_signals = [f for f in features if f["signal_direction"] == "fake"]
    real_signals = [f for f in features if f["signal_direction"] == "real"]
    
    if fake_signals:
        top_fake_terms = [f"'{f['term']}'" for f in fake_signals[:3]]
        summary_reasons.append(
            f"Model indicators: Distinctive vocabulary patterns matching previous unverified reports ({', '.join(top_fake_terms)})."
        )
    if real_signals:
        top_real_terms = [f"'{f['term']}'" for f in real_signals[:3]]
        summary_reasons.append(
            f"Model indicators: Vocabulary signals consistent with documented journalistic or institutional publications ({', '.join(top_real_terms)})."
        )
        
    # Summarize linguistic rules
    warning_indicators = [ind for ind in indicators if ind.get("signal") == "warning"]
    for ind in warning_indicators[:2]:
        summary_reasons.append(f"Potential warning sign: {ind['name']} ({ind['description']})")
        
    if not source_url:
        summary_reasons.append("Potential warning sign: Source URL was not provided for domain cross-referencing.")
    else:
        summary_reasons.append("Source metadata: Domain provided, but external factual credibility could not be independently verified.")
        
    return {
        "summary_reasons": summary_reasons,
        "linguistic_indicators": indicators,
        "feature_attributions": features,
        "methodology_note": "Attributions reflect localized linear TF-IDF feature weighting and structural pattern detection. Probabilistic indicators should not be construed as definitive factual verification."
    }
