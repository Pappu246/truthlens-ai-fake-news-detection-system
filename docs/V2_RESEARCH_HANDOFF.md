# TruthLens V2 Research Handoff

**Status:** End-to-end SciFact research checkpoint complete. Production remains frozen.

## Current production boundary

- Production `main`: `32db8230547658b7d5d2a615599526d88c22fce9`
- Current V2 research branch head: `e3f18aa3c6c5ca138bbef2392a9c35f902fb4546`
- PR #26 remains open and research-only.
- No research branch has been merged or deployed to production.

## Final validation checkpoint

- CI #132: **SUCCESS**.
- Phase 2 Real ISOT Data Validation #99: **SUCCESS**.
- Phase 2 ISOT Pipeline Tests #95: **SUCCESS**.
- Phase 7 Real ISOT Benchmark #88: **SUCCESS**.
- V2 Model Quality External Evaluation #108: **SUCCESS**.
- V2 SciFact End-to-End Benchmark #21: **SUCCESS**.
- SciFact artifact: `truthlens-v2-scifact-end-to-end`, artifact ID `11015937689`.
- Artifact SHA-256: `cc796d94b22003229de1e281b52aaa487d6db3721ea8fc4767a7b6ce8b2d259`.
- Frozen SciFact inputs: **300 dev claims / 5,183 corpus documents**; exact dataset hashes verified.
- No duplicate SciFact run was created while the active benchmark was running.

## Exact SciFact end-to-end result

Research models:

- NLI: `Xenova/nli-deberta-v3-xsmall` — `q8@3fac2500`
- Embedding: `Xenova/all-MiniLM-L6-v2` — `q8@afdb6f1a`

Protocol configuration:

- Candidate pool: **100**
- Final pipeline evidence set: **8**
- Open candidate recall: **0.5366666666666666**
- Gold-evidence Recall@5: **0.6808510638297872**

Benchmark directional evaluator:

- Accuracy: **0.3700000000000000**
- Macro-F1: **0.3418989628139955**
- SUPPORT: precision **1.000000**, recall **0.096774**, F1 **0.176471**, support **124**
- CONTRADICT: precision **0.267516**, recall **0.656250**, F1 **0.380090**, support **64**
- NOT_ENOUGH_INFO: precision **0.435115**, recall **0.508929**, F1 **0.469136**, support **112**

Production-policy view:

- Mapped accuracy: **0.37333333333333335**
- Mapped macro-F1: **0.1812297734627832**
- Abstention rate: **1.0**
- Non-abstain coverage: **0**
- Non-abstain accuracy: **0**
- Conflicted rate: **0.0033333333333333335**

The production-policy view intentionally abstains on all 300 SciFact claims because the benchmark's single-paper evidence convention does not satisfy the production requirement for two independent sources. This is a dataset/policy mismatch, not a reason to relax production policy.

## Interpretation

SciFact E2E Run #21 completed successfully on the frozen inputs. The exact machine-readable summary is persisted at `data/v2/scifact_end_to_end_results.json`. This confirms reproducibility of the current research stack but also confirms that the end-to-end system is not yet strong enough for production promotion.

The main research bottleneck remains retrieval/reranking:

1. Open candidate recall: **53.67%**
2. Gold-evidence Recall@5: **68.09%**
3. Directional accuracy: **37.0%**
4. Directional macro-F1: **0.3419**

The component-level pretrained comparison still shows better NLI accuracy/F1 than the heuristic adapter, while calibration remains worse; component metrics must not be substituted for end-to-end verdict performance.

## Remaining research work

The mandatory end-to-end evaluation checkpoint is complete and all current validation gates are green. There is no known validation blocker on the research branch.

Recommended next research iteration:

1. Improve candidate retrieval recall before further decision-policy tuning.
2. Evaluate stronger dense retrieval and reranking on the same frozen SciFact inputs.
3. Revisit confidence calibration on an independently labelled calibration split.
4. Preserve the two-independent-source production policy.
5. Do not merge PR #26 or deploy the research branch based on these results.

