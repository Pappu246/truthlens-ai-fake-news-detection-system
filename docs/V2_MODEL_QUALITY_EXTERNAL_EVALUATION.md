# TruthLens V2 — External Model-Quality Evaluation Protocol

**Status:** research/evaluation only. Production remains frozen.

## Objective

Measure the optional pretrained model adapters independently from the final TruthLens decision policy:

- NLI: deterministic heuristic fallback vs `facebook/bart-large-mnli` through Hugging Face Inference Providers.
- Embeddings: deterministic hashing n-gram model vs `BAAI/bge-small-en-v1.5` through Hugging Face Inference Providers.

## Dataset

The workflow uses the untouched SciFact development split:

- 300 claims
- 5,183 corpus documents
- Claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- Corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`

## NLI metric

Gold labels are taken only from:

- annotated SciFact rationales: SUPPORT / CONTRADICT;
- cited papers with no annotated evidence: NEUTRAL.

The evaluator reports accuracy, macro-F1, per-class metrics, ECE, and remote-minus-heuristic deltas.

## Embedding metric

For each claim that has gold directional evidence, the evaluator compares the maximum claim-to-gold-rationale cosine similarity against one deterministic non-gold negative document.

This is explicitly a **component diagnostic**, not exhaustive retrieval Recall@K.

## Why final-verdict accuracy is not used here

SciFact often provides one gold evidence paper, while the TruthLens V2 decision policy requires two independent directional sources. Scoring final verdicts would therefore mix model quality with the dataset/policy mismatch already documented by the V2 research protocol.

## Reproducibility

Command:

`npm run eval:v2-model-quality-external -- --data-dir=<exact scifact directory> --output=<result json>`

GitHub Actions workflow:

`.github/workflows/v2-model-quality-external.yml`

The workflow verifies the frozen dataset hashes before evaluation. Remote evaluation requires the repository secret `HF_TOKEN`. No token value is logged.

## Token-free harness validation

The GitHub Actions workflow also runs a token-free smoke test before the optional remote evaluation. It verifies the frozen SciFact hashes/counts, exercises the Hugging Face NLI and embedding adapter request/response contracts with mocked transport, and uploads a small smoke artifact. This confirms the evaluation harness itself is executable even when `HF_TOKEN` is unavailable. The smoke result is **not** a pretrained-model quality result and must not be reported as one.

## Production safety

This evaluation:

- does not change production thresholds;
- does not change source or abstention policy;
- does not replace the production model;
- does not merge or deploy research code;
- does not silently convert remote model failures into fallback results.
