# TruthLens V2 Reproducibility Protocol

## Frozen research inputs

Gate-14 final research head: `a6563c17e6897c91a1fd8a8c483df2ff5e07c824`

Production merge commit: `b1ac8df667b6a28d7e57d3c54dd25d1e9c90aace`

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

## Final Gate-14 benchmark record (2026-10-01)

All seven Gate-14 workflows completed successfully for final research head `a6563c17e6897c91a1fd8a8c483df2ff5e07c824`. The SciFact artifact is workflow run `36751159351` with digest `sha256:7349a2c45115f59efdfc88f30856f81f9b5a24acc7a2f698952eaf3116c6f351`. The Phase 7 ISOT artifact is run `36751159434` with digest `sha256:4ba8b6662f1f60c49bff42947341765dc84bb040a69f04aacdb63c3e8d106786`. The phase-2 data-validation artifact is run `36751159406` with digest `sha256:3e5f40faa838678f5b91c51c4f53b34919be44f0b3d0f639e98b0ab7fcc5f84a`. The model-quality artifact is run `36751159391` with digest `sha256:241842a5bf5833564ad7e917a12bee9fe8bb036e0b92955522b6fe6de141fd64`. The research-intelligence artifact is run `36751159663` with digest `sha256:77ef7ff31d5bf955e2392531df767a33f5ea1e3d3bd2d523d197c07f3ec2f622`.

These artifacts are research evidence and do not modify production model weights or runtime policy.
