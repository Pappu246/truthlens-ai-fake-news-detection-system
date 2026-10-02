# TruthLens AI

## AI-Based Fake News Detection and Article Verification System

TruthLens AI is my B.Tech AI & ML TDP project. I built it to explore how machine learning, article analysis, and evidence-based verification can be brought together in one practical system.

The basic idea is simple: **give TruthLens a news article or a claim, and the system analyses it, checks the available evidence, and explains what it found instead of blindly forcing a result.**

## Project Details

- **Student:** Pappu Yadav
- **Program:** B.Tech – Artificial Intelligence & Machine Learning
- **University:** Vivekananda Global University, Jaipur, Rajasthan
- **Project:** TruthLens AI
- **Project Type:** B.Tech TDP / Academic Project

[![Live Demo](https://img.shields.io/badge/demo-live-667085?style=flat-square)](https://truthlens-ai-dvpf.onrender.com)
[![CI](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/workflows/ci.yml/badge.svg)](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/workflows/ci.yml)

---

## What does TruthLens do?

TruthLens is designed around a simple workflow:

**Article / Claim → Analysis → Evidence → Result**

It can:

- analyse article text;
- analyse a news article directly from its URL;
- extract important claims from an article;
- check claims using retrieved evidence;
- show source and provenance information;
- work with live RSS/Atom news feeds;
- return an abstention state when there is not enough reliable evidence;
- keep analysis history in SQLite.

The system is not meant to replace a human fact-checker. Its purpose is to give the user a useful, traceable starting point for verification.

---

## How the system works

At a high level, TruthLens has separate components for article classification, claim analysis, URL extraction, evidence retrieval, and live news.

```text
User
  |
  v
TruthLens Web Interface
  |
  +----> Article Analysis
  |         |
  |         +--> ISOT-based article model
  |
  +----> Claim Verification
  |         |
  |         +--> LIAR-based claim model
  |         +--> Evidence retrieval
  |         +--> Source / provenance checks
  |
  +----> URL Analysis
  |         |
  |         +--> Secure article extraction
  |         +--> Analysis of extracted content
  |
  +----> Live News
            |
            +--> RSS / Atom feeds
```

The production application runs with **React/Vite on the frontend and Node.js/Express on the backend**. Python is mainly used for the offline ML training and evaluation work.

---

## Main features

### 1. Article Analysis

A user can paste article text and receive a model-based analysis.

The production article classifier is a **calibrated Linear SVM trained on the ISOT Fake News dataset**.

Current held-out ISOT test result:

| Metric | Result |
|---|---:|
| Test samples | 7,732 |
| Accuracy | 99.59% |
| Precision | 99.43% |
| Recall | 99.66% |
| F1-score | 99.54% |

These numbers are **benchmark results on the ISOT test set**. They are not a guarantee that every current real-world article will be classified correctly.

---

### 2. Claim Verification

TruthLens also has a separate claim model based on the **LIAR dataset**.

The claim model is kept separate from the article model because they solve different problems and are trained on different data.

| Variant | Accuracy | Macro F1 | Test samples |
|---|---:|---:|---:|
| Text only | 62.72% | 61.53% | 802 |
| Text + available metadata | 65.84% | 64.70% | 802 |

The metadata version is only used when the required metadata is actually available.

I do **not** combine the article-model accuracy and claim-model accuracy into one overall percentage.

---

### 3. Evidence-Based Verification

One of the main parts of TruthLens is the evidence layer.

For a claim, the system can:

1. build a search query;
2. retrieve candidate evidence;
3. analyse the relevance of the retrieved material;
4. compare the evidence with the claim;
5. return a verification state;
6. preserve the source URL and provenance information.

Possible evidence states include:

- `SUPPORTED`
- `CONTRADICTED`
- `MIXED`
- `INSUFFICIENT_EVIDENCE`
- `NEEDS_MORE_CONTEXT`
- `SEARCH_UNAVAILABLE`

A useful part of this design is that **the system can abstain**. When reliable evidence is not available, TruthLens does not invent a citation just to produce a confident-looking answer.

---

## URL analysis and security

TruthLens can accept a news article URL and extract the article before analysis.

The URL pipeline includes:

- URL validation;
- SSRF protection;
- redirect validation;
- loopback/private/link-local address checks;
- response size and timeout limits;
- content-type validation;
- handling for common publisher errors such as 403, 404 and 429;
- removal of scripts and common page boilerplate before extraction.

This means an article URL is treated as untrusted external input rather than as trusted content.

---

## Live News

TruthLens can read configured RSS/Atom feeds and label the received content before returning it to the frontend.

Examples of content labels include:

- `RSS_SUMMARY_ONLY`
- `HEADLINE_ONLY`
- `FULL_ARTICLE_EXTRACTED`
- `EXTRACTION_BLOCKED`

Headline-only content is not treated as if it were a full article. The application can return `NEEDS_MORE_CONTEXT` when there is not enough information to justify a prediction.

---

## Production API

Some of the main API routes are:

| Route | Purpose |
|---|---|
| `GET /api/health` | Service and model health |
| `GET /api/models/metrics` | Model metrics and runtime information |
| `POST /api/analyze` | Analyse article text |
| `POST /api/analyze-url` | Extract and analyse an article URL |
| `POST /api/article/extract` | Extract article content |
| `GET /api/news/latest` | Live RSS/Atom news |
| `GET /api/claim/metrics` | Claim model metrics |
| `POST /api/claim/predict` | Predict a claim |
| `POST /api/evidence/verify` | Verify a claim using retrieved evidence |

---

## Current project status

The production code is currently kept stable for the project demonstration.

Latest verified main branch:

`a22e9578503150e94afdc022c040813e4850b1d3`

Current production verification includes:

- **GitHub CI:** passed
- **Production smoke test:** **53/53 passed**
- **Vercel production:** READY
- **Health endpoint:** 200
- **Model metrics:** 200
- **Claim metrics:** 200
- **Live news endpoint:** 200
- **Production model artifact:** loads successfully

The production article model and its artifact were not changed as part of the recent deployment/runtime fixes.

---

## Testing

The project includes automated tests for the major parts of the system, including:

- API contracts;
- article verdict behaviour;
- claim model behaviour;
- Python/Node model parity;
- evidence verification;
- model artifact loading;
- SSRF protection;
- V2 pipeline and route behaviour;
- deployment/runtime checks.

The latest production smoke run completed with:

**53 passed, 0 failed**

---

## Project structure

```text
src/                         Frontend (React / Vite)
server.ts                   Node / Express entry point
server/                     Production API and services
backend/                    Offline ML / research pipeline
data/                       Datasets and model artifacts
docs/                       Project and research documentation
scripts/                    Tests, evaluation and verification scripts
render.yaml                 Render deployment configuration
```

---

## Running the project locally

### Requirements

- Node.js 20 or newer
- Python 3 for the offline ML/research pipeline

### Install

`npm ci`

### Start in development

`npm run dev`

### Production-style local build

`npm run build`
`npm start`

Do not commit API keys or other credentials to the repository.

---

## Important limitations

TruthLens is a machine-learning and verification-support system, so its outputs should be interpreted with the available evidence.

The main limitations are:

1. The article model is benchmarked on ISOT and may not generalise perfectly to current news, satire, Hindi/Hinglish content, or completely different domains.
2. The LIAR claim model is a separate and comparatively weaker signal.
3. Evidence availability depends on external sources and network access.
4. A supported claim is evidence-based corroboration, not a mathematical proof of truth.
5. When evidence is insufficient, the system is designed to say so instead of making up a source.

---

## Why I built TruthLens

The goal of this project was not just to train a classifier and display **FAKE / REAL**.

I wanted to build something closer to a practical verification workflow where a user can:

**submit content → analyse it → inspect the evidence → see the source → understand the limitation**

That is the direction I followed while developing TruthLens AI.

---

## Documentation

More detailed technical material is available in the `docs/` directory, including:

- architecture documentation;
- evidence-engine documentation;
- claim-model documentation;
- benchmark and evaluation reports;
- V2 research documentation;
- security and threat-model notes.

---

**TruthLens AI — B.Tech TDP Project**  
**Developed by Pappu Yadav**  
**B.Tech Artificial Intelligence & Machine Learning**  
**Vivekananda Global University, Jaipur**
