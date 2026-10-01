# TruthLens Phase 2 Multi-Benchmark Protocol

## Scope

Phase 2 expands evaluation beyond a single SciFact measurement while preserving metric separation and the production/research boundary.

Frozen lanes:

1. SciFact — scientific claim verification with evidence.
2. FEVER v1 — Wikipedia textual claim verification.
3. FEVEROUS — verification over Wikipedia prose and structured table evidence.
4. AVeriTeC — real-world claim verification with evidence from the web.
5. TruthLens Open-Web v1 — a future human-labelled fresh-claim holdout.

Only SciFact currently has verified local input hashes. The other lanes have frozen protocol definitions but still require exact data materialization, SHA-256 hashing, and end-to-end execution.

## Rules

- Every benchmark records the exact release, source URL, split, input hashes, model versions, retrieval configuration, output artifact, workflow/run ID, and artifact digest before a result is published.
- Article, claim, retrieval, reasoning, calibration, and external-benchmark metrics remain separate.
- Gold evidence is never inserted into an open retrieval pool.
- A completed artifact is mandatory before publishing a benchmark result.
- No benchmark result changes production model weights, thresholds, source rules, or abstention policy.

## Current SciFact baseline

Gate-14 workflow #220 / GitHub run `36751159351` completed on research head `a6563c17e6897c91a1fd8a8c483df2ff5e07c824`.

- Open candidate recall: **60.33%**
- Gold evidence Recall@5: **73.40%**
- Directional accuracy: **34.33%**
- Directional macro-F1: **0.318131**
- Production-policy abstention: **75%**
- Non-abstain coverage: **25%**

Retained artifact digest: `sha256:7349a2c45115f59efdfc88f30856f81f9b5a24acc7a2f698952eaf3116c6f351`.

## External protocol sources

- FEVER: https://fever.ai/dataset/fever.html
- FEVEROUS: https://fever.ai/dataset/feverous.html
- AVeriTeC: https://fever.ai/dataset/averitec.html
- SciFact: https://github.com/allenai/scifact
- AVeriTeC paper: https://arxiv.org/abs/2305.13117

## Materialization status

`fever_v1`, `feverous`, and `averitec` are `PROTOCOL_FROZEN_DATA_HASH_PENDING` until the exact release is materialized and hashed. For AVeriTeC, the claim JSON is not sufficient by itself: the provided evidence collection (or an equivalent frozen snapshot) must also be versioned and hashed before an end-to-end open-web result is published. `truthlens_open_web_v1` remains `PLANNED_EXTERNAL_COLLECTION` until its claims, labels, and blind holdout are frozen.

## Phase 2 exit gate

Phase 2 exits only when every required lane has exact input hashes, fixed splits, deterministic runner configuration, a complete artifact, workflow/run provenance, a metric/limitation record, and an unchanged production model/policy.

