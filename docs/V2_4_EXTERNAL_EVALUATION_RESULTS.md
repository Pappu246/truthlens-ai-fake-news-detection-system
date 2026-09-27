# TruthLens V2.4 — External Evaluation Results

## Status

This document records the frozen V2.4 external evaluation result. It is research/evaluation documentation only. Production `main` was not modified, merged, or deployed.

The authoritative frozen evaluation run completed successfully:

- GitHub Actions run: `36272621839`
- Branch: `assistant/v2.4-run-external-20260927`
- Evaluation commit: `5bd60c02f669d15d9838cfe9f298f1f52d879796`
- Evaluation artifact: `truthlens-v2.4-scifact-evaluation`
- Artifact ID: `10916861336`

The exact external-artifact preparation run also completed successfully:

- GitHub Actions run: `36272517438`
- Artifact: `truthlens-v2.4-exact-artifacts-corrected`
- Artifact ID: `10915663331`

The Arena environment later could not download the GitHub Actions Azure Blob artifacts because the artifact endpoint returned EOF. Arena therefore did not independently re-read the JSON/log artifact contents during its post-evaluation documentation pass. The result record below is the independently verified frozen evaluation record supplied from the completed run.

## Dataset and integrity

Dataset: SciFact development split.

- Claims: 300
- Corpus documents: 5,183
- Evaluator-compatible gold passages: 469
- Claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- Corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`

## Sealed models

Embedding model:

- `Xenova/all-MiniLM-L6-v2`
- Seal: `q8@afdb6f1a`
- Dimensions: 384

NLI model:

- `Xenova/nli-deberta-v3-xsmall`
- Seal: `q8@3fac2500`
- ONNX SHA-256: `3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6`

Runtime:

- `@huggingface/transformers@3.7.6`
- `onnxruntime-node@1.21.0`

Frozen configuration:

- Evaluation clock: `2026-09-26T00:00:00.000Z`
- Retrieval candidates per expanded query: 25
- Evidence K: 5
- High-confidence threshold: 0.75
- Decision thresholds/policy: unchanged
- External calibration prior: disabled

## Raw evidence presentation

### Final metrics

| Metric | Value |
|---|---:|
| Accuracy | 0.35333333333333333 |
| Macro-F1 | 0.2931670583844497 |
| NLI accuracy | 0.5245202558635395 |
| NLI Macro-F1 | 0.5369357498708881 |
| Evidence Recall@5 | 0.6648936170212766 |
| Evidence Precision@5 | 0.1351063829787234 |
| High-confidence precision | 0.32941176470588235 |
| High-confidence coverage | 0.2833333333333333 |
| Coverage | 0.3433333333333333 |
| Abstention | 0.6566666666666666 |
| Final ECE | 0.4282166666666666 |

### Final per-class metrics

| Class | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| VERIFIED | 1.0 | 0.016129032258064516 | 0.031746031746031744 | 124 |
| REFUTED | 0.27722772277227725 | 0.4375 | 0.3393939393939394 | 64 |
| INSUFFICIENT_EVIDENCE | 0.40641711229946526 | 0.6785714285714286 | 0.5083612040133779 | 112 |

### Passage-level NLI metrics

| Class | Precision | Recall | F1 |
|---|---:|---:|---:|
| SUPPORTS | 0.9411764705882353 | 0.2962962962962963 | 0.45070422535211263 |
| REFUTES | 0.6578947368421053 | 0.6147540983606558 | 0.6355932203389831 |
| NEUTRAL | 0.3862815884476534 | 0.816793893129771 | 0.5245098039215685 |

NLI ECE: `0.30907889125799587`

## Enriched evidence presentation

### Final metrics

| Metric | Value |
|---|---:|
| Accuracy | 0.4066666666666667 |
| Macro-F1 | 0.2171034262693949 |
| NLI accuracy | 0.5522388059701493 |
| NLI Macro-F1 | 0.41786275605847306 |
| Evidence Recall@5 | 0.6648936170212766 |
| Evidence Precision@5 | 0.1351063829787234 |
| High-confidence precision | 0.4084507042253521 |
| High-confidence coverage | 0.9466666666666667 |
| Coverage | 0.9566666666666667 |
| Abstention | 0.043333333333333335 |
| Final ECE | 0.5502133333333339 |

### Final per-class metrics

| Class | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| VERIFIED | 0.4076655052264808 | 0.9435483870967742 | 0.5693430656934306 | 124 |
| REFUTED | 0 | 0 | 0 | 64 |
| INSUFFICIENT_EVIDENCE | 0.5 | 0.044642857142857144 | 0.0819672131147541 | 112 |

### Passage-level NLI metrics

| Class | Precision | Recall | F1 |
|---|---:|---:|---:|
| SUPPORTS | 0.5342465753424658 | 0.9027777777777778 | 0.6712564543889845 |
| REFUTES | 0.6 | 0.02459016393442623 | 0.04724409448818897 |
| NEUTRAL | 0.6288659793814433 | 0.46564885496183206 | 0.5350877192982456 |

NLI ECE: `0.3102281449893393`

## Exact enriched-minus-raw deltas

| Metric | Delta |
|---|---:|
| Accuracy | +0.05333333333333333 |
| Macro-F1 | -0.0760636321150548 |
| NLI accuracy | +0.0277185501066098 |
| NLI Macro-F1 | -0.119072993812415 |
| Evidence Recall@5 | 0 |
| Evidence Precision@5 | 0 |
| High-confidence precision | +0.079038939518940 |
| High-confidence coverage | +0.6633333333333333 |
| Coverage | +0.6133333333333333 |
| Abstention | -0.6133333333333333 |
| Final ECE | +0.1219966666666667 |

## Directional behavior observed

The enriched presentation materially shifts the system toward positive/supporting decisions and away from refutation and uncertainty.

Final-verdict recall:

- REFUTED: 0.4375 → 0
- INSUFFICIENT_EVIDENCE: 0.6785714285714286 → 0.044642857142857144
- VERIFIED: 0.016129032258064516 → 0.9435483870967742

Passage-level NLI recall:

- REFUTES: 0.6147540983606558 → 0.02459016393442623
- SUPPORTS: 0.2962962962962963 → 0.9027777777777778
- NEUTRAL: 0.816793893129771 → 0.46564885496183206

## Research conclusion

The enriched presentation increases final accuracy, high-confidence precision, and overall coverage. However, it materially decreases Macro-F1 and NLI Macro-F1, worsens final calibration (ECE), and produces a severe directional imbalance in which REFUTED recall falls to zero and INSUFFICIENT_EVIDENCE recall becomes very low.

Therefore the enriched presentation remains **research-only** and is **not adopted as the production/default V2 evidence presentation**.

The raw presentation remains the frozen V2.4 research baseline.

## Limitations

1. SciFact evaluates scientific-abstract claim verification and is not a direct live-news benchmark.
2. The unchanged TruthLens decision policy requires two independent directional sources, while many SciFact directional claims have one gold paper; this creates a structural task/policy mismatch in final-verdict coverage.
3. The reserved `.test` document locators are synthetic provenance keys and are not real publisher URLs.
4. Neutral passage gold is based on cited papers with no annotated evidence; arbitrary retrieval negatives are not silently treated as neutral.
5. These results do not establish general internet fact-checking accuracy.

## Production safety

This evaluation and result record are research-only.

- Production `main` remains `32db8230547658b7d5d2a615599526d88c22fce9`.
- No production deployment was performed.
- No production thresholds or policies were changed.
- No production model was replaced.
- No merge was performed.
