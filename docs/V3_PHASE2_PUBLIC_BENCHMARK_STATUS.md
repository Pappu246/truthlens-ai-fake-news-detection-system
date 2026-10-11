# TruthLens V3 Phase 2 — Public Benchmark Status

**Snapshot date:** 2026-10-11

## Scope

This document separates work that can be completed from fixed public datasets from the fresh Open-Web holdout that requires independent human annotation. It does not change the existing full Phase 2 exit gate and does not authorize production promotion.

## Verified research baselines

### SciFact development split — 300 claims

- Open candidate recall: **60.33%**.
- Gold evidence Recall@5: **73.40%**.
- Benchmark directional accuracy: **34.33%**.
- Benchmark directional macro-F1: **0.320335**.
- Production-policy abstention: **75%**, with **25%** non-abstain coverage and **28%** accuracy on non-abstained claims.
- Artifact: [V2 SciFact End-to-End Benchmark run #87](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/36597257830), artifact ID `11051501500`.
- Evaluation commit: `5275121a425a2b8a297c6a3dd375d98ac46fa2c7`; claims SHA-256 `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`; corpus SHA-256 `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`.

These SciFact metrics belong to the frozen dev benchmark only. Benchmark directional metrics and the production-policy view are distinct; the high abstention rate is reported rather than hidden.

## Verified official result

### AVeriTeC development split — 500 claims

- Official verdict accuracy: **52.2%**.
- Official veracity macro-F1: **0.2822664929** (28.23%).
- Official evaluator repository: MichSchli/AVeriTeC, pinned commit 7c62d1ec8df3fb560d6efe2b85fa191135636f81.
- Frozen claim data SHA-256: 499793726b4a5406780928a3d9dedc48d6dd53de778f22437d129cacdb08e300.
- Evidence store revision: 26238ae; frozen evidence store SHA-256: 021e258cd6fb5fe6d627a4667d663e95c184c966939c15124df9206142fc2212.
- Gold evidence was not injected into retrieval, and the run manifest explicitly keeps the evaluation research-only.
- Artifact generated at 2026-10-10T08:51:37Z by [GitHub Actions run #53](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/38026849131).
- The artifact's recorded evaluation SHA is c045ca4a1b51e723b1aa0d44d93acc1269b9a2a0, the merge of research source commit 214b2955874e2741f323da5bf497b973f57ef5b0 into production baseline 3530dead5dea67b89e8327c0994c1aeafb1fe68a.

These are AVeriTeC dev-split metrics only. They must not be described as the accuracy of TruthLens on all news, on production, or on fresh real-world claims.

## Still pending

| Benchmark / gate | Required evaluation | Current outcome |
|---|---:|---|
| FEVER v1 labeled dev | 19,998 claims | Full official score artifact not yet verified; the prior scoring run did not produce a completed score artifact. |
| FEVEROUS | 7,890 claims | Full official score artifact not yet verified; the prior scoring run did not produce a completed score artifact. |
| Open-Web V1 holdout | 100 human-labelled claims | Deferred: the human-labelled JSONL and truthful attestation file do not exist. |
| Full Phase 2 exit gate | All required official artifacts plus sealed holdout | Remains blocked. |

## Download reliability work

The full scoring workflow had spent extended time in dataset materialization. The benchmark-count mismatch was also corrected: the frozen FEVER labeled development asset contains 19,998 rows, so scoring and gating now target 19,998 instead of the previously misconfigured 37,566. The scoring-only materializer has been updated to use the previously materialized FEVER source URLs and known frozen archive byte counts, verify SHA-256 after download, attempt verified range downloads, and fall back to resumable curl when an origin does not support byte ranges. The research scoring workflow runs regression tests for the download helper and the public-benchmark gate.

## Gate semantics

The new public benchmark gate is intentionally narrower than the original Phase 2 gate. It can return READY_PUBLIC_BENCHMARKS_ONLY only when official score files, expected evaluation counts, metric fields, dataset/provenance files, and SHA-256 fingerprints validate for FEVER, FEVEROUS, and AVeriTeC. It always records the human Open-Web holdout as deferred and keeps production promotion disabled. The original phase2ExitGate.mjs remains authoritative for full Phase 2 completion.

## Production boundary

No production model, threshold, model artifact, API, or deployment was changed by this research work. Do not merge the research PR or promote research artifacts to production based only on a public benchmark subgate.