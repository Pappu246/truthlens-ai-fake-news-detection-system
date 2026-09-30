# TruthLens V3 Research Master Plan

**Purpose:** establish one sequential research program for TruthLens after the verified V2 production merge. This file is the sequencing contract for future work.

## Non-negotiable operating rules

1. **No phase hopping.** Work proceeds Phase 0 → Phase 1 → Phase 2 … in order.
2. **No production-first experimentation.** Research changes are made on a research branch and evaluated before production promotion.
3. **No metric mixing.** Article, claim, evidence, retrieval, reasoning, calibration, and external-benchmark metrics remain explicitly separated.
4. **No benchmark laundering.** A benchmark score is never presented as universal real-world accuracy.
5. **No blind auto-promotion.** Candidate models may be discovered and benchmarked automatically, but production promotion requires passing all declared gates.
6. **Every completed phase leaves an auditable artifact:** commit SHA, configuration, dataset/model hashes, metrics, limitations, and pass/fail exit gate.
7. **Later work may not reopen completed work unless a new regression or external evidence requires it.**

## Phase map

| Phase | Scope | Status | Exit gate |
|---|---|---|---|
| 0 | State lock, release synchronization, reproducibility contract | **COMPLETE** | Production state and handoff synchronized |
| 1 | Continuous research intelligence: papers, models, benchmark-source watch | **COMPLETE** | Scheduled watcher produces versioned evidence artifacts without modifying production |
| 2 | Multi-benchmark apples-to-apples evaluation harness | **IN PROGRESS** | Frozen protocols for FEVER, SciFact, AVeriTeC, FEVEROUS and an external/open-web set |
| 3 | Retrieval-quality upgrade | PLANNED | Demonstrated improvement in evidence recall/retrieval metrics without regression guards |
| 4 | Verification reasoning upgrade | PLANNED | Better evidence-to-verdict reasoning on held-out data with calibrated abstention |
| 5 | Reliability and adversarial robustness | PLANNED | Calibration, temporal integrity, source independence, prompt-injection and adversarial gates green |
| 6 | Out-of-domain / multilingual / temporal generalization | PLANNED | Unseen-domain evaluation with no production-boundary violation |
| 7 | Independent SOTA audit | PLANNED | Apples-to-apples comparison against current published/official results |
| 8 | Controlled continuous promotion | PLANNED | Shadow → canary → rollback workflow and automatic regression protection |

## Current evidence baseline

The V2 production merge is verified, but its research metrics remain benchmark-specific.

Current runtime-equivalent SciFact evidence:
- open candidate recall: 60.33%;
- gold evidence Recall@5: 73.40%;
- directional accuracy: 34.33%;
- directional macro-F1: 0.320335;
- production-policy abstention: 75%.

These numbers establish a baseline for Phase 2 onward; they do not establish a universal truth-detection accuracy.

## Phase 1 — Continuous research intelligence

Phase 1 deliberately separates **discovery** from **promotion**.

The watcher may automatically collect:
- recent fact-verification / misinformation / evidence-retrieval papers;
- relevant model candidates from public model registries;
- reachability/change signals for declared benchmark sources;
- machine-readable timestamps and provenance for every observation.

The watcher must **not**:
- alter production code;
- replace a model;
- claim a new SOTA result from a paper abstract;
- merge or deploy anything;
- treat an unofficial leaderboard scrape as authoritative.

### Phase 1 exit gate

A scheduled GitHub Actions workflow must run successfully and publish a research-intelligence artifact containing:
- scan date;
- source URLs;
- query terms;
- retrieved candidate titles/IDs;
- model identifiers;
- benchmark-source status;
- explicit disclaimer that discovery is not evaluation.

## Phase 2 — Benchmark expansion

Only after Phase 1 is green:
- freeze benchmark versions and splits;
- implement one reproducible runner;
- record exact dataset/model/input hashes;
- prevent leakage across train/validation/test;
- report retrieval and reasoning separately;
- add confidence intervals where sample size permits.

No SOTA claim is allowed until Phase 7.

## Phase 3 — Retrieval quality

Investigate in this order:
1. query generation/expansion;
2. lexical + dense candidate generation;
3. cross-encoder/reranker;
4. hard-negative mining;
5. source independence/syndication handling;
6. temporal filtering.

Every change must show a before/after ablation and a regression report.

## Phase 4 — Verification reasoning

Investigate:
1. evidence-to-claim relation classification;
2. claim decomposition;
3. multi-hop evidence;
4. stronger NLI / verifier models;
5. calibrated aggregation;
6. abstention policy.

A higher accuracy score is insufficient if calibration or evidence provenance materially worsens.

## Phase 5 — Reliability and adversarial robustness

Required families:
- prompt injection in retrieved content;
- malicious/SSRF evidence;
- temporal contradictions;
- duplicated/syndicated sources;
- misleading snippets;
- adversarial paraphrases;
- calibration drift;
- selective prediction / abstention.

## Phase 6 — Generalization

Evaluate on unseen distributions:
- new time periods;
- new publishers/domains;
- non-English or multilingual claims where supported;
- fresh open-web claims;
- synthetic perturbation suites used only as diagnostics, not as substitutes for external evaluation.

## Phase 7 — Independent SOTA audit

Only here can the project consider a state-of-the-art/world-leading accuracy claim.

Required:
- same benchmark and split;
- same metric;
- comparable evidence setting;
- no hidden tuning on the reported test set;
- documented evaluation date;
- official/published source for competing results;
- reproducible TruthLens artifact;
- limitations and uncertainty stated.

The claim must be narrow enough to match the evidence, e.g. “best reported score on benchmark X under protocol Y as of DATE,” rather than a universal statement.

## Phase 8 — Controlled continuous promotion

Only after all quality gates:
- discover candidate;
- evaluate in research;
- open PR;
- run full regression;
- stage;
- shadow/canary;
- verify production smoke;
- promote;
- retain rollback artifact.

**Automatic discovery/evaluation is allowed. Automatic production replacement is not allowed without passing the same quality gates.**

## Definition of “world-leading”

TruthLens earns a defensible world-leading/SOTA statement only when Phase 7 supplies current, reproducible, apples-to-apples evidence. Until then, the project should describe itself as research-grade / world-class in engineering scope without making an unsupported accuracy claim.

## Phase 2 live status - current branch

Implemented in the current Phase 2 branch:
- fail-closed benchmark registry and protocol preflight;
- benchmark run artifact schema and validator;
- pinned official scorer revisions for FEVER, AVeriTeC and FEVEROUS;
- reproducible asset materializer with published-checksum verification plus local SHA-256 manifests;
- FEVER open-retrieval candidate preparation and TruthLens evaluator;
- AVeriTeC end-to-end TruthLens live-web adapter with the production LIAR prior disabled for benchmark isolation;
- FEVEROUS structured page/sentence/table-cell/list candidate preparation and TruthLens evaluator;
- official scorer wrappers with persisted stdout/stderr artifacts;
- fail-closed Phase 2 coordinator;
- machine-enforced sequential phase gate.

Phase 2 remains IN PROGRESS until the benchmark execution gates are satisfied. The branch will not enter Phase 3 merely because adapters exist.

Remaining Phase 2 gates:
1. Run the declared full benchmark evaluations on pinned assets where the compute footprint is practical.
2. Verify every full run with dataset/model/configuration provenance artifacts.
3. Complete or explicitly freeze the independent external open-web holdout; until that is done it remains a stated generalization gate, not a hidden omission.
4. Resolve all CI/adapter-smoke failures and only then merge Phase 2.

The current phase state remains: Phase 2 = in_progress; Phase 3..8 = planned.
