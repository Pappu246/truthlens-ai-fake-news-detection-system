# TruthLens Phase 2 Multi-Benchmark Protocol

## Scope

Phase 2 expands evaluation beyond a single SciFact measurement while preserving metric separation and the production/research boundary.

Frozen lanes:

1. SciFact — scientific claim verification with evidence.
2. FEVER v1 — Wikipedia textual claim verification.
3. FEVEROUS — verification over Wikipedia prose and structured table evidence.
4. AVeriTeC — real-world claim verification with evidence from the web.
5. TruthLens Open-Web v1 — a future human-labelled fresh-claim holdout.

## Rules

- Every benchmark records the exact release, source URL, split, input hashes, model versions, retrieval configuration, output artifact, workflow/run ID, and artifact digest before a result is published.
- Article, claim, retrieval, reasoning, calibration, and external-benchmark metrics remain separate.
- Gold evidence is never inserted into an open retrieval pool.
- A completed artifact is mandatory before publishing a benchmark result.
- No benchmark result changes production model weights, thresholds, source rules, or abstention policy.

## Current SciFact baseline

The latest completed full-corpus SciFact artifact is **Run #87** (`36597257830`). The evaluated commit `5275121a425a2b8a297c6a3dd375d98ac46fa2c7` remains benchmark-runtime-equivalent to the current V2 implementation; the verified interval to the later documentation/test head contains no SciFact runtime, model, retrieval, NLI, or benchmark-workflow implementation change.

- Open candidate recall: **60.33%**
- Gold evidence Recall@5: **73.40%**
- Directional accuracy: **34.33%**
- Directional macro-F1: **0.320335**
- Production-policy abstention: **75%**
- Non-abstain coverage: **25%**

Artifact ID: `11051501500`. The benchmark remains a research/evaluation measurement only; it does not establish production or universal real-world accuracy.

## External protocol sources

- FEVER: https://fever.ai/dataset/fever.html
- FEVEROUS: https://fever.ai/dataset/feverous.html
- AVeriTeC: https://fever.ai/dataset/averitec.html
- SciFact: https://github.com/allenai/scifact
- AVeriTeC paper: https://arxiv.org/abs/2305.13117

## Materialization status

### FEVER v1

Status: **FROZEN_AND_MATERIALIZED**

The successful Phase 2 materialization workflow #10 produced the following exact inputs:

- `train.jsonl`: `eba7e8f87076753f8494718b9a857827af7bf73e76c9e4b75420207d26e588b6`
- `shared_task_dev.jsonl`: `e89865bfe1b4dd054e03dd57d7241a6fde24862905f31117cf0cd719f7c78df7`
- `wiki-pages.zip`: `4b06d95da6adf7fe02d2796176c670dacccb21348da89cba4c50676ab99665f2`

Materialization artifact digest: `sha256:0a98f1cf50a3ed54c17817d3a542139ea009c3cb04c752c606ec864658a0ae60`.

### FEVEROUS

Status: **FROZEN_AND_MATERIALIZED**

The successful Phase 2 materialization workflow #10 produced the following exact inputs:

- `feverous_train_challenges.jsonl`: `0c29ccba41e27c5b988ca5132085e8d67c7921f265707bea170bfbde12bceee7`
- `feverous_dev_challenges.jsonl`: `1ac8cfd964d4dcedc5de3375850fe3f93d39b89a73a475734bde864da1701f8f`
- `feverous-wiki-pages-db.zip`: `e25e034d9848c75ab3311a7a7ad8e80e769240b5a36b055da475f20071314881`

Materialization artifact digest: `sha256:0a98f1cf50a3ed54c17817d3a542139ea009c3cb04c752c606ec864658a0ae60`.

### AVeriTeC

Status: **FROZEN_AND_MATERIALIZED — scoring pending**

The train/dev claim JSON is frozen:

- train: `ae5eda7c42ddf1695ef185a7ba1bc716928f5adf57103e4f78aae5f9afe00f9c`
- dev: `499793726b4a5406780928a3d9dedc48d6dd53de778f22437d129cacdb08e300`

The official AVeriTeC repository documents a provided knowledge store as the reproducible alternative to live Google Search, and the public Hugging Face AVeriTeC repository exposes the dev knowledge store as an 11.5 GB Xet file. The pinned dev knowledge-store source at revision `26238ae` has SHA-256 `021e258cd6fb5fe6d627a4667d663e95c184c966939c15124df9206142fc2212`. citeturn109482search1turn506905view0

A dedicated GitHub Actions gate, **Phase 2 AVeriTeC Evidence Store Materialization**, completed successfully in workflow run **#6**. It downloaded the pinned asset, verified SHA-256 `021e258cd6fb5fe6d627a4667d663e95c184c966939c15124df9206142fc2212`, and uploaded the materialization manifest artifact `truthlens-phase2-averitec-evidence-materialization` (artifact digest `sha256:c5e1da712d42f264f10a637fe417bac0abfced0dd6873161a5a437db8c2e9480`). The materialization gate is complete; **end-to-end AVeriTeC scoring remains pending**.

### TruthLens Open-Web v1

Status: **PLANNED_EXTERNAL_COLLECTION**

This lane still requires a human-labelled, blind external holdout with the frozen temporal/source-independence rules before system evaluation.

## Phase 2 exit gate

Phase 2 exits only when every required lane has exact input hashes, fixed splits, deterministic runner configuration, a complete artifact, workflow/run provenance, a metric/limitation record, and an unchanged production model/policy.

The current Phase 2 blockers are the benchmark-result artifacts for FEVER v1, FEVEROUS, and AVeriTeC, plus the future TruthLens Open-Web v1 blind human-labelled holdout. The SciFact lane already has an authoritative completed artifact.

## Shared sealed model protocol (current-head recovery)

All four public benchmark lanes use the same sealed local model artifacts:

- NLI: `Xenova/nli-deberta-v3-xsmall`, artifact SHA-256 `3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6`.
- Embeddings: `Xenova/all-MiniLM-L6-v2`, artifact SHA-256 `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`.
- Sealed model-manifest SHA-256: `f545488704f895af94b781601c3a746b2e371e30bc8cdec7431f44917d9a1832`.

Each benchmark report must bind the evaluated commit, runtime-configuration hash, model-manifest hash, and individual NLI/embedding artifact hashes. The exact-head public gate rejects model drift between FEVER, FEVEROUS, AVeriTeC, and SciFact.

For FEVER and FEVEROUS, the official benchmark label is produced from the same weighted evidence-level NLI vote used by the SciFact and AVeriTeC research evaluators. Production-policy-mapped accuracy is reported separately. FEVER, FEVEROUS, and AVeriTeC disable the LIAR prior; SciFact's directional benchmark label is evidence-only. No benchmark result is treated as production accuracy.

The official scorer remains authoritative for each benchmark's task metric. Retrieval recall, directional label accuracy, production-policy metrics, and evidence quality are separate measures and must not be substituted for one another.

The public benchmark gate is intentionally not the full Phase 2 exit gate. It cannot clear the separate blind, independently human-annotated Open-Web holdout requirement.
