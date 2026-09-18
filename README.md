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

### Deployment architecture

TruthLens AI runs as **one Node/Express service** (`server.ts`): it serves the
built React frontend and every `/api/*` route from the same process and port.
There is no separate serverless proxy layer and no separate Python API in
production — the frontend only ever calls same-origin, relative `/api/*`
paths, and `server/mlEngine.ts` (backed by `data/saved_model_artifacts.json`)
is the single active model.

`backend/` (Python/FastAPI + scikit-learn) is kept in the repo as an **offline
research/training reference only** — useful for the TDP report's data-science
sections (`scripts/train_isot.py`, `scripts/evaluate_liar.py`,
`backend/ml/*.py`) — but it is not deployed and is not called by the running
app. Do not run both backends against the same frontend; the Node engine is
the single source of truth for verdicts.

### Deploying to Render

1. Push this repo to GitHub (already public: see repo URL above).
2. In Render, "New +" → "Web Service" → connect the repo. Render will detect
   `render.yaml` and pre-fill these settings (or set them manually):
   - **Runtime:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Environment variables:**
     - `NODE_ENV=production` (required — without this the server tries to
       start the Vite *dev* middleware instead of serving the built app)
     - `GEMINI_API_KEY` (optional — only needed for claim extraction /
       evidence-search features under `/api/claims/extract`,
       `/api/evidence/search`, `/api/verify-claims`, `/api/verify-article`;
       everything else works without it)
   - `PORT` — do **not** set this yourself; Render injects it automatically
     and `server.ts` reads `process.env.PORT`.
3. Deploy. Render gives you a stable URL like
   `https://truthlens-ai.onrender.com` — that is the one and only production
   URL; there is no separate Vercel deployment or frontend/backend split to
   keep in sync.

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
