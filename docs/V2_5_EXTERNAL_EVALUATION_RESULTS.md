# TruthLens V2.5 — Frozen External Evaluation Results

**Status:** research-only; **not accepted for production**.

## Evaluation provenance

- Workflow: `V2.5 Contradiction-Aware External Evaluation`
- GitHub Actions run: `36308430718`
- Branch: `assistant/v2.5-contradiction-aware`
- Evaluation commit: `928447e06be028331e043799fecc8199355ef835`
- Artifact: `truthlens-v2.5-contradiction-aware-evaluation`
- Artifact ID: `10929361238`
- Artifact SHA-256: `3e44bef36db6ba192e204c47995deb703157c9d20b7a3748ce06634ce8e40d54`

The run completed successfully. The workflow downloaded the frozen SciFact/model assets, verified the pinned SHA-256 values and expected counts, imported the exact bundle, validated the sealed model stack, ran the 39-assertion V2.5 adjudicator suite, evaluated the unchanged raw baseline, evaluated the contradiction-aware adapter, and generated the delta/error-analysis artifact.

## Frozen evaluation inputs

- Dataset: SciFact development split
- Claims: 300
- Corpus documents: 5,183
- Evaluator-compatible gold passages: 469
- Embedding model: `Xenova/all-MiniLM-L6-v2`
- NLI model: `Xenova/nli-deberta-v3-xsmall`
- NLI ONNX SHA-256: `3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6`
- Raw evidence presentation for both sides
- Existing V2 decision policy and abstention policy unchanged

## Final metrics

| Metric | Frozen raw baseline | V2.5 contradiction-aware | Delta |
|---|---:|---:|---:|
| Accuracy | 0.353333 | 0.373333 | +0.020000 |
| Macro-F1 | 0.293167 | 0.290932 | -0.002235 |
| NLI accuracy | 0.524520 | 0.511727 | -0.012793 |
| NLI Macro-F1 | 0.536936 | 0.514363 | -0.022572 |
| Evidence Recall@5 | 0.664894 | 0.664894 | 0 |
| Evidence Precision@5 | 0.135106 | 0.135106 | 0 |
| High-confidence precision | 0.329412 | 0.333333 | +0.003922 |
| High-confidence coverage | 0.283333 | 0.220000 | -0.063333 |
| Coverage | 0.343333 | 0.223333 | -0.120000 |
| Abstention | 0.656667 | 0.776667 | +0.120000 |
| ECE | 0.428217 | 0.391140 | -0.037077 |

## Final-verdict recall

| Verdict | Raw | V2.5 | Delta |
|---|---:|---:|---:|
| VERIFIED | 0.016129 | 0.016129 | 0 |
| REFUTED | 0.437500 | 0.312500 | -0.125000 |
| INSUFFICIENT_EVIDENCE | 0.678571 | 0.803571 | +0.125000 |

## Passage-level NLI recall

| Label | Raw | V2.5 | Delta |
|---|---:|---:|---:|
| SUPPORTS | 0.296296 | 0.231481 | -0.064815 |
| REFUTES | 0.614754 | 0.565574 | -0.049180 |
| NEUTRAL | 0.816794 | 0.923664 | +0.106870 |

## Transition/error analysis

The generated comparison found 43 claims whose final verdict and/or NLI label changed.

Final-verdict transition/error counters emitted by the frozen workflow:

- recovered_missed_contradiction: 0
- preserved_neutrality: 187
- false_contradiction: 1
- support_converted_to_contradiction: 0
- neutral_converted_to_contradiction: 0
- improved_abstention: 2
- unwanted_overconfidence: 1

The dominant observed effect was movement away from directional REFUTED decisions toward INSUFFICIENT_EVIDENCE. This is reflected in REFUTED recall decreasing by 0.125 while abstention increased by 0.12.

## Research disposition

V2.5 is **not accepted for production** from this evaluation.

Reasons recorded from the frozen measurements:

1. The experiment recovered **0** missed contradictions under the workflow's explicit recovery counter.
2. REFUTED recall decreased from 0.4375 to 0.3125.
3. Passage-level REFUTES recall decreased from 0.614754 to 0.565574.
4. Overall coverage decreased from 0.343333 to 0.223333 while abstention increased from 0.656667 to 0.776667.
5. NLI accuracy and NLI Macro-F1 also decreased.
6. Accuracy increased by 0.02 and ECE decreased by 0.037077, but those changes did not establish the intended contradiction-recognition improvement.

Therefore the contradiction-aware adjudicator remains an isolated research experiment. No production thresholds, source policy, abstention policy, or production model are changed.

## Production boundary

Production `main` remains:

`32db8230547658b7d5d2a615599526d88c22fce9`

No production merge or deployment is part of this result.

## Next research step

The next useful research work is error-directed investigation of the contradiction-aware formulation rather than promotion. Any new variant should be evaluated against the same frozen SciFact bundle and sealed model artifacts, with the same raw V2 baseline and without changing production behavior.
