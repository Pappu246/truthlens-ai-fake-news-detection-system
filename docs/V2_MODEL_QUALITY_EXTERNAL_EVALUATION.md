# TruthLens V2 — External Model-Quality Evaluation Protocol

**Status:** Research/evaluation only. Production remains frozen.

## Objective

Measure pretrained component quality independently from the final TruthLens decision policy.

## Frozen SciFact inputs

- 300 claims
- 5,183 corpus documents
- Claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- Corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`

## Current sealed local evaluation

Latest completed sealed local evaluation: **workflow run #162**, head `6e052a3c944002c80f89654ca4c0043c5630ed16`.

Models:

- NLI: `Xenova/nli-deberta-v3-xsmall`, q8@3fac2500
- Embeddings: `Xenova/all-MiniLM-L6-v2`, q8@afdb6f1a

The completed artifact evaluated all 300 claims and 469 evaluator-compatible NLI passages.

| Component | Heuristic | Local pretrained | Delta |
|---|---:|---:|---:|
| NLI accuracy | 0.307036 | **0.524520** | +0.217484 |
| NLI macro-F1 | 0.205958 | **0.536936** | +0.330978 |
| NLI ECE-10 | 0.141591 | 0.309079 | +0.167488 |
| Mean embedding margin | 0.039649 | **0.551816** | +0.512167 |
| Positive embedding-margin rate | 0.654255 | **1.000000** | +0.345745 |

Interpretation: pretrained NLI materially improves component classification quality, but calibration is worse in this evaluation. These are component metrics only and do not establish final TruthLens verdict accuracy.

## Hosted Hugging Face path

The optional hosted adapter remains a separate path using Hugging Face Inference Providers. It is not required for the sealed local evaluation and must not be conflated with it.

## Token-free harness

The workflow includes a token-free smoke test that validates the evaluator contracts and frozen inputs. A green smoke test is not a pretrained-model quality result.

## Production safety

The model-quality evaluation does not change production thresholds, source policy, abstention policy, or production model artifacts. No research result authorizes production migration by itself.
