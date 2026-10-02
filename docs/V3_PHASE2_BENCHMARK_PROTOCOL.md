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

Gate-14 workflow #220 / GitHub run `36751159351` completed on research head `a6563c17e6897c91a1fd8a8c483df2ff5e07c824`.

- Open candidate recall: **60.33%**
- Gold evidence Recall@5: **73.40%**
- Directional accuracy: **34.33%**
- Directional macro-F1: **0.318131**
- Production-policy abstention: **75%**
- Non-abstain coverage: **25%**

Retained artifact digest: `sha256:7349a2c45115f59efdfc88f30856f81f9b5a24acc7a2f698952eaf3116c6f351`.

A newer end-to-end SciFact workflow is still running on the Phase 2 branch. Its result must be recorded from the completed artifact before becoming the authoritative Phase 2 baseline.

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

Status: **PROTOCOL_FROZEN_EVIDENCE_MATERIALIZATION_PENDING**

The train/dev claim JSON is frozen:

- train: `ae5eda7c42ddf1695ef185a7ba1bc716928f5adf57103e4f78aae5f9afe00f9c`
- dev: `499793726b4a5406780928a3d9dedc48d6dd53de778f22437d129cacdb08e300`

The official AVeriTeC repository documents a provided knowledge store as the reproducible alternative to live Google Search, and the public Hugging Face AVeriTeC repository exposes the dev knowledge store as an 11.5 GB Xet file. The pinned dev knowledge-store source at revision `26238ae` has SHA-256 `021e258cd6fb5fe6d627a4667d663e95c184c966939c15124df9206142fc2212`. citeturn109482search1turn506905view0

A dedicated GitHub Actions gate, **Phase 2 AVeriTeC Evidence Store Materialization**, now downloads that pinned asset, verifies the SHA-256, and publishes a materialization manifest. No end-to-end AVeriTeC score is publishable until this gate completes successfully.

### TruthLens Open-Web v1

Status: **PLANNED_EXTERNAL_COLLECTION**

This lane still requires a human-labelled, blind external holdout with the frozen temporal/source-independence rules before system evaluation.

## Phase 2 exit gate

Phase 2 exits only when every required lane has exact input hashes, fixed splits, deterministic runner configuration, a complete artifact, workflow/run provenance, a metric/limitation record, and an unchanged production model/policy.

The current remaining Phase 2 blockers are therefore the completion/provenance of the new AVeriTeC evidence-store materialization gate, the final artifact from the running SciFact end-to-end workflow, and the future TruthLens Open-Web v1 external collection.
