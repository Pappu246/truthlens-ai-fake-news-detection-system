# TruthLens AI

TruthLens AI is a TypeScript/Node.js system for news-analysis assistance. It combines an ISOT-trained article classifier, a separate LIAR claim model, URL article extraction, live RSS/Atom news, retrieval-based evidence verification, and SQLite-backed history.

[![Live demo](https://img.shields.io/badge/demo-live-667085?style=flat-square)](https://truthlens-ai-dvpf.onrender.com)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-667085?style=flat-square)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-667085?style=flat-square)](tsconfig.json)
[![CI](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/workflows/ci.yml/badge.svg)](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/workflows/ci.yml)

> TruthLens is a decision-support and verification-support system. A model output, probability, evidence status, or citation is not proof that a real-world article or claim is true or false.

## Verified release snapshot

The current application source of truth is `main` at the latest verified release merge lineage (`1c2eb48` V2 production merge, followed by `009bc32` V3 research-foundation merge). The V3 research foundation is additive and does not replace the production contracts. The live Render production smoke verification recorded **55/55 checks passed** on 2026-09-29 UTC.

Article and claim measurements below are separate benchmarks. They must not be added, averaged, or presented as one overall accuracy.

## What is in production?

| Component | Data and task | Runtime endpoint | Verified benchmark/result |
|---|---|---|---|
| Article model | ISOT full-article `REAL` / `FAKE` classification | `/api/analyze` | Linear SVM, held-out accuracy **0.9959**, test `n=7,732` |
| Claim model | LIAR binary `TRUE` / `FALSE` claim classification | `/api/claim/predict` | `text_only` accuracy **0.6271820449**, macro-F1 **0.6152909487**, test `n=802` |
| Evidence engine | Live retrieval and support/contradiction analysis | `/api/evidence/verify` | Per-request signal; no stored accuracy number |

The API exposes separate `article_model`, `claim_model`, and `benchmarks` blocks from `/api/models/metrics`. The models solve different tasks on different corpora.

> **V2 stack note:** `server/v2/**` and `POST /api/v2/evidence/verify` are additive evidence-grounded verification capabilities merged through the verified V2 release. Their research benchmark metrics remain separate from the established article/claim production benchmark metrics. See [`docs/V2_ARCHITECTURE.md`](docs/V2_ARCHITECTURE.md), [`docs/V2_BENCHMARK_PROTOCOL.md`](docs/V2_BENCHMARK_PROTOCOL.md), and [`docs/V2_KNOWN_LIMITATIONS.md`](docs/V2_KNOWN_LIMITATIONS.md).

## Article model

The production article artifact is **Linear SVM (Calibrated), `v3.0.0-isot`**, using an 8,000-feature TF-IDF representation with 1–2 grams and sublinear term frequency. Probabilities use Platt sigmoid calibration.

It was evaluated on the genuine held-out ISOT test split:
