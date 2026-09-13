import json
from urllib.parse import urlparse
from typing import Dict, Any, Optional, Tuple

import joblib

from backend.config import (
    MODEL_ARTIFACT,
    VECTORIZER_ARTIFACT,
    METRICS_ARTIFACT,
    get_thresholds,
    FAKE_THRESHOLD,
    REAL_THRESHOLD
)
from backend.ml.preprocess import clean_text
from backend.ml.explain import build_complete_explanation
from backend.database.db import insert_history

# ---------------------------------------------------------------------------
# Verdict contract — the backend is the single source of truth.
#   LIKELY REAL | LIKELY FAKE | NEEDS MORE CONTEXT
# ---------------------------------------------------------------------------
VERDICT_LIKELY_REAL = "LIKELY REAL"
VERDICT_LIKELY_FAKE = "LIKELY FAKE"
VERDICT_NEEDS_MORE_CONTEXT = "NEEDS MORE CONTEXT"

# Context guards: short, headline-only, vague, incomplete or source-less
# content is never classified.
MIN_TEXT_LENGTH = 60
MIN_WORD_COUNT = 20

# Models trained on small demo datasets (N <= 50) cannot support confident
# verdicts, so their uncertainty zone is widened:
#   - FAKE bound moves OUT (0.65 -> 0.75): an unreliable model must never
#     accuse text of being fake without strong evidence;
#   - REAL bound moves OUT (0.35 -> 0.40): an unreliable model must not
#     over-promise "real" on out-of-distribution text either.
DEMO_MAX_SAMPLES = 50
DEMO_FAKE_ZONE_BOUND = 0.75
DEMO_REAL_ZONE_BOUND = 0.40

# Sanity-check corpus used to verify a loaded model is not broken or label-
# swapped. A healthy model must score the fake sample higher on P(FAKE) than
# the real sample.
SANITY_FAKE_TEXT = (
    "SHOCKING SECRET EXPOSED BY MILITARY WHISTLEBLOWER! Alien mothership over "
    "five miles wide is hovering in lunar orbit completely concealed from "
    "civilian telescopes using cloaking technology! The mainstream corrupt "
    "media and shadow government are desperately attempting to scrub this "
    "unbelievable miracle truth from the internet! Share this before the "
    "global elites delete it forever! Wake up people!"
)
SANITY_REAL_TEXT = (
    "The Ministry of Education announced a new digital learning initiative to "
    "provide online educational resources to students. The programme will "
    "include access to government schools and digital classrooms, helping "
    "students and teachers use online learning materials more effectively."
)

# Global cache for loaded model
_MODEL_CACHE = {
    "model": None,
    "vectorizer": None,
    "model_name": "Linear SVM (Calibrated)",
    "validated": False
}


def _model_feature_count(model) -> Optional[int]:
    """Best-effort extraction of the feature dimension a model expects."""
    try:
        if hasattr(model, "calibrated_classifiers_") and model.calibrated_classifiers_:
            estimator = model.calibrated_classifiers_[0].estimator
            if hasattr(estimator, "coef_") and estimator.coef_ is not None:
                return int(estimator.coef_.shape[1])
        if hasattr(model, "coef_") and model.coef_ is not None:
            return int(model.coef_.shape[1])
    except Exception:
        return None
    return None


def _model_is_demo() -> bool:
    """True when the active model was trained on a small (demo) dataset."""
    try:
        if not METRICS_ARTIFACT.exists():
            return False
        with open(METRICS_ARTIFACT, "r") as f:
            data = json.load(f)
        if data.get("is_demo"):
            return True
        dataset_info = data.get("dataset_info") or {}
        if dataset_info.get("is_demo"):
            return True
        total = dataset_info.get("total_samples")
        if total is None:
            total = data.get("total_samples")
        if total is not None:
            try:
                return int(total) <= DEMO_MAX_SAMPLES
            except (TypeError, ValueError):
                return False
    except Exception:
        return False
    return False


def model_reliability_label() -> str:
    return "DEMO_DATASET" if _model_is_demo() else "VALIDATED"


