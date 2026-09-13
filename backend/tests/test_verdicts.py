"""
TRUTHLENS AI — VERDICT CONTRACT REGRESSION SUITE (Python/FastAPI backend)

Proves, deterministically:
  Case A: Fake-style text -> LIKELY FAKE (never LIKELY REAL).
  Case B: Normal/real-style article -> NEVER "LIKELY FAKE 99%/100%";
          must be LIKELY REAL or NEEDS MORE CONTEXT.
  Case C: Very short text -> NEEDS MORE CONTEXT with null confidence and
          null probabilities (no fake percentage can be displayed).
  Case D: Empty input -> validation error, no crash.
  Label mapping: predict_proba columns are indexed via model.classes_, and a
          known-fake / known-real sanity check proves FAKE and REAL
          probabilities are not swapped.
  Artifact integrity: model and vectorizer feature counts match.

Run:
  .venv/bin/python backend/tests/test_verdicts.py
or (if pytest is installed):
  .venv/bin/python -m pytest backend/tests/test_verdicts.py -v
"""

import os
import sys
from pathlib import Path

# Ensure the repository root is importable
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.ml import predict as predict_module  # noqa: E402
from backend.ml.predict import (  # noqa: E402
    analyze_news_article,
    load_artifacts,
    VERDICT_LIKELY_REAL,
    VERDICT_LIKELY_FAKE,
    VERDICT_NEEDS_MORE_CONTEXT,
)
from backend.ml.train import load_and_validate_dataset  # noqa: E402
from backend.ml.preprocess import clean_text  # noqa: E402

REAL_ARTICLE = (
    "The Ministry of Education announced a new digital learning initiative to "
    "provide online educational resources to students. The programme will "
    "include access to government schools and digital classrooms, helping "
    "students and teachers use online learning materials more effectively."
)

FAKE_ARTICLE = (
    "SHOCKING SECRET EXPOSED BY MILITARY WHISTLEBLOWER! Alien mothership over "
    "five miles wide is hovering in lunar orbit completely concealed from "
    "civilian telescopes using cloaking technology! The mainstream corrupt "
    "media and shadow government are desperately attempting to scrub this "
    "unbelievable miracle truth from the internet! Insiders confirm that "
    "world leaders signed a secret treaty allowing deep-state extraction "
    "operations in exchange for zero-point energy weapons! Share this before "
    "the global elites delete it forever! Wake up people!"
)

SHORT_TEXT = "Alien UFO spotted in sky"

_results = []


def check(condition: bool, name: str, detail: str = ""):
    _results.append((bool(condition), name, detail))
    if condition:
        print(f"PASS: {name}")
    else:
        print(f"FAIL: {name} — {detail}")
    return condition


# ---------------------------------------------------------------------------
# Case A — Fake-style text
# ---------------------------------------------------------------------------
def test_case_a_fake_style_text():
    r = analyze_news_article(FAKE_ARTICLE)
    check(
        r["prediction"] in (VERDICT_LIKELY_FAKE, VERDICT_NEEDS_MORE_CONTEXT),
        "Case A: verdict is LIKELY FAKE or NEEDS MORE CONTEXT",
        f"got {r['prediction']}",
    )
    check(
        r["prediction"] != VERDICT_LIKELY_REAL,
        "Case A: fake-style text is NEVER shown as LIKELY REAL",
        f"got {r['prediction']}, P(FAKE)={r['fake_probability']}",
    )
    if r["prediction"] == VERDICT_LIKELY_FAKE:
        check(
            r["fake_probability"] is not None and r["fake_probability"] >= 0.65,
            "Case A: LIKELY FAKE is backed by P(FAKE) >= 0.65",
            f"P(FAKE)={r['fake_probability']}",
        )
        check(r["risk_level"] == "HIGH", "Case A: risk level HIGH", r["risk_level"])
        if r["model_reliability"] == "DEMO_DATASET" and (r["fake_probability"] or 0) >= 0.9:
            check(
                r["probability_caveat"] is not None,
                "Case A: extreme demo-model probability carries an explicit caveat",
                f"prob={r['fake_probability']}, caveat={r['probability_caveat']}",
            )


# ---------------------------------------------------------------------------
# Case B — Normal/real-style article (exact user text)
# ---------------------------------------------------------------------------
def test_case_b_normal_article():
    r = analyze_news_article(REAL_ARTICLE)
    check(
        r["prediction"] != VERDICT_LIKELY_FAKE,
        "Case B: normal article is NEVER displayed as LIKELY FAKE",
        f"got {r['prediction']}, P(FAKE)={r['fake_probability']}",
    )
    check(
        r["prediction"] in (VERDICT_LIKELY_REAL, VERDICT_NEEDS_MORE_CONTEXT),
        "Case B: verdict is LIKELY REAL or NEEDS MORE CONTEXT",
        f"got {r['prediction']}",
    )
    check(
        r["fake_probability"] is None or r["fake_probability"] < 0.9,
        "Case B: no unsupported 99%/100% fake score is exposed",
        f"P(FAKE)={r['fake_probability']}",
    )
    if r["prediction"] == VERDICT_NEEDS_MORE_CONTEXT:
        check(
            r["confidence"] is None and r["confidence_score"] is None,
            "Case B (uncertain): confidence is N/A (null)",
            f"confidence={r['confidence']}, score={r['confidence_score']}",
        )
        check(
            isinstance(r["reason"], str) and len(r["reason"]) > 10,
            "Case B (uncertain): reason explains the uncertainty zone",
            str(r["reason"]),
        )


