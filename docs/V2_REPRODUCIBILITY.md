# TruthLens V2 Reproducibility Protocol

## Frozen research inputs

Current corrected research head: `067cc9ddb2630e3a31a3feefde1f4c6d2a0d252f`

Production baseline: `32db8230547658b7d5d2a615599526d88c22fce9`

SciFact input release:
- claims_dev.jsonl
- corpus.jsonl
- claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`
- expected counts: 300 claims, 5,183 documents

## Research stack

- Node.js 22
- project dependencies pinned by package-lock.json
- local pretrained runtime uses the sealed model-download workflow
- retrieval candidate K=100
- dense retrieval K=300
- final evidence K=8

## Verification gates

A research result is considered reproducible only when:
1. frozen inputs hash-match;
2. model artifacts pass integrity verification;
3. the exact research commit is recorded;
4. benchmark logs and result artifacts are retained;
5. CI and benchmark workflow outcomes are recorded;
6. production and research boundaries are preserved.

## Evidence integrity

Every benchmark result should record:
- commit SHA
- workflow run number
- dataset hashes
- row/document counts
- configuration
- output artifact name
- artifact hash when available
- failure/abstention semantics

## Rerun policy

Do not replace a failed run's result with an undocumented rerun. Preserve the run history and explicitly identify the run that produced the published metric.

## Interpretation

A benchmark is evidence about a defined dataset and protocol. It is not proof of generalization to arbitrary live information environments.
