# TruthLens V2 — SciFact End-to-End Benchmark Results

**Status:** Research/evaluation only. Production unchanged.

## Latest completed authoritative result

The latest **completed** full-corpus SciFact benchmark remains Run #19. Newer current-head reruns were attempted after the V2 retrieval/query/NLI engineering upgrades, but the GitHub Actions job was cancelled before an artifact was produced. Those canceled attempts are not treated as benchmark results.

### Run identity

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

## Models

- NLI: `Xenova/nli-deberta-v3-xsmall`, `q8@3fac2500`
- Embedding: `Xenova/all-MiniLM-L6-v2`, `q8@afdb6f1a`

## End-to-end metrics

| Metric | Result |
|---|---:|
| Open candidate recall | **53.67%** |
| Gold evidence Recall@5 | **68.09%** |
| Directional accuracy | **37.00%** |
| Directional macro-F1 | **0.341899** |

### Directional per-class results

| Class | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| SUPPORT | 1.000000 | 0.096774 | 0.176471 | 124 |
| CONTRADICT | 0.267516 | 0.656250 | 0.380090 | 64 |
| NOT_ENOUGH_INFO | 0.435115 | 0.508929 | 0.469136 | 112 |

## Production-policy view

SciFact uses a one-gold-paper evidence convention while TruthLens production requires two independent directional sources. The production-policy view is therefore reported separately.

| Metric | Result |
|---|---:|
| Mapped accuracy | 37.33% |
| Mapped macro-F1 | 0.181230 |
| Abstention rate | 100% |
| Non-abstain coverage | 0% |
| Non-abstain accuracy | 0% |
| CONFLICTED rate | 0.33% |

The 100% abstention rate is a direct consequence of the dataset/policy mismatch and is not a model-quality score.

## Current-head research changes not yet assigned a score

Since Run #19, the research branch has added and regression-tested:

- full-corpus dense retrieval with explicit K=300;
- preservation of all diversified extractor queries plus deterministic support/contradiction variants;
- synthetic benchmark source-independence handling for `.local/document/<id>`;
- batched pretrained-NLI relatedness embeddings;
- external calibration diagnostics;
- stronger CI/dependency and workflow controls.

Current-head full 300-claim reruns were launched, but the GitHub Actions jobs were cancelled before artifacts were produced. No new metric is inferred from partial or canceled runs.

## Research safety

- PR #26 remains **open and not merged**.
- Production `main` remains at `32db8230547658b7d5d2a615599526d88c22fce9`.
- No production thresholds, source rules, abstention policy, or model artifact were changed.
- No ISOT, LIAR, or SciFact metrics are combined.

## Interpretation

Run #19 remains a reproducible external baseline, not a production-accuracy estimate and not evidence of world-leading performance. Retrieval remains the main disclosed bottleneck. A current-head score must only be published after a complete 300-claim run produces the machine-readable artifact.
