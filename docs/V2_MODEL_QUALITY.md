# TruthLens V2 — Model Quality Upgrade

## Research model paths

The V2 research stack provides deterministic offline adapters plus sealed local pretrained inference.

### NLI

The research NLI path can use:

- Local sealed model: `Xenova/nli-deberta-v3-xsmall`, q8@3fac2500.
- Optional hosted path: Hugging Face Inference Providers with `facebook/bart-large-mnli`.

The local sealed path is the authoritative pretrained component evaluation path because it is reproducible and does not require a hosted model token.

### Embeddings

The research dense-retrieval path can use:

- Local sealed model: `Xenova/all-MiniLM-L6-v2`, q8@afdb6f1a.
- Deterministic hashing-ngram embeddings for offline CI.
- Optional hosted Hugging Face feature extraction.

## Completed component evaluation

Latest completed sealed local evaluation: workflow **#162**, evaluating 300 frozen SciFact dev claims / 5,183 documents.

| Metric | Heuristic | Local pretrained |
|---|---:|---:|
| NLI accuracy | 0.307036 | **0.524520** |
| NLI macro-F1 | 0.205958 | **0.536936** |
| NLI ECE-10 | 0.141591 | 0.309079 |
| Mean embedding margin | 0.039649 | **0.551816** |
| Positive embedding-margin rate | 0.654255 | **1.000000** |

The pretrained models improve the measured component classification/separation quality, but ECE is worse. No production confidence recalibration is inferred from this result.

## Conflict reasoning

The decision policy requires independent material evidence on both sides before returning `CONFLICTED`. It records the conflict basis in provenance and remains deterministic.

## Calibration

The research evaluation reports:

- raw ECE;
- Brier score;
- held-out temperature-scaling diagnostics.

Runtime production confidence is not silently recalibrated from the same development set.

## Test commands

```bash
npm run test:v2-quality
npm run test:all-with-v2
npm run eval:v2
```

## Production safety

The model-quality upgrade is research-only. It does not change production thresholds, source policy, abstention behavior, or production model artifacts.
