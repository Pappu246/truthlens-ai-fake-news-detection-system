# TruthLens V3 Phase 2 - Multi-Benchmark Evaluation Protocol

## Goal

Phase 2 builds the evaluation foundation required before any accuracy/SOTA claim. The system must be able to say exactly which dataset, split, evidence setting, metric and model configuration produced a number.

## Protocol rules

A comparison is valid only when all of these match:
- benchmark dataset/version;
- evaluation split;
- evidence setting;
- primary metric definition;
- model input contract;
- test-set tuning policy.

A benchmark number is not converted into a universal real-world accuracy claim.

## Benchmark matrix

### SciFact

TruthLens already has a full-corpus runtime-equivalent evaluator in scripts/v2ScifactEndToEnd.ts.

Pinned inputs:
- 300 dev claims;
- 5,183 corpus documents;
- claims SHA-256: 86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217;
- corpus SHA-256: b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62.

Primary research metrics:
- open candidate recall;
- gold evidence Recall@5;
- directional accuracy;
- directional macro-F1.

The production two-independent-source policy is reported separately.

### FEVER

The official FEVER task scores accuracy only when sufficient correct evidence is also retrieved. The official scorer also exposes evidence precision, recall and F1. The first five predicted evidence sentences are considered by the official shared-task scorer.

Authoritative sources:
- https://fever.ai/dataset/fever.html
- https://fever.ai/2018/task.html
- https://github.com/sheffieldnlp/fever-scorer

TruthLens Phase 2 status: protocol-locked; adapter and pinned dataset package still required.

### AVeriTeC

AVeriTeC evaluates real-world claims using web evidence. The 2025 shared task specifies a revised document collection that addresses temporal leakage issues and provides a public leaderboard.

Authoritative sources:
- https://github.com/MichSchli/AVeriTeC
- https://fever.ai/2025/task.html

TruthLens Phase 2 status: protocol-locked; exact release/hash pinning and adapter still required.

### FEVEROUS

FEVEROUS extends verification to structured evidence such as table cells. Its scorer requires both verdict and evidence, and the official competition score depends on correct evidence retrieval.

Authoritative sources:
- https://fever.ai/dataset/feverous.html
- https://fever.ai/2021/task.html
- https://github.com/Raldir/FEVEROUS

TruthLens Phase 2 status: protocol-locked; dedicated text+table adapter still required.

### External open-web holdout

A separate sealed human-annotated set is required for real-world generalization. It must be collected and annotated independently of model tuning. The labels and evidence references must be hash-pinned before training or architecture changes are compared.

## Current Phase 2 exit gate

The phase is not complete until:
1. every required benchmark has a pinned dataset/version plus either a reproducible SHA-256, an authoritative published checksum, or an immutable source revision (for Git-hosted assets);
2. every benchmark has a runnable adapter;
3. each adapter produces the declared primary metrics;
4. the same TruthLens model configuration can be evaluated without hidden benchmark-specific tuning;
5. regression fixtures and benchmark artifacts are emitted with commit/config/dataset/model hashes;
6. an external open-web holdout is sealed or explicitly documented as the remaining gate.

The registry and preflight are fail-closed so an executable benchmark cannot run without pinned inputs.

## No SOTA claim

Phase 2 establishes measurement infrastructure. Any claim such as "best", "SOTA", or "world-leading accuracy" remains blocked until Phase 7 independently compares the measured results against current published/official results.


## Adapter implementation status

As of the current Phase 2 research branch:

| Benchmark | TruthLens adapter | Official scorer wrapper | Data/hash pin | Phase status |
|---|---|---|---|---|
| SciFact | Yes — existing full-corpus evaluator | Native benchmark evaluator | Yes | Baseline verified |
| FEVER | Yes — open-retrieval candidate preparation + TruthLens evaluator | Yes | **Zenodo v1 + published MD5 pinned; local SHA-256 materialization still required for the full run** | In progress |
| AVeriTeC | Protocol/prediction adapter | Yes — repo commit + Git blob IDs pinned; local SHA-256 materialization still required | Yes — upstream `eval.py` | In progress |
| FEVEROUS | Official evaluator adapter | Yes — upstream `evaluate.py` | **Zenodo v1 + published MD5 pinned; structured TruthLens prediction adapter remains** | In progress |
| External open-web | Not yet a scored TruthLens benchmark | N/A | **Sealed independent holdout still required** | Remaining gate |

The FEVER adapter uses an open-retrieval FTS5 index over the official Wikipedia shard corpus. Gold evidence is never injected into the candidate pool. Its output is intentionally compatible with the official FEVER scorer, which defines strict evidence-aware scoring in addition to label accuracy and evidence precision/recall/F1. citeturn449019search0

AVeriTeC's official evaluator is invoked from the upstream `eval.py`; its reference format includes claims, labels, question-answer evidence, dates and source URLs. The adapter does not reuse gold source URLs as retrieval candidates; end-to-end open-web retrieval remains a separate integration gate. citeturn151523view0

FEVEROUS requires a separate structured-evidence representation because its benchmark evaluates text and table-cell evidence. Its official repository documents local evaluation via `evaluate.py` and the required prediction fields. citeturn880879search1