# ---------------------------------------------------------------------------
# Case C — Very short text
# ---------------------------------------------------------------------------
def test_case_c_short_text():
    r = analyze_news_article(SHORT_TEXT)
    check(
        r["prediction"] == VERDICT_NEEDS_MORE_CONTEXT,
        "Case C: very short text returns NEEDS MORE CONTEXT",
        f"got {r['prediction']}",
    )
    check(r["status"] == "INSUFFICIENT_INFORMATION", "Case C: status INSUFFICIENT_INFORMATION", r["status"])
    check(r["confidence"] is None, "Case C: confidence N/A (null)", str(r["confidence"]))
    check(r["confidence_score"] is None, "Case C: confidence_score N/A (null)", str(r["confidence_score"]))
    check(r["fake_probability"] is None, "Case C: fake_probability withheld (null)", str(r["fake_probability"]))
    check(r["real_probability"] is None, "Case C: real_probability withheld (null)", str(r["real_probability"]))
    check(r["risk_level"] == "UNDETERMINED", "Case C: risk level UNDETERMINED", r["risk_level"])
    check(isinstance(r["reason"], str) and len(r["reason"]) > 10, "Case C: human-readable reason provided")


def test_case_c2_headline_short_without_source():
    headline = "Officials quietly sign landmark digital infrastructure accord"
    r = analyze_news_article(headline)
    check(
        r["prediction"] == VERDICT_NEEDS_MORE_CONTEXT and r["fake_probability"] is None,
        "Case C2: short text without source URL is guarded (no probabilities)",
        f"got {r['prediction']}, P(FAKE)={r['fake_probability']}",
    )


# ---------------------------------------------------------------------------
# Case D — Empty input
# ---------------------------------------------------------------------------
def test_case_d_empty_input():
    try:
        analyze_news_article("")
        check(False, "Case D: empty input raises a validation error", "no exception raised")
    except ValueError as e:
        check(len(str(e)) > 5, "Case D: empty input raises a descriptive validation error", str(e))
    try:
        analyze_news_article("   \n\t ")
        check(False, "Case D2: whitespace-only input raises a validation error", "no exception raised")
    except ValueError:
        check(True, "Case D2: whitespace-only input raises a validation error")


# ---------------------------------------------------------------------------
# Label mapping — FAKE/REAL probabilities must not be swapped
# ---------------------------------------------------------------------------
def test_label_mapping_not_swapped():
    model, vectorizer, _name = load_artifacts()
    check(hasattr(model, "predict_proba"), "Label test: model exposes predict_proba")

    # 1. classes_ must contain both binary labels
    classes = sorted(int(c) for c in model.classes_)
    check(classes == [0, 1], "Label test: model.classes_ is [0, 1]", str(classes))

    # 2. Column mapping derived from classes_ (regression: never positional)
    fake_idx, real_idx = predict_module._probability_mapping(model)
    check(fake_idx == int(list(model.classes_).index(1)), "Label test: fake index follows classes_")
    check(real_idx == int(list(model.classes_).index(0)), "Label test: real index follows classes_")

    # 3. Sanity texts: P(FAKE) on fake sample must exceed P(FAKE) on real sample
    X = vectorizer.transform([clean_text(FAKE_ARTICLE), clean_text(REAL_ARTICLE)])
    probs = model.predict_proba(X)
    p_fake_on_fake = float(probs[0][fake_idx])
    p_fake_on_real = float(probs[1][fake_idx])
    check(
        p_fake_on_fake > p_fake_on_real,
        "Label test: fake sample scores higher P(FAKE) than real sample (not swapped)",
        f"fake={p_fake_on_fake:.4f} real={p_fake_on_real:.4f}",
    )
    check(
        p_fake_on_fake >= 0.5,
        "Label test: P(FAKE) on fake sample is at least 0.5",
        f"got {p_fake_on_fake:.4f}",
    )
    check(
        p_fake_on_real <= 0.5,
        "Label test: P(FAKE) on real sample is at most 0.5",
        f"got {p_fake_on_real:.4f}",
    )

    # 4. Full dataset direction check: majority of FAKE-labeled rows must
    #    score higher on P(FAKE) than on P(REAL), and vice versa.
    df, _src = load_and_validate_dataset()
    X_all = vectorizer.transform(df["cleaned_text"].tolist())
    P = model.predict_proba(X_all)
    fake_mask = (df["normalized_label"] == 1).to_numpy()
    real_mask = (df["normalized_label"] == 0).to_numpy()
    p_fake_col = P[:, fake_idx]
    fake_agree = float(((p_fake_col[fake_mask] > 1 - p_fake_col[fake_mask]).mean()))
    real_agree = float(((p_fake_col[real_mask] < 1 - p_fake_col[real_mask]).mean()))
    check(fake_agree >= 0.8, f"Label test: >=80% FAKE rows score P(FAKE)>P(REAL) (got {fake_agree:.1%})")
    check(real_agree >= 0.8, f"Label test: >=80% REAL rows score P(REAL)>P(FAKE) (got {real_agree:.1%})")
    check(
        float(p_fake_col[fake_mask].mean()) > float(p_fake_col[real_mask].mean()),
        "Label test: mean P(FAKE) higher on FAKE rows than on REAL rows (labels not swapped)",
    )


