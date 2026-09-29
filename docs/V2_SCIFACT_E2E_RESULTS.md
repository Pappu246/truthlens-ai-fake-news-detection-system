# TruthLens V2 — SciFact End-to-End Benchmark Results

**Status:** Research/evaluation only. Production unchanged.

## Latest completed authoritative result

The latest **completed** full-corpus SciFact benchmark remains Run #19. It remains the baseline until a current-head run produces a complete machine-readable artifact.

### Run #19 identity

- Workflow: **V2 SciFact End-to-End Benchmark**
- Run: **#19**
- Run ID: `36512277229`
- Branch: `research/truthlens-v2-model-quality`
- Evaluated commit: `f40440d8caf58126f215fce2aa1e7c843934538b`
- Artifact: `truthlens-v2-scifact-end-to-end`
- Artifact ID: `11012755708`
- Artifact SHA-256: `29322f9630fd693b658bf3c108b2621c487d1d8c3ee178b90f6090cbd1a3d38c`

## Frozen inputs

- Dataset: **SciFact dev**
- Claims: **300**
- Corpus documents: **5,183**
- Claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- Corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`
- Candidate pool K: **100**
- Final pipeline evidence K: **8**

## Baseline metrics

| Metric | Result |
|---|---:|
| Open candidate recall | **53.67%** |
| Gold evidence Recall@5 | **68.09%** |
| Directional accuracy | **37.00%** |
| Directional macro-F1 | **0.341899** |

## Current-head run

**Run #91** is the current-head full-corpus validation on commit `4c0581e199f86c278d7b8ce08d3639adeba41c2f`.

Setup, dataset hashes/counts, dependency installation, local pretrained runtime installation, and sealed-model verification have passed. The benchmark execution step is still running, and **no artifact or new score exists yet**.

An older run #90 on commit `ba7631ebf4e3f1d6917d8fd04ab167ad50130b2f` is also still marked in progress. Neither is treated as evidence.

## Current-head changes under test

Since the baseline, the branch has added and regression-tested:

- full-corpus dense retrieval with explicit K=300;
- preservation of diversified extractor queries plus deterministic support/contradiction variants;
- synthetic benchmark source-independence handling for `.local/document/<id>`;
- batched pretrained-NLI relatedness embeddings;
- calibration diagnostics;
- stronger CI/dependency and long-running-workflow controls.

## Research safety

- PR #26 remains **open and not merged**.
- Production `main` remains `32db8230547658b7d5d2a615599526d88c22fce9`.
- The research branch contains an additive experimental V2 route in `server/appFactory.ts`; production `main` does not contain it.
- No production thresholds, source rules, abstention policy, or model artifact were changed.
- No ISOT, LIAR, or SciFact metrics are combined.

## Interpretation

Run #19 remains a reproducible research baseline, not a production-accuracy estimate and not evidence of world-leading performance. A current-head SciFact claim is valid only after a complete 300-claim artifact is produced and independently checked.
