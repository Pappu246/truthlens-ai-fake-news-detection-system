# TruthLens V2 Research Handoff

**Status:** End-to-end SciFact research checkpoint complete. Production remains frozen.

## Current production boundary

- Production `main`: `32db8230547658b7d5d2a615599526d88c22fce9`
- Current V2 research branch head: `441bf4168ccd45de9c84b458748539eef26c9e03`
- PR #26 remains open and research-only.
- No research branch has been merged or deployed to production.

## Final validation checkpoint

- CI #124: **SUCCESS**.
- Phase 2 Real ISOT Data Validation #91: **SUCCESS**.
- Phase 2 ISOT Pipeline Tests #95: **SUCCESS**.
- Phase 7 Real ISOT Benchmark #80: **SUCCESS**.
- V2 Model Quality External Evaluation #89: **SUCCESS**.
- V2 SciFact End-to-End Benchmark #13: **SUCCESS**.
- SciFact artifact: `truthlens-v2-scifact-end-to-end`, artifact ID `10992077824`.
- Artifact SHA-256: `2a3d025cdae1aa3d4342b3a44cbdbb2e2dd73fe0c30869d76c0ade88a053f2de`.
- Frozen SciFact inputs: **300 dev claims / 5,183 corpus documents**; exact dataset hashes verified.
- No duplicate SciFact run was created while #13 was active.

## Exact SciFact end-to-end result

Research models:

- NLI: `Xenova/nli-deberta-v3-xsmall` — `q8@3fac2500`
- Embedding: `Xenova/all-MiniLM-L6-v2` — `q8@afdb6f1a`

Protocol configuration:

- Candidate pool: **100**
- Final pipeline evidence set: **8**
- Gold-evidence Recall@5: **0.6808510638297872**
- Open candidate recall: **0.5366666666666666**

Benchmark directional evaluator:

- Accuracy: **0.3700000000000000**
- Macro-F1: **0.3418989628139955**
- SUPPORT: precision **1.000000**, recall **0.096774**, F1 **0.176471**, support **124**
- CONTRADICT: precision **0.267516**, recall **0.656250**, F1 **0.380090**, support **64**
- NOT_ENOUGH_INFO: precision **0.435115**, recall **0.508929**, F1 **0.469136**, support **112**

Production-policy view (reported separately because SciFact's one-gold-paper evidence structure does not satisfy the production two-independent-source policy):

- Mapped accuracy: **0.37333333333333335**
- Mapped macro-F1: **0.1812297734627832**
- Abstention rate: **1.0**
- Non-abstain coverage: **0**
- Non-abstain accuracy: **0**
- Conflicted rate: **0.0033333333333333335**

### Interpretation

This is a reproducible external end-to-end measurement, not a claim of world-leading performance and not a production-accuracy estimate. The retrieval stage is materially limiting: open candidate recall is **53.67%**, while gold-evidence Recall@5 is **68.09%** among evaluator-compatible gold evidence. The directional decision layer also remains weak at **37.0% accuracy / 0.3419 macro-F1**.

The production-policy view intentionally abstains on all 300 SciFact claims because the benchmark's single-paper evidence convention does not satisfy the production requirement for two independent sources. This is a dataset/policy mismatch, not a reason to relax production policy.

No production threshold, source rule, abstention rule, model artifact, or deployment was changed.

## Component-level pretrained comparison

The completed local model-quality evaluation remains:

| Metric | Heuristic | Local pretrained | Delta |
|---|---:|---:|---:|
| NLI accuracy | 0.307036 | 0.524520 | +0.217484 |
| NLI macro-F1 | 0.205958 | 0.536936 | +0.330978 |
| NLI ECE-10 | 0.141591 | 0.309079 | +0.167488 |
| Mean embedding margin | 0.039649 | 0.551816 | +0.512167 |
| Positive embedding-margin rate | 0.654255 | 1.000000 | +0.345745 |

The pretrained NLI improves component accuracy/F1 but worsens ECE on this evaluation. These are component-level results and must not be substituted for end-to-end verdict accuracy.

Machine-readable component result: `data/v2/local_model_quality_results.json`.

## Remaining research work

The mandatory end-to-end evaluation checkpoint is complete. The results do **not** justify production promotion.

Recommended next research iteration:

1. Improve candidate retrieval recall before further decision-policy tuning.
2. Evaluate a stronger dense retrieval / reranking setup on the same frozen SciFact inputs.
3. Revisit confidence calibration using an independently labelled calibration split.
4. Preserve the two-independent-source production policy; do not tune production around SciFact's single-paper convention.

