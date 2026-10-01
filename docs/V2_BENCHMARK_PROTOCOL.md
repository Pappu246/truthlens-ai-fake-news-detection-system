# TruthLens V2 — Evaluation Protocol

## Completed external SciFact checkpoint

The authoritative completed full-corpus SciFact result is recorded in `docs/V2_SCIFACT_E2E_RESULTS.md`. The frozen historical baseline is **Run #19**. The final Gate-14 current-head rerun is **Run #220 / workflow 36751159351** (300 dev claims / 5,183 corpus documents):

- Directional accuracy: **0.343333**
- Directional macro-F1: **0.318131**
- Open candidate recall: **0.603333**
- Gold-evidence Recall@5: **0.734043**
- Production-policy abstention: **0.75**
- Non-abstain coverage: **0.25**
- Non-abstain accuracy: **0.28**

These are research measurements only and do not alter production policy.

## Development fixture protocol

The deterministic fixture evaluation remains useful for regression engineering:

- File: `data/v2/eval_fixtures.json`
- Generator: `scripts/generate_v2_eval_fixtures.ts`
- 56 claims across eight categories
- Offline, synthetic corpus designed for deterministic regression

The fixture suite must not be presented as real-world accuracy.

## Current full-corpus research configuration

The current research branch evaluates the complete SciFact corpus through:

`claim -> shared claim extraction -> diversified query expansion -> BM25 + dense retrieval -> RRF -> reranking -> pretrained NLI -> research decision`

Current configuration:

- Candidate pool K: **100**
- Dense retrieval K: **300**
- Final evidence K: **8**
- Local NLI: `Xenova/nli-deberta-v3-xsmall`, q8@3fac2500
- Local embedding: `Xenova/all-MiniLM-L6-v2`, q8@afdb6f1a

The Gate-14 current-head end-to-end rerun completed successfully as workflow run **#220** on commit `a6563c17e6897c91a1fd8a8c483df2ff5e07c824`. Its retained artifact digest is `sha256:7349a2c45115f59efdfc88f30856f81f9b5a24acc7a2f698952eaf3116c6f351`.

## Metrics

The full-corpus benchmark reports:

1. Open candidate recall.
2. Gold evidence Recall@5 after reranking.
3. Directional accuracy and macro-F1 for SUPPORT / CONTRADICT / NOT_ENOUGH_INFO.
4. A separate production-policy view containing abstention, CONFLICTED rate, non-abstain coverage and mapped diagnostics.

The production-policy view is not treated as standard SciFact task accuracy because TruthLens production requires two independent directional sources.

## Research integrity

- Gold evidence is never injected into the open candidate pool.
- Dataset SHA-256 values are verified before evaluation.
- Sealed local model bytes are verified before evaluation.
- Canceled/incomplete runs are never recorded as benchmark results.
- Production thresholds, source requirements, abstention rules and production model artifacts are unchanged.
- Component model-quality metrics are never substituted for end-to-end verdict accuracy.

## Regeneration

- `npm run generate:v2-fixtures`
- `npm run eval:v2`
- `npm run test:v2`
- `npm run test:v2-route`

See `docs/V2_SCIFACT_E2E_RESULTS.md`, `docs/V2_KNOWN_LIMITATIONS.md`, and `docs/V2_END_TO_END_BENCHMARK.md` for the latest completed baseline and current-head evaluation status.
