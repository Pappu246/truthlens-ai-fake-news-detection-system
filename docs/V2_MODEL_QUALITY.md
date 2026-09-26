# TruthLens V2 — Model Quality Upgrade

## What changed

The V2 research stack now has production-shaped seams for real pretrained inference while keeping deterministic offline CI as the default.

### NLI

Set:

```bash
TRUTHLENS_ENABLE_REMOTE_NLI=true
HF_TOKEN=hf_...
```

The default remote model is `facebook/bart-large-mnli`.

The adapter calls Hugging Face Inference Providers and maps three zero-shot labels into the V2 evidence labels. This is a real pretrained NLI model path, but it is not the same as a dedicated pairwise cross-encoder call; a local/managed cross-encoder remains a future upgrade.

### Embeddings

Set:

```bash
TRUTHLENS_ENABLE_REMOTE_EMBEDDINGS=true
HF_TOKEN=hf_...
```

The default remote embedding model is `BAAI/bge-small-en-v1.5`.

The adapter uses the Hugging Face feature-extraction task and returns a normalised vector. Hybrid retrieval remains BM25 + dense retrieval + RRF.

You can override models:

```bash
TRUTHLENS_NLI_MODEL=facebook/bart-large-mnli
TRUTHLENS_EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
```

Remote inference is opt-in and should not be enabled in offline CI.

## Conflict reasoning

The decision policy no longer requires mathematically symmetric support/refute strength. A genuine dispute can be `CONFLICTED` when:

- both sides have at least one independent domain;
- each side has material weighted evidence;
- each side has a minimum top vote;
- the weaker side is at least 40% as strong as the stronger side.

Every conflict decision is recorded as `independent_material_conflict` in the provenance rule trace.

This is designed to address the previous weak `CONFLICTED` recall without allowing a single weak/off-topic document to create a conflict.

## Confidence calibration

The evaluation harness now reports:

- raw ECE;
- Brier score;
- deterministic calibration/holdout split;
- fitted temperature;
- raw holdout ECE;
- temperature-scaled holdout ECE.

Runtime confidence is not silently recalibrated from the development set. A held-out calibration artifact must be selected and versioned before changing production confidence semantics.

## Test commands

Offline regression:

```bash
npm run test:v2-quality
npm run test:all-with-v2
```

Evaluation:

```bash
npm run eval:v2
```

## Safety and fallback behavior

If the remote flags or `HF_TOKEN` are absent, the system falls back to deterministic hashing embeddings and deterministic heuristic NLI.

No API token is required for CI. Remote failures should be treated as model-provider failures and surfaced in diagnostics rather than silently presented as pretrained-model results.
