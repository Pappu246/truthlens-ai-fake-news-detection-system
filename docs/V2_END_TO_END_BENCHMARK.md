# TruthLens V2 — End-to-End SciFact Benchmark

**Status:** Research/evaluation only. Production remains frozen.

## Purpose

This benchmark measures the actual evidence-grounded V2 research pipeline on the full SciFact development corpus:

`claim -> query expansion -> open BM25/dense retrieval -> reranking -> pretrained NLI -> research decision`

It is deliberately separate from the production policy because classic SciFact commonly supplies one cited evidence paper, while TruthLens production requires two independent directional sources.

## Frozen inputs

- **300** SciFact development claims
- **5,183** corpus documents
- Claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- Corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`

## Current pipeline

1. Index the full corpus with BM25 once per run.
2. Build the claim with the shared production claim extractor.
3. Preserve all useful extractor search-query variants.
4. Add deterministic support-oriented and contradiction-oriented variants.
5. Retrieve from both BM25 and full-corpus dense embeddings.
6. Fuse candidates and rerank using relevance, semantic similarity, source quality, freshness, independence, and other existing V2 signals.
7. Run sealed pretrained NLI over the final evidence set.
8. Aggregate SUPPORT/CONTRADICT evidence into the research benchmark view.
9. Record the unchanged production-policy decision separately, including abstention and conflict behavior.
10. Persist provenance and machine-readable results.

### Current research configuration

- Candidate K: **100**
- Dense retrieval K: **300**
- Final evidence K: **8**
- NLI: `Xenova/nli-deberta-v3-xsmall`, `q8@3fac2500`
- Embedding: `Xenova/all-MiniLM-L6-v2`, `q8@afdb6f1a`

The dense index is built once per process and reused across claims. Pretrained-NLI relatedness embeddings are batched to reduce worker round-trips without changing the inference contract.

## Latest completed benchmark

The latest completed authoritative full-corpus run is **Run #19** (`36512277229`), evaluated on commit `f40440d8caf58126f215fce2aa1e7c843934538b`.

- Open candidate recall: **53.67%**
- Gold evidence Recall@5: **68.09%**
- Directional accuracy: **37.00%**
- Directional macro-F1: **0.341899**

Production-policy diagnostics for the same run:

- Mapped accuracy: **37.33%**
- Mapped macro-F1: **0.181230**
- Abstention: **100%**
- Non-abstain coverage: **0%**
- CONFLICTED: **0.33%**

These numbers are a reproducible research baseline, not a production-accuracy claim.

## Research-integrity guardrails

- Gold evidence is never injected into the open candidate pool.
- Dataset hashes are verified before evaluation.
- Local model byte seals are verified before evaluation.
- Synthetic fixture results are not mixed into the external benchmark.
- Production thresholds, source rules, abstention requirements, and model artifacts are unchanged.
- Canceled/incomplete runs are never recorded as benchmark results.

## Current-head evaluation status

After Run #19, the branch added retrieval/query-diversity, source-independence, NLI batching, and calibration-diagnostic improvements. Fresh 300-claim current-head reruns were attempted but GitHub Actions canceled them before artifacts were produced. Therefore the branch intentionally does **not** publish a new current-head accuracy number yet.

A completed current-head artifact must be compared against Run #19 on the same frozen inputs before any research conclusion or production proposal is made.
