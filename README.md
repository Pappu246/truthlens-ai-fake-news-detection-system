# TruthLens AI

A production-oriented AI news verification platform that combines calibrated article classification, secure web extraction, Live News/RSS ingestion, claim and evidence workflows, model diagnostics, and analysis history.

[![Live Demo](https://img.shields.io/badge/demo-live-667085?style=flat-square)](https://truthlens-ai-dvpf.onrender.com)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-667085?style=flat-square)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-667085?style=flat-square)](tsconfig.json)
[![CI](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/workflows/ci.yml/badge.svg)](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/workflows/ci.yml)

**Current production model:** Calibrated Linear SVM, model version **3.0.0-isot**, trained on the ISOT Fake News Dataset.

[Live demo](https://truthlens-ai-dvpf.onrender.com) | [Features](#features) | [Architecture](#architecture) | [Model & Evaluation](#model--evaluation) | [Verdict Logic](#verdict-logic) | [Security](#security) | [Testing](#testing) | [Limitations](#limitations)

## Contents

- [About](#about)
- [Features](#features)
- [Current Release](#current-release)
- [Model & Evaluation](#model--evaluation)
- [Architecture](#architecture)
- [Verdict Logic](#verdict-logic)
- [Live News and URL Extraction](#live-news-and-url-extraction)
- [Security](#security)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [TDP / Academic Report](#tdp--academic-report)
- [Limitations](#limitations)

## About

TruthLens AI is a B.Tech CSE-AIML TDP project focused on AI-assisted news verification.

The system deliberately separates:

1. **ML prediction** — a calibrated linguistic-pattern classification signal.
2. **Source provenance** — where the analyzed text came from.
3. **Evidence / verification** — external supporting or contradicting information when available.
4. **Uncertainty** — situations where the available context or model confidence is insufficient.

The backend exposes three primary model outcomes:

- **LIKELY REAL**
- **LIKELY FAKE**
- **NEEDS MORE CONTEXT**

A model probability is **not** treated as mathematical proof that a real-world claim is true or false.

## Features

| Capability | Current implementation |
|---|---|
| Article-level classification | TF-IDF + calibrated Linear SVM with Platt sigmoid calibration |
| Real benchmark training | ISOT Fake News Dataset with leak-safe stratified training/evaluation |
| Model diagnostics | Dataset provenance, sample counts, vocabulary, CV/test metrics, calibration and artifact metadata |
| Context safeguards | Minimum character/word gates, headline-only protection and uncertainty-zone handling |
| URL extraction | SSRF validation, DNS checks, manual redirect validation, byte/time limits, content-type checks and semantic article extraction |
| Live news | RSS/Atom feeds with caching, deduplication, category filtering and current article URLs |
| Live News content states | Full article, RSS summary only, headline only, or extraction blocked |
| Claim/evidence workflow | Claim extraction, evidence lookup, verification signals and source metadata |
| Analysis history | SQLite-backed history for analysis/verification records |
| Responsible AI | No fabricated confidence/evidence/citations; uncertainty is an explicit result |
| Deployment hardening | Single Node/Express production service plus Vercel-compatible serverless entrypoint |
| Regression/security tests | Contract, verdict, Vercel simulation, SSRF and backend test suites |

## Current Release

The current main release is built around the ISOT-trained article classifier.

### Production article model

| Property | Current value |
|---|---:|
| Model | Linear SVM (Calibrated) |
| Model version | **3.0.0-isot** |
| Dataset | ISOT Fake News Dataset |
| Raw articles | 44,898 |
| Cleaned articles | 38,656 |
| Training set | 30,924 |
| Held-out test set | 7,732 |
| TF-IDF vocabulary | 8,000 |
| Calibration | Platt sigmoid |
| Production demo flag | **false** |

### Why the old 36-row model is no longer the production model

The repository previously contained a 36-row demonstration dataset. The current production artifact is explicitly marked as non-demo and the production ML engine fails closed if the active artifact is missing, inconsistent, corrupted, or marked **is_demo=true**.

The 36-row development dataset remains useful for local/demo workflows, but it is not presented as the production benchmark.

## Model & Evaluation

### Training pipeline

The ISOT training workflow in **scripts/train_isot.py** performs:

1. dataset cleaning
2. exact duplicate removal
3. label normalization
4. stratified 80/20 train/test split
5. stratified 5-fold cross-validation
6. TF-IDF fitting within training folds only
7. Logistic Regression comparison
8. Calibrated Linear SVM comparison
9. held-out test evaluation
10. confusion-matrix reporting
11. probability calibration
12. production artifact generation

This separation is intended to prevent train/test leakage.

### ISOT benchmark results

The selected calibrated Linear SVM achieved the following on the held-out ISOT test split:

| Metric | Result |
|---|---:|
| Accuracy | **99.59%** |
| Precision | **99.43%** |
| Recall | **99.66%** |
| F1 | **99.54%** |

Five-fold cross-validation on the training partition produced an average F1 of approximately **0.9955** for the selected SVM.

These figures are **benchmark results for the ISOT task**, not a guarantee of real-world fact-checking accuracy.

### Out-of-domain validation

The repository also evaluates the production article model on the LIAR claim dataset. The latest measured LIAR result is substantially lower than the ISOT result.

That difference is treated as a **domain/task-shift signal**, not hidden or overwritten. ISOT primarily contains article-like news text, while LIAR contains short political claims. The project therefore keeps article classification and claim verification conceptually separate rather than presenting one benchmark number as universal truth.

A dedicated claim-specialist model is a separate maturity track; it must be trained and evaluated with an untouched claim-level test set before its metrics are presented as a production benchmark.

### Calibration and uncertainty

The production artifact uses Platt sigmoid calibration around the Linear SVM decision function.

The system can return **NEEDS MORE CONTEXT** when:

- input is empty or too short,
- explicit headline-only content is provided,
- required context is missing,
- the calibrated probability falls inside the configured uncertainty zone.

When classification is withheld, fake/real probabilities and confidence are not fabricated.

## Architecture

TruthLens uses a Node/Express production service. The React/Vite frontend communicates with same-origin API routes.

~~~mermaid
flowchart LR
    F[React / Vite frontend] --> S[Node / Express production service]

    S --> M[Article ML engine\nTF-IDF + calibrated Linear SVM]
    S --> X[Secure article extractor]
    S --> N[Live News / RSS]
    S --> V[Claims + evidence verification]
    S --> H[(SQLite history)]

    X --> U[Public article URL]
    N --> R[RSS / Atom feeds]
    V --> E[External evidence sources]
    V -. optional integration .-> G[Gemini]

    M --> D[Model diagnostics]
    V --> D
    X --> D
~~~

### Main components

- **server.ts** — Express entry point, API routes and production startup.
- **server/mlEngine.ts** — production artifact loading, vectorization, calibrated probabilities, thresholds and verdict selection.
- **server/extraction/articleExtractor.ts** — semantic DOM / JSON-LD article extraction.
- **server/security/urlValidator.ts** — URL validation, DNS/IP checks and safe fetching.
- **server/news/newsService.ts** — Live News/RSS acquisition.
- **server/verification/** — claim extraction, evidence lookup and verification logic.
- **server/sqliteHistory.ts** — analysis/verification history.
- **backend/** — offline Python/scikit-learn research and training pipeline.
- **scripts/** — training, evaluation, regression and deployment-simulation tooling.

The deployed production request path is Node/Express. The Python stack is used for offline training/evaluation and artifact generation.

## Verdict Logic

The backend applies context gates before using the calibrated classifier.

~~~mermaid
flowchart TD
    A[Direct text / extracted article / Live News content] --> B{Enough usable context?}
    B -- No --> C[NEEDS MORE CONTEXT\nprobabilities withheld]
    B -- Yes --> D[Normalize text]
    D --> E[TF-IDF]
    E --> F[Calibrated Linear SVM]
    F --> G[P(FAKE)]
    G --> H{Uncertainty zone?}
    H -- Yes --> C
    H -- No --> I{P(FAKE) >= fake threshold?}
    I -- Yes --> J[LIKELY FAKE]
    I -- No --> K[LIKELY REAL]
~~~

### Default thresholds

| Setting | Default |
|---|---:|
| Fake threshold | 0.65 |
| Real threshold | 0.35 |
| Minimum text length | 60 characters |
| Minimum word count | 20 words |

Persisted model/threshold configuration may override these defaults.

### Verdict reference

| Verdict | Interpretation |
|---|---|
| **LIKELY REAL** | The calibrated model places the input at or below the effective real threshold. This is a model signal, not proof of truth. |
| **LIKELY FAKE** | The calibrated model places the input at or above the effective fake threshold. This is a model signal, not proof of falsity. |
| **NEEDS MORE CONTEXT** | A context guard fired or the probability remained inside the configured uncertainty zone. Probabilities are withheld when classification is intentionally blocked. |

## Live News and URL Extraction

TruthLens distinguishes what content was actually analyzed.

### Live News states

- **FULL_ARTICLE_EXTRACTED** — the public article body was successfully retrieved and extracted.
- **RSS_SUMMARY_ONLY** — the publisher page was unavailable or blocked, but the feed contained substantive summary text; the result is explicitly labeled as summary-only.
- **HEADLINE_ONLY** — only a headline was available; classification is withheld.
- **EXTRACTION_BLOCKED** — automated article retrieval was blocked, such as a publisher HTTP 403.
- **TEXT_DIRECT** — text was supplied directly by the user.

This prevents the interface from presenting a headline or RSS summary as if it were the complete article.

### URL extraction pipeline

~~~text
User URL
  ↓
syntax / protocol validation
  ↓
DNS and IP security checks
  ↓
secure fetch with redirect re-validation
  ↓
content-type + payload-size + timeout checks
  ↓
semantic article / JSON-LD extraction
  ↓
word/character/context checks
  ↓
analysis or honest fallback
~~~

HTTP failures retain their semantic meaning:

| Status | Meaning |
|---|---|
| 400 | Invalid URL or SSRF/security rejection |
| 403 | Publisher blocked automated extraction |
| 404 | Requested article/page does not exist |
| 429 | Publisher rate-limited the request |
| 502 | Upstream/server gateway failure |
| 504 | Fetch timeout |

A publisher's current access policy can legitimately prevent automated extraction. TruthLens does not bypass authentication, publisher controls, or SSRF protections.

For a reliable demonstration, prefer a **current public URL from Live News** or another URL that has been freshly verified. Stale publisher article paths may legitimately return 404 even when the domain itself is reachable.

## Security

The URL extraction boundary is intentionally defensive.

Current protections include:

- localhost and loopback blocking
- private IPv4 ranges
- cloud metadata/link-local ranges
- IPv6 loopback/unique-local/link-local checks
- forbidden URL protocols such as **file://**
- DNS pre-flight resolution
- redirect re-validation on every hop
- maximum redirect count
- fetch timeout
- response byte limit
- HTML/XHTML content-type validation
- prompt-injection treatment of retrieved web content as untrusted data

External article content must never override system/developer instructions, tool permissions, verdict contracts, or evidence rules.

## Getting Started

### Prerequisites

- Node.js 20 or newer.
- Python 3 for the offline training/evaluation pipeline.
- Git LFS is useful when working with the raw ISOT input files locally.
- **GEMINI_API_KEY** is optional and is used by configured claim/evidence verification features.

### Install

~~~bash
npm install
~~~

### Production-style local run

~~~bash
npm run build
npm start
~~~

Open:

~~~text
http://localhost:3000
~~~

### Development

~~~bash
npm run dev
~~~

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| **NODE_ENV** | Production | Render sets this to production. |
| **PORT** | No | Runtime port; local default is 3000. |
| **GEMINI_API_KEY** | Optional | Optional claim/evidence verification integration. |

Never commit secrets.

## Deployment

### Render

The public demonstration service is:

**https://truthlens-ai-dvpf.onrender.com**

The repository contains **render.yaml** with the production web-service configuration.

The application is designed to run as one Node service: the frontend and API are served from the same deployment.

### Vercel

The repository also contains a Vercel-compatible serverless entrypoint and Vercel-specific packaging/runtime hardening.

Vercel builds are used for deployment verification and the repository keeps a serverless adapter for that environment. Anonymous Vercel production requests may be blocked by Deployment Protection/SSO depending on the active project settings; this is separate from application-level API behavior.

## Testing

### TypeScript and production build

~~~bash
npm run lint
npm run build
~~~

### Node regression suites

~~~bash
npm run test:contracts
npm run test:vercel-sim
npm run test:verdicts
npx tsx scripts/ssrfTests.ts
~~~

The current release has recorded:

- **47/47** contract tests
- **26/26** verdict regression tests
- **8/8** SSRF endpoint tests
- Vercel simulation checks
- CI type-check/build, ISOT pipeline, benchmark and validation workflows

### Python / research tests

The Python backend contains the offline training/evaluation pipeline. CI also validates the real ISOT input and retraining workflow without requiring the large raw CSV inputs to be committed directly to the application source.

## Project Structure

~~~text
.
├── src/                         # React/Vite frontend
├── server.ts                    # Express production entry point
├── server/
│   ├── mlEngine.ts              # Production ML engine
│   ├── extraction/              # URL/article extraction
│   ├── news/                    # RSS/Atom service
│   ├── verification/            # Claims and evidence
│   ├── security/                # SSRF / URL security
│   └── sqliteHistory.ts         # SQLite history
├── backend/                     # Offline Python ML/research pipeline
├── data/                        # Artifacts, datasets, metrics, validation reports
├── scripts/                     # Training, evaluation, regression and simulations
├── render.yaml                  # Render service configuration
├── vercel.json                  # Vercel runtime configuration
├── package.json                 # Node scripts and dependencies
└── tsconfig.json                # TypeScript configuration
~~~

## TDP / Academic Report

TruthLens is a B.Tech CSE-AIML Trans-Disciplinary Project covering:

| Area | Current project work |
|---|---|
| Machine Learning | ISOT-trained calibrated Linear SVM, TF-IDF, Platt calibration, uncertainty thresholds |
| Natural Language Processing | Text normalization, n-gram features, linguistic signals, claim extraction |
| Data Science | Stratified split, 5-fold cross-validation, held-out evaluation, precision/recall/F1/confusion matrix |
| Web / Full-stack | React/Vite frontend with Node/Express production API |
| Information verification | Secure URL extraction, RSS/Atom feeds, claim extraction, evidence search and source provenance |
| Security | SSRF controls, redirect validation, response limits, prompt-injection boundaries |
| Responsible AI | Explicit uncertainty, honest limitations, no fabricated evidence/confidence/citations |
| Deployment engineering | Render production service, Vercel serverless compatibility, runtime/artifact safeguards |

For the TDP report, quote model metrics from generated artifacts/diagnostics and identify the dataset/task they belong to. Do not present the ISOT benchmark score as universal real-world fact-checking accuracy.

## Limitations

### Dataset and domain

The current article classifier is trained on the ISOT benchmark corpus. The benchmark is older and English-focused. Performance can degrade on:

- current events outside the training distribution
- multilingual or Hinglish content
- satire
- very short claims
- novel topics
- sources with unusual formatting

### Out-of-domain validation

The current LIAR external validation shows substantially lower performance than the ISOT article benchmark. This is treated as a real domain/task-shift finding, not hidden.

LIAR is a short-claim benchmark, while the ISOT production model is trained on article-like news text. A dedicated claim-level model is therefore a separate maturity track rather than an excuse to relabel or manipulate the existing article model's benchmark.

### Web extraction

Article extraction depends on the target publisher permitting automated retrieval. A 403 or 404 can be a property of the target website rather than a failure of the ML classifier. TruthLens surfaces these states explicitly and provides RSS-summary or manual-text fallbacks where appropriate.

### Fact-checking scope

TruthLens is a verification-support system. A model probability is not proof of truth or falsity, and external evidence availability can vary.

## Roadmap

Planned maturity work includes:

- dedicated claim-level modeling for short fact-checking claims
- evidence-grounded claim verification
- broader and newer multilingual evaluation
- stronger out-of-distribution benchmarks
- continuously refreshed datasets and evaluation
- further source/provenance quality controls
- production observability and durable storage improvements

The roadmap is intentionally separated from the current verified article-classification release so benchmark claims remain reproducible and honest.

## Project Status

**Current release:** ISOT-trained article classifier + secure URL extraction + Live News/RSS + claim/evidence workflow + production safeguards.

**Production article artifact:** **3.0.0-isot**

**Main branch:** latest verified release includes PR #16 Live News/URL stabilization and PR #17/#18 ISOT model promotion/diagnostics work.

**Demo:** https://truthlens-ai-dvpf.onrender.com

Built by Pappu Yadav — B.Tech CSE-AIML Trans-Disciplinary Project.
