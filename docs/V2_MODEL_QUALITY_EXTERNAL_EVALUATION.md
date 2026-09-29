# TruthLens V2 — External Model-Quality Evaluation Protocol

**Status:** Research/evaluation only. Production remains frozen.

## Objective

Measure pretrained component quality independently from the final TruthLens decision policy.

## Frozen SciFact inputs

- Claims: 300
- Corpus documents: 5,183
- Claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- Corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`

## Latest completed sealed local evaluation

Workflow run **#195 — SUCCESS**  
Head: `4c0581e199f86c278d7b8ce08d3639adeba41c2f`

Models:

- NLI: `Xenova/nli-deberta-v3-xsmall`, q8@3fac2500
- Embeddings: `Xenova/all-MiniLM-L6-v2`, q8@afdb6f1a

The artifact evaluated all 300 claims and 469 evaluator-compatible NLI passages.

| Component | Heuristic | Local pretrained | Delta |
|---|---:|---:|---:|
| NLI accuracy | 0.307036 | **0.524520** | +0.217484 |
| NLI macro-F1 | 0.205958 | **0.536936** | +0.330978 |
| NLI ECE-10 | 0.141591 | 0.309079 | +0.167488 |
| Mean embedding margin | 0.039649 | **0.551816** | +0.512167 |
| Positive embedding-margin rate | 0.654255 | **1.000000** | +0.345745 |

Interpretation: the pretrained NLI improves component classification quality on this frozen evaluation, while calibration is worse than the heuristic comparator. These are component metrics only and do not establish final TruthLens verdict accuracy.

## Hosted Hugging Face path

The optional hosted adapter remains separate. In the current run, the sealed local pretrained evaluation succeeded; the hosted HF comparison is not required for that local result and should not be conflated with it.

## Security note

The main CI audit reports **0 vulnerabilities** for the committed project dependencies. The model-quality workflow installs `@huggingface/transformers` and `onnxruntime-node` as temporary `--no-save` evaluation dependencies; that temporary install emitted two high-severity audit findings on the runner and did not modify `package.json` or the lockfile. Those evaluation-only findings are not production dependency findings.

## Production safety

The model-quality evaluation does not change production thresholds, source policy, abstention policy, or production model artifacts. No research result authorizes production migration by itself.