def effective_decision_zone() -> Tuple[float, float, bool]:
    """
    Returns (fake_threshold, real_threshold, widened_for_demo).
    Demo models get a widened uncertainty zone so borderline text returns
    NEEDS MORE CONTEXT instead of a forced FAKE/REAL verdict.
    """
    thresholds = get_thresholds()
    t_fake = float(thresholds["fake_threshold"])
    t_real = float(thresholds["real_threshold"])
    if _model_is_demo():
        return max(t_fake, DEMO_FAKE_ZONE_BOUND), max(t_real, DEMO_REAL_ZONE_BOUND), True
    return t_fake, t_real, False


def _validate_loaded_artifacts(model, vectorizer, model_name: str) -> None:
    """
    Integrity + label-direction validation for a freshly loaded artifact pair.
    Raises RuntimeError when the pair is corrupt, mismatched, or appears to
    have its FAKE/REAL labels swapped. Callers should retrain in that case.
    """
    feature_count = _model_feature_count(model)
    try:
        vocab_size = len(vectorizer.get_feature_names_out())
    except Exception:
        vocab_size = None

    if feature_count is not None and vocab_size is not None and feature_count != vocab_size:
        raise RuntimeError(
            f"Model/vectorizer feature count mismatch: model expects {feature_count} features "
            f"but the vectorizer produces {vocab_size}. Artifacts are out of sync."
        )

    # Label direction sanity check: P(FAKE) on the known fake sample must be
    # clearly higher than P(FAKE) on the known real sample. This catches both
    # swapped label mappings and saturated/broken models (e.g. 99% FAKE for
    # everything).
    try:
        if not hasattr(model, "predict_proba"):
            raise RuntimeError(
                f"Active model '{model_name}' does not implement predict_proba. "
                "SVM decision scores must not be presented as probabilities without genuine "
                "CalibratedClassifierCV calibration."
            )
        probs = model.predict_proba(vectorizer.transform([clean_text(SANITY_FAKE_TEXT), clean_text(SANITY_REAL_TEXT)]))
        classes = [int(c) for c in model.classes_]
        fake_idx = classes.index(1)
        real_idx = classes.index(0)
        p_fake_on_fake = float(probs[0][fake_idx])
        p_fake_on_real = float(probs[1][fake_idx])
        if p_fake_on_fake <= p_fake_on_real:
            raise RuntimeError(
                "Label direction sanity check failed: P(FAKE) on a known fake sample "
                f"({p_fake_on_fake:.4f}) is not greater than P(FAKE) on a known real sample "
                f"({p_fake_on_real:.4f}). FAKE/REAL labels appear reversed or the model is broken."
            )
        spread = p_fake_on_fake - p_fake_on_real
        if spread < 0.10:
            raise RuntimeError(
                f"Model produces nearly identical fake probabilities for clearly different "
                f"inputs (fake={p_fake_on_fake:.4f}, real={p_fake_on_real:.4f}); the artifact pair "
                "is likely inconsistent (stale vectorizer or mismatched weights)."
            )
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"Model sanity check could not be completed: {e}")


def load_artifacts():
    if _MODEL_CACHE["model"] is None:
        if not MODEL_ARTIFACT.exists() or not VECTORIZER_ARTIFACT.exists():
            from backend.ml.train import train_and_evaluate
            train_and_evaluate()

        try:
            _MODEL_CACHE["model"] = joblib.load(MODEL_ARTIFACT)
            _MODEL_CACHE["vectorizer"] = joblib.load(VECTORIZER_ARTIFACT)
        except Exception as e:
            print(f"[TruthLens] Model artifact load failed ({e}); retraining to restore consistency.")
            _MODEL_CACHE["model"] = None
            _MODEL_CACHE["vectorizer"] = None
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

        # Integrity + label-direction validation (auto-retrain when broken)
        try:
            _validate_loaded_artifacts(
                _MODEL_CACHE["model"], _MODEL_CACHE["vectorizer"], _MODEL_CACHE["model_name"]
            )
        except RuntimeError as e:
            print(f"[TruthLens] {e} Retraining model artifacts...")
            _MODEL_CACHE["model"] = None
            _MODEL_CACHE["vectorizer"] = None
            from backend.ml.train import train_and_evaluate
            train_and_evaluate()
            _MODEL_CACHE["model"] = joblib.load(MODEL_ARTIFACT)
            _MODEL_CACHE["vectorizer"] = joblib.load(VECTORIZER_ARTIFACT)
            _validate_loaded_artifacts(
                _MODEL_CACHE["model"], _MODEL_CACHE["vectorizer"], _MODEL_CACHE["model_name"]
            )

        _MODEL_CACHE["validated"] = True

    return _MODEL_CACHE["model"], _MODEL_CACHE["vectorizer"], _MODEL_CACHE["model_name"]


