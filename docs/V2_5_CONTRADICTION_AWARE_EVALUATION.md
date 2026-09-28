# TruthLens V2.5 — Contradiction-Aware Evidence Adjudication

**Status:** research-only; **external evaluation complete; not accepted for production**.

## Purpose

V2.5 tests whether an explicit false-claim NLI hypothesis can improve contradiction recognition without changing the existing V2 decision policy, source policy, abstention policy, or production model.

## Research implementation

- `server/v2_5/contradictionAwareAdjudicator.ts`
- `scripts/v2_5AdjudicatorTests.ts`
- `npm run test:v2_5`

The adjudicator performs exactly two NLI passes for each evidence passage:

1. Pass A uses the original claim.
2. Pass B uses `The claim is false: <original claim>`.

Signals:

- support = Pass A entailment probability
- refutation = max(Pass A contradiction probability, Pass B entailment probability)
- neutral = Pass A neutral probability

A polarity is accepted only at >=0.60, with >=0.10 margin over the other polarity and >=0.05 margin over neutral; otherwise the research result is NEUTRAL.

## Model seal

NLI: `Xenova/nli-deberta-v3-xsmall`

Version seal: `q8@3fac2500`

ONNX SHA-256: `3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6`

## Validation

The exact handoff test suite contains 39 assertions covering support, contradiction, false-claim entailment, neutrality, conservative cases, two-pass behavior, raw-result preservation, wrapper behavior, and V2 isolation. Unit tests are not benchmark metrics.

## Frozen external comparison

The reproducible external evaluation completed successfully on GitHub Actions:

- Run: `36308430718`
- Commit: `928447e06be028331e043799fecc8199355ef835`
- Artifact: `truthlens-v2.5-contradiction-aware-evaluation`
- Artifact ID: `10929361238`

The workflow verified the frozen SciFact/model hashes and expected counts, imported the exact bundle, validated the sealed model stack, ran the adjudicator tests, evaluated the unchanged raw V2 baseline, evaluated the isolated V2.5 adapter, and generated the comparison/error-analysis artifact.

Detailed results are recorded in `docs/V2_5_EXTERNAL_EVALUATION_RESULTS.md`.

### Frozen result summary

- Accuracy: `0.353333 → 0.373333`
- Macro-F1: `0.293167 → 0.290932`
- NLI accuracy: `0.524520 → 0.511727`
- NLI Macro-F1: `0.536936 → 0.514363`
- REFUTED recall: `0.437500 → 0.312500`
- REFUTES recall: `0.614754 → 0.565574`
- Coverage: `0.343333 → 0.223333`
- Abstention: `0.656667 → 0.776667`
- ECE: `0.428217 → 0.391140`
- Recovered missed contradictions: `0`

The measured changes do not establish the intended contradiction-recognition improvement. The main directional effect was increased abstention and movement from REFUTED toward INSUFFICIENT_EVIDENCE.

## Acceptance

**V2.5 is not accepted for production.**

The frozen experiment recovered zero missed contradictions under its explicit recovery counter, reduced REFUTED recall and REFUTES recall, reduced coverage, and reduced NLI performance. Accuracy and ECE changed in the other direction, but those changes do not by themselves establish the research objective.

No threshold tuning, label changes, source-policy changes, presentation changes, production model changes, merge, or deployment were used to manufacture an acceptance result.

## Production boundary

Production/main remains `32db8230547658b7d5d2a615599526d88c22fce9`.

The V2.5 branch remains research-only.