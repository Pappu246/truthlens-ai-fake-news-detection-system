# TruthLens V2.5 — Contradiction-Aware Evidence Adjudication

**Status:** research-only; production frozen.

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

The current exact handoff test suite contains 39 assertions covering support, contradiction, false-claim entailment, neutrality, conservative cases, two-pass behavior, raw-result preservation, wrapper behavior, and V2 isolation. Unit tests are not benchmark metrics.

## Frozen external comparison

The external run uses the same SciFact dev split and sealed model artifacts as V2.4, with the frozen evaluation clock and raw evidence presentation. The workflow first runs the unchanged raw V2 evaluator on the V2.5 branch, then runs the isolated contradiction-aware adapter through a temporary evaluation wrapper. This preserves the repository pipeline while making the experiment reproducible.

Baseline and V2.5 outputs are compared by final verdict, NLI label, calibration, coverage/abstention, high-confidence metrics, retrieval metrics, runtime/memory, and per-claim transition categories.

## Acceptance

V2.5 is not accepted until the reproducible external run is complete and the measured deltas are reviewed. No threshold tuning, label changes, policy changes, or presentation changes are used to manufacture an acceptance result.

Production/main remains `32db8230547658b7d5d2a615599526d88c22fce9`.