def reload_artifacts():
    _MODEL_CACHE["model"] = None
    _MODEL_CACHE["vectorizer"] = None
    _MODEL_CACHE["validated"] = False
    return load_artifacts()


def _probability_mapping(model) -> Tuple[int, int]:
    """
    Returns (fake_index, real_index) into predict_proba output columns,
    derived from model.classes_ — never by positional assumption.
    """
    classes = [int(c) for c in model.classes_]
    return classes.index(1), classes.index(0)


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
    if len(text_clean_raw) == 0:
        raise ValueError("News article text cannot be empty.")

    if len(text_clean_raw) > 50000:
        raise ValueError("Article text exceeds the safe processing limit of 50,000 characters.")

    words = text_clean_raw.split()
    has_source = bool(source_url and source_url.strip())

    # 2. Context guards — short, headline-only, vague, incomplete or
    #    source-less content is NEVER classified. No inference is run and no
    #    probabilities are exposed (all null) so the UI cannot display a
    #    misleading fake percentage.
    guard_reason: Optional[str] = None
    if len(text_clean_raw) < MIN_TEXT_LENGTH:
        guard_reason = (
            f"The supplied text is too short ({len(text_clean_raw)}/{MIN_TEXT_LENGTH} characters) "
            "or lacks sufficient source context."
        )
    elif len(words) < MIN_WORD_COUNT and not has_source:
        guard_reason = (
            f"The supplied text is too short ({len(words)} words) or lacks sufficient source "
            "context (no article body and no source URL)."
        )

    if guard_reason is not None:
        return {
            "id": None,
            "status": "INSUFFICIENT_INFORMATION",
            "verdict": VERDICT_NEEDS_MORE_CONTEXT,
            "prediction": VERDICT_NEEDS_MORE_CONTEXT,
            "reason": guard_reason,
            "message": "More article context is required for reliable ML analysis.",
            "fake_probability": None,
            "real_probability": None,
            "confidence": None,
            "confidence_score": None,
            "uncertainty_score": None,
            "risk_level": "UNDETERMINED",
            "input_length": len(text_clean_raw),
            "min_required_length": MIN_TEXT_LENGTH,
            "min_required_words": MIN_WORD_COUNT,
            "input_words": len(words),
            "thresholds": {
                "fake_threshold": FAKE_THRESHOLD,
                "real_threshold": REAL_THRESHOLD,
                "min_text_length": MIN_TEXT_LENGTH,
                "min_word_count": MIN_WORD_COUNT,
                "suspicious_zone": f"{REAL_THRESHOLD} - {FAKE_THRESHOLD}"
            },
            "indicators": [],
            "explanation": [
                "No classification is available: the supplied text does not contain enough "
                "context for a reliable model evaluation.",
                "Provide the full article body (or a source URL with article text) to obtain a verdict."
            ],
            "feature_attributions": [],
            "model": model_name,
            "model_used": model_name,
            "model_reliability": model_reliability_label(),
            "source_info": {
                "url": source_url or None,
                "provided": has_source,
                "domain": None,
                "status_note": "No source URL was provided for analysis." if not has_source else ""
            },
            "evidence_verification": {
                "status": "Automated evidence verification is not enabled.",
                "note": "Independent external factual retrieval requires active search indexing and live fact-checking APIs."
            },
            "disclaimer": "This system requires sufficient contextual sentences to evaluate linguistic patterns reliably without guessing."
        }

    cleaned = clean_text(text_clean_raw)
    if len(cleaned.strip()) == 0:
        raise ValueError("Article text contains only punctuation, stop words, or symbols.")

    # 3. Vectorization & Inference using trained pipeline
    X_vec = vectorizer.transform([cleaned])

    if not hasattr(model, "predict_proba"):
        raise RuntimeError(
            f"Active model '{model_name}' does not implement predict_proba. "
            "SVM decision scores must not be presented as probabilities without genuine CalibratedClassifierCV calibration."
        )

    # Label-safe probability mapping: index columns by model.classes_
    probs = model.predict_proba(X_vec)[0]
    fake_idx, real_idx = _probability_mapping(model)
    fake_prob = round(float(probs[fake_idx]), 4)
    real_prob = round(float(probs[real_idx]), 4)
    # Guard against floating point drift: probabilities must sum to ~1
    real_prob = round(max(0.0, min(1.0, 1.0 - fake_prob)), 4)

    # 4. Decision Thresholds (demo models get a widened uncertainty zone)
    t_fake_default, t_real_default, widened_for_demo = effective_decision_zone()
    t_fake = t_fake_default if fake_threshold is None else float(fake_threshold)
    t_real = t_real_default if real_threshold is None else float(real_threshold)
    if t_real >= t_fake:
        raise ValueError(f"real_threshold ({t_real}) must be strictly less than fake_threshold ({t_fake})")

    uncertainty_score = round(1.0 - abs(fake_prob - real_prob), 4)

    # 5. Verdict contract: LIKELY REAL | LIKELY FAKE | NEEDS MORE CONTEXT
    verdict_reason: Optional[str] = None
    if fake_prob >= t_fake:
        prediction = VERDICT_LIKELY_FAKE
        risk_level = "HIGH"
        confidence = fake_prob
    elif fake_prob <= t_real:
        prediction = VERDICT_LIKELY_REAL
        risk_level = "LOW"
        confidence = real_prob
    else:
        prediction = VERDICT_NEEDS_MORE_CONTEXT
        risk_level = "UNDETERMINED"
        confidence = None
        verdict_reason = (
            f"The model probability (P(FAKE)={fake_prob}) falls inside the configured uncertainty "
            f"zone ({t_real} - {t_fake}); the model does not have sufficient certainty to classify "
            "this text as real or fake."
            + (" The uncertainty zone is widened because the active model was trained on a small demo dataset."
               if widened_for_demo else "")
        )

    demo_model = _model_is_demo()
    probability_caveat = None
    if demo_model and (fake_prob >= 0.9 or real_prob >= 0.9):
        probability_caveat = (
            "The active model was trained on a small demo dataset; extreme probabilities are not "
            "statistically supported and must not be treated as verified truth."
        )

    # 6. Explainable AI & Indicators (never allowed to break the analysis)
    try:
        explanation_data = build_complete_explanation(text_clean_raw, source_url or "")
        indicators = explanation_data["linguistic_indicators"]
        features = explanation_data["feature_attributions"]
        summary_reasons = explanation_data["summary_reasons"]
    except Exception as e:
        print(f"[TruthLens] Feature attribution failed (non-fatal): {e}")
        indicators = []
        features = []
        summary_reasons = []

    if verdict_reason:
        summary_reasons.append(verdict_reason)
    if probability_caveat:
        summary_reasons.append(probability_caveat)

    # 7. Source URL Processing
    source_info = {
        "url": source_url or None,
        "provided": has_source,
        "domain": None,
        "status_note": "No source URL was provided for analysis." if not has_source else ""
    }
    if has_source:
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
        "status": "SUCCESS",
        "verdict": prediction,
        "prediction": prediction,
        "reason": verdict_reason,
        "fake_probability": fake_prob,
        "real_probability": real_prob,
        "confidence": confidence,
        "confidence_score": round(confidence * 100, 1) if confidence is not None else None,
        "uncertainty_score": uncertainty_score,
        "risk_level": risk_level,
        "thresholds": {
            "fake_threshold": t_fake,
            "real_threshold": t_real,
            "min_text_length": MIN_TEXT_LENGTH,
            "min_word_count": MIN_WORD_COUNT,
            "suspicious_zone": f"{t_real} - {t_fake}",
            "widened_for_demo": widened_for_demo
        },
        "indicators": indicators,
        "explanation": summary_reasons,
        "feature_attributions": features,
        "model": model_name,
        "model_used": model_name,
        "model_reliability": model_reliability_label(),
        "probability_caveat": probability_caveat,
        "calibration": "CalibratedClassifierCV (Platt Scaling via Sigmoid)",
        "vectorizer": "TF-IDF (1-2 ngrams, sublinear tf)",
        "source_info": source_info,
        "evidence_verification": evidence_verification,
        "disclaimer": "This system predicts based on statistical patterns learned from its training data. It does not establish factual truth by itself."
    }
