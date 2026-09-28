# TruthLens V2 — SciFact End-to-End Benchmark Results

**Status:** Completed research benchmark; production unchanged.

## Run identity

- Workflow: **V2 SciFact End-to-End Benchmark**
- Latest authoritative run: **#16**
- Run ID: `36473822898`
- Branch: `research/truthlens-v2-model-quality`
- Evaluated commit: `4af36a73506ddbe33e78f6505af73a7938810907`
- Artifact: `truthlens-v2-scifact-end-to-end`
- Artifact ID: `10998862059`
- Artifact SHA-256: `6146fa5258fab79610e341fab5a6bdc74d6ecc3c3c9ed1632b3a2fa0061cf0de`
- Generated: **2026-09-28T21:23:56.362Z**

## Frozen evaluation inputs

- Dataset: **SciFact dev**
- Claims evaluated: **300**
- Corpus documents: **5,183**
- Claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- Corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`
- Candidate pool (K): **100**
- Final pipeline (K): **8**

## Models

- NLI: `Xenova/nli-deberta-v3-xsmall`, `q8@3fac2500`
- Embedding: `Xenova/all-MiniLM-L6-v2`, `q8@afdb6f1a`

## End-to-end metrics

| Metric | Exact result |
|---|---:|
| Open candidate recall | 0.5366666666666666 |
| Gold evidence Recall@5 | 0.6808510638297872 |
| Directional accuracy | 0.3700000000000000 |
| Directional macro-F1 | 0.3418989628139955 |

### Directional per-class results

| Class | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| SUPPORT | 1.000000 | 0.096774 | 0.176471 | 124 |
| CONTRADICT | 0.267516 | 0.656250 | 0.380090 | 64 |
| NOT_ENOUGH_INFO | 0.435115 | 0.508929 | 0.469136 | 112 |

## Production-policy view

SciFact uses a one-gold-paper evidence convention, while TruthLens production requires two independent sources for a directional verdict. The benchmark therefore reports a separate production-policy view instead of weakening production policy to fit the dataset.

| Metric | Exact result |
|---|---:|
| Mapped accuracy | 0.37333333333333335 |
| Mapped macro-F1 | 0.1812297734627832 |
| Abstention rate | 1.0 |
| Non-abstain coverage | 0 |
| Non-abstain accuracy | 0 |
| Conflicted rate | 0.0033333333333333335 |

The 100% abstention rate is expected under the unchanged production-source policy and should not be interpreted as a model-quality score.

## Interpretation

Run #16 reproduces the same measured end-to-end result as the previous authoritative SciFact run, confirming deterministic behavior on the frozen inputs and sealed model artifacts. Retrieval remains the dominant disclosed bottleneck: open candidate recall is **53.67%** and gold-evidence Recall@5 is **68.09%**. Directional performance remains **37.0% accuracy** and **0.3419 macro-F1**.

The benchmark is a reproducible external measurement, **not** evidence of world-leading performance and **not** a production-accuracy estimate. The result does not justify production promotion.

## Research safety

- PR #26 is **open and not merged**.
- Production `main` was **not modified** by this benchmark.
- No research deployment was performed.
- Production thresholds, source requirements, abstention rules, and production model artifacts were not changed.
- No benchmark number has been combined with production ISOT/LIAR metrics.

## Reproduction

The workflow freezes the SciFact inputs by SHA-256, verifies counts, installs the local pretrained runtime, verifies the sealed research models, runs the complete benchmark, and uploads the JSON/log artifact. The artifact above is the authoritative result for Run #16.
