# TruthLens V2 — Known Limitations & Model Quality Notes

This document keeps the remaining limitations explicit. The V2 stack now has optional pretrained inference adapters, but deterministic offline adapters remain the CI-safe default.

## 1. Pretrained embeddings are optional, not the offline default

`server/v2/retrieval/embeddings.ts` still provides `HashingNgramEmbeddingModel` for deterministic, dependency-free CI. It is not a pretrained semantic encoder and cannot reliably capture synonym-level meaning.

An optional Hugging Face feature-extraction adapter is now available in `server/v2/retrieval/huggingFaceEmbeddingModel.ts`. Enable it with `TRUTHLENS_ENABLE_REMOTE_EMBEDDINGS=true` and `HF_TOKEN`. The model can be overridden with `TRUTHLENS_EMBEDDING_MODEL`.

Because remote inference depends on external service availability and rate limits, CI and offline evaluations continue to use the hashing adapter unless explicitly configured otherwise.

## 2. Pretrained NLI is available, but the default fallback remains heuristic

`server/v2/nli/heuristicNliAdapter.ts` remains the deterministic fallback.

`server/v2/nli/huggingFaceNliAdapter.ts` adds an opt-in pretrained zero-shot NLI path using Hugging Face Inference Providers. The default model is `facebook/bart-large-mnli`.

This is a material upgrade over cue-word classification, but it is not the same as a dedicated pairwise cross-encoder invocation. The next model-quality step should benchmark a managed or local pairwise NLI model such as a DeBERTa-style cross-encoder against the same held-out claims.

## 3. Conflict detection is stronger, but still rule-based

The decision policy now looks for independent material evidence on both sides and no longer requires near-perfect symmetry. This is intended to reduce the previously weak `CONFLICTED` recall.

However, conflict resolution is still a deterministic aggregation policy, not a learned discourse-reasoning model. Temporal disagreement, source hierarchy, claim scope, and multi-hop dependencies can still create difficult edge cases.

## 4. The evaluation fixture set is small and synthetic

`data/v2/eval_fixtures.json` contains 56 manually authored fixtures across eight domains. The corpus text is synthetic and intentionally deterministic. The set is useful for regression and engineering comparisons, but it is not a world-level benchmark and should not be treated as evidence of general real-world accuracy.

## 5. Live retrieval remains network-dependent

`LiveEvidenceProviderCorpusSource` wraps the existing production evidence provider. Network-restricted environments can return zero candidates, in which case the pipeline abstains rather than inventing evidence.

## 6. Confidence calibration is still a separate research problem

The evaluation harness now reports raw ECE, Brier score, and a held-out temperature-scaling analysis. Runtime confidence is deliberately not recalibrated from the same development fixtures.

Before changing production confidence semantics, fit and version a calibration artifact on an independently labelled calibration set and evaluate it on a separate holdout.

## 7. Full-text enrichment is still opt-in

Full-text extraction is implemented but disabled by default. This keeps the first research slice deterministic and limits network/SSRF exposure.

## 8. Multimodal, multilingual and continual-learning capabilities are not part of this milestone

These remain out of scope for the current V2 research slice.

## Current recommended research path

1. Benchmark the optional pretrained embedding + NLI adapters on an external, held-out real-world dataset.
2. Replace the zero-shot NLI bridge with a dedicated pairwise cross-encoder adapter if the benchmark shows a measurable gain.
3. Fit a versioned confidence calibrator on a separate calibration split.
4. Only then consider changing the production evidence engine or merging V2 behavior into it.
