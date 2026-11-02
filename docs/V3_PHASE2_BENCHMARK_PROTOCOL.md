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

The latest exact-current-main evaluation is workflow run **#376** (41191386168), evaluated against main commit 8b6df8c5c3d12b86d4384f6c01b19a22e4492d1a. It evaluated the complete frozen SciFact dev split: **300/300 claims** over **5,183 corpus documents**.

- Open candidate recall: **99.47%** (187/188 evidence-bearing claims)
- Gold evidence Recall@5: **86.17%** (162/188)
- Benchmark directional accuracy: **37.33%**
- Benchmark directional macro-F1: **0.356480**
- Production-policy mapped accuracy: **34.67%**
- Production-policy mapped macro-F1: **0.280330**
- Production-policy abstention: **70%**
- Conflicted rate: **4%**
- Non-abstain coverage: **30%**
- Accuracy among non-abstained claims: **31.11%**

Directional per-class metrics:
- SUPPORT — precision **1.000**, recall **0.137**, F1 **0.241** (124 claims)
- CONTRADICT — precision **0.279**, recall **0.750**, F1 **0.407** (64 claims)
- NOT_ENOUGH_INFO — precision **0.423**, recall **0.420**, F1 **0.422** (112 claims)

The low SUPPORT recall is a material weakness; high candidate recall must not be presented as high verification accuracy. The benchmark directional evaluator is single-source-compatible because classic SciFact evidence is tied to cited papers. Production-policy metrics are reported separately because the production two-independent-source rule does not map cleanly to this dataset.

Calibration is a research diagnostic only: raw ECE-10 **0.397657**, raw Brier **0.414668**, raw holdout ECE-10 **0.388980**, and calibrated holdout ECE-10 **0.237063** using a deterministic even/odd 150/150 split and temperature 4. This does not change runtime confidence semantics.

Provenance:
- Frozen claims SHA-256: 86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217
- Frozen corpus SHA-256: b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62
- Config SHA-256: 5f2bde4aeef1d2c781f5eeb86e781178a4baf392ada1bb775c576cfdf01373e8
- Sealed model manifest SHA-256: f545488704f895af94b781601c3a746b2e371e30bc8cdec7431f44917d9a1832
- NLI model: Xenova/nli-deberta-v3-xsmall, artifact SHA-256 3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6
- Embedding model: Xenova/all-MiniLM-L6-v2, artifact SHA-256 afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1
- Uploaded artifact ID: 13044720576; ZIP digest: sha256:ad13fc7c47af04bd1189112db26b7a61c7e75b05822503685f6947891ba512b4

This is a research/evaluation measurement only. It does not establish production or universal real-world accuracy and does not change production model weights, thresholds, source rules, or abstention policy. The earlier Run #87 result remains historical and should not be described as the newest current-main baseline.
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