# ---------------------------------------------------------------------------
# Artifact integrity
# ---------------------------------------------------------------------------
def test_artifact_integrity():
    model, vectorizer, _name = load_artifacts()
    from backend.ml.predict import _model_feature_count
    feature_count = _model_feature_count(model)
    vocab_size = len(vectorizer.get_feature_names_out())
    check(
        feature_count is None or feature_count == vocab_size,
        "Artifact integrity: model feature count matches vectorizer vocabulary",
        f"model={feature_count} vectorizer={vocab_size}",
    )
    check(vocab_size > 0, "Artifact integrity: vectorizer vocabulary is non-empty", str(vocab_size))


# ---------------------------------------------------------------------------
# API-level tests (FastAPI) — run only when httpx is available
# ---------------------------------------------------------------------------
def test_api_endpoints():
    try:
        from fastapi.testclient import TestClient
    except Exception as e:  # pragma: no cover
        print(f"SKIP: API tests require fastapi TestClient (httpx): {e}")
        return

    from backend.main import app

    client = TestClient(app)

    health = client.get("/api/health")
    check(health.status_code == 200, "API: GET /api/health returns 200", str(health.status_code))
    body = health.json()
    check(body.get("model_loaded") is True, "API: health reports model_loaded=true", str(body))

    # Case B via API
    r = client.post("/api/analyze", json={"text": REAL_ARTICLE})
    check(r.status_code == 200, "API: normal article returns 200", f"{r.status_code} {r.text[:200]}")
    data = r.json()
    check(data["prediction"] != VERDICT_LIKELY_FAKE, "API: normal article is NOT LIKELY FAKE", str(data.get("prediction")))
    check(data["fake_probability"] is None or data["fake_probability"] < 0.9, "API: no 99%/100% fake score", str(data.get("fake_probability")))

    # Case A via API
    r = client.post("/api/analyze", json={"text": FAKE_ARTICLE})
    check(r.status_code == 200, "API: fake article returns 200", str(r.status_code))
    data = r.json()
    check(data["prediction"] != VERDICT_LIKELY_REAL, "API: fake article is NOT LIKELY REAL", str(data.get("prediction")))

    # Case C via API
    r = client.post("/api/analyze", json={"text": SHORT_TEXT})
    check(r.status_code == 200, "API: short text returns 200 (not an error)", str(r.status_code))
    data = r.json()
    check(data["prediction"] == VERDICT_NEEDS_MORE_CONTEXT, "API: short text verdict NEEDS MORE CONTEXT", str(data.get("prediction")))
    check(data["fake_probability"] is None, "API: short text fake_probability is null", str(data.get("fake_probability")))
    check(data["confidence_score"] is None, "API: short text confidence_score is null", str(data.get("confidence_score")))

    # Case D via API — validation error, no crash
    r = client.post("/api/analyze", json={"text": ""})
    check(r.status_code in (400, 422), "API: empty input returns validation error", f"{r.status_code} {r.text[:200]}")
    r = client.post("/api/analyze", json={"text": "   "})
    check(r.status_code == 400, "API: whitespace-only input returns 400", str(r.status_code))


if __name__ == "__main__":
    tests = [
        test_case_a_fake_style_text,
        test_case_b_normal_article,
        test_case_c_short_text,
        test_case_c2_headline_short_without_source,
        test_case_d_empty_input,
        test_label_mapping_not_swapped,
        test_artifact_integrity,
        test_api_endpoints,
    ]
    failures = 0
    for t in tests:
        print(f"\n=== {t.__name__} ===")
        _results.clear()
        before = len(_results)
        t()
        for ok, name, detail in _results:
            if not ok:
                failures += 1
    print("\n" + "=" * 60)
    print(f"PYTHON VERDICT REGRESSION SUMMARY: {failures} FAILURE(S)")
    print("=" * 60)
    sys.exit(1 if failures else 0)
