# TruthLens V2 — End-to-End SciFact Benchmark

**Status:** research/evaluation only. Production remains frozen.

**Execution note:** the benchmark uses one shared BM25 index per full-corpus run and batched local embedding inference to keep the complete 300-claim evaluation tractable on CPU.

## What this benchmark measures

This is the first external end-to-end measurement of the actual V2 research pipeline on a non-synthetic corpus:

`claim -> open-corpus retrieval -> hybrid retrieval -> reranking -> pretrained NLI -> benchmark decision`

The benchmark uses the complete SciFact development corpus rather than the earlier hand-built fixture set or a gold-only evidence slice.

### Frozen inputs

- 300 SciFact development claims.
- 5,183 scientific abstracts in the full SciFact corpus.
- Claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- Corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`

The dataset schema and open/full-pipeline evaluation are documented by the original SciFact project:
https://github.com/allenai/scifact

## Method

1. The benchmark source indexes the **entire 5,183-document corpus** with BM25 once and reuses that index across all claims.
2. For each claim, the normal V2 query expansion runs.
3. The source returns the top 100 open-retrieval candidates for each expanded query.
4. The unchanged V2 pipeline then runs its normal hybrid BM25+dense retrieval, reranking and NLI layers over that candidate pool.
5. The pretrained local NLI model is the sealed `Xenova/nli-deberta-v3-xsmall` q8 model and the embedding model is the sealed `Xenova/all-MiniLM-L6-v2` q8 model.
6. The benchmark direction is SUPPORT / CONTRADICT / NOT_ENOUGH_INFO. It uses the weighted NLI votes produced by the pipeline so that the benchmark has a single-source-compatible decision surface.
7. The normal production decision is also recorded separately and mapped to the SciFact label space. This exposes, rather than hides, the mismatch between classic SciFact's cited-paper evidence structure and TruthLens' production requirement for multiple independent sources.

## Metrics

### End-to-end benchmark metrics

- **Open candidate recall:** fraction of claims where any gold evidence paper appears in the open candidate pool.
- **Gold evidence Recall@5:** fraction of claims with gold evidence where a gold evidence paper appears in the pipeline's top-5 reranked evidence.
- **Directional accuracy / macro-F1:** SUPPORT / CONTRADICT / NOT_ENOUGH_INFO at the benchmark decision surface.

### Production-policy view

Reported separately:

- mapped accuracy and macro-F1;
- abstention rate;
- CONFLICTED rate;
- non-abstention coverage;
- accuracy conditional on non-abstention.

These numbers are diagnostic only and must not be presented as standard SciFact task results because the production policy intentionally requires independent corroboration.

## Research-integrity guardrails

- The full corpus is searched; gold documents are **not** injected into the candidate pool.
- Dataset hashes are verified before evaluation.
- Local model byte seals are verified before evaluation.
- Results are written as a machine-readable artifact.
- No production thresholds, source policy, abstention rule or production model are changed.
- No synthetic fixture numbers are mixed into this benchmark.
- The benchmark does **not** establish world-leading performance by itself; it establishes a reproducible external end-to-end baseline for TruthLens V2.
