# TruthLens AI

**AI-powered fake-news detection and claim verification system.**

TruthLens AI combines machine-learning predictions with claim extraction, evidence analysis, source evaluation, and a web interface for reviewing news credibility.

## Run Locally

### Prerequisites

- Node.js
- Python 3
- A configured Gemini API key if using Gemini-powered features

### Installation

```bash
npm install
python -m pip install -r requirements.txt
```

### Environment

Create a local environment file and add your API key:

```bash
GEMINI_API_KEY=your_gemini_api_key
```

### Start the app

```bash
npm run dev
```

### Python/FastAPI backend (optional alternative API)

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Both backends implement the same verdict contract (below) and are the single
source of truth for verdicts; the frontend only renders what the backend returns.

## Verdict Contract

Every analysis returns exactly one of three verdicts (`prediction`, with a
`verdict` alias in the API response):

| Verdict | Meaning |
| --- | --- |
| `LIKELY REAL` | Model probability P(FAKE) at or below the real threshold |
| `LIKELY FAKE` | Model probability P(FAKE) at or above the fake threshold |
| `NEEDS MORE CONTEXT` | Input was guarded (too short / headline-only / vague / no source context) or the probability fell inside the configured uncertainty zone |

Guarantees:

- Short, headline-only, vague, incomplete, or source-less content is **never
  classified**. The response sets `fake_probability`, `real_probability`,
  `confidence` and `confidence_score` to `null` (rendered as `N/A`) so no fake
  percentage can be displayed.
- Empty input is a validation error (HTTP 400/422), never a crash.
- Uncertain predictions inside the uncertainty zone return `NEEDS MORE CONTEXT`
  with a `reason` explaining the zone; confidence is `null`.
- Models trained on small demo datasets (N ≤ 50) use a **widened uncertainty
  zone** (0.40 – 0.75 instead of 0.35 – 0.65) and are flagged with
  `model_reliability: "DEMO_DATASET"`; extreme (≥ 90%) probabilities carry a
  `probability_caveat` explaining they are not statistically supported.
- Probabilities are mapped from `predict_proba` columns via `model.classes_`
  (FAKE = class 1, REAL = class 0) — never by positional assumption — and
  loaded model artifacts are integrity-checked at startup (feature-count match
  plus a known-fake/known-real label-direction sanity check); broken or
  out-of-sync artifacts trigger an automatic retrain instead of saturated
  ~99% scores.

## Running the Tests

```bash
# Frontend type-check / build
npm run lint
npm run build

# Node (Express) backend suites
npx tsx scripts/regressionVerdictTests.ts   # verdict contract + label-swap + artifact integrity
npx tsx scripts/test_pipeline.ts            # full ML pipeline validation

# Python (FastAPI) backend suite (engine + API-level via TestClient)
.venv/bin/python backend/tests/test_verdicts.py
```

## Project Structure

- `src/` — frontend application and UI components
- `server/` — server-side services, ML engine, verification, security, and history
- `backend/` — Python ML pipeline, models, and verification utilities
- `data/` — datasets and validation data
- `scripts/` — training, evaluation, and acceptance-test scripts

## Important

Model predictions are decision-support signals, not absolute proof that a claim is true or false. Always review the available evidence and source context.
