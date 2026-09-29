# TruthLens V2 Research Status — 2026-09-29

## Scope

This is a research-branch status record. Production `main` remains frozen at the verified production baseline. V2 research work is not being treated as a production migration.

## Verified repository state

- Current research head: `4c0581e199f86c278d7b8ce08d3639adeba41c2f`
- Production `main`: `32db8230547658b7d5d2a615599526d88c22fce9`
- PR #26: open, not merged, mergeable, research-only.
- CI #248 on the current head: **SUCCESS**.
- Phase 2 ISOT pipeline tests #162: **SUCCESS**.
- Phase 2 real ISOT validation #158: **SUCCESS**.
- Phase 7 real ISOT benchmark #147: **SUCCESS**.
- V2 model-quality evaluation #195: **SUCCESS**.
- V2 SciFact end-to-end #91: **IN PROGRESS**; no final artifact/result is claimed yet.

## Production boundary

The production branch has not moved. The research branch does modify the shared `server/appFactory.ts`, but only additively: it exposes an experimental `POST /api/v2/evidence/verify` route and a V2 health component. The existing production article/claim/evidence verdict paths and production model artifact are not replaced or retuned by this change. V2 route regression tests explicitly verify the existing production `/api/evidence/verify` route remains present.

## Real ISOT benchmark

The current-head Phase 7 benchmark used 44,898 rows with a leakage-safe group-aware split.

Data preparation checks:

- Exact duplicate extra rows: 5,795
- Near-duplicate groups: 5,401
- Articles involved in near-duplicate groups: 12,133
- Cross-label near-duplicate groups: 2
- Near-duplicate groups crossing train/validation/test splits: **0**
- Strict Reuters-dateline matches: 18,618
- Unparseable dates excluded from temporal split: 10

Current Phase 7 run #147 reported:

| Model | Variant | Validation F1 | Test F1 | Temporal F1 |
|---|---|---:|---:|---:|
| Logistic regression | raw | 0.987810 | 0.989831 | 0.993817 |
| Calibrated linear SVM | raw | 0.993997 | 0.994048 | 0.998107 |
| Logistic regression | Reuters-dateline mitigated | 0.987952 | 0.989831 | 0.993873 |
| Calibrated linear SVM | Reuters-dateline mitigated | 0.993853 | 0.994048 | 0.998107 |

These are controlled dataset/model measurements, not universal real-world fake-news accuracy.

## Local pretrained V2 model-quality evaluation

The sealed local evaluation in run #195 processed 300 SciFact development claims and 469 evaluator-compatible evidence passages.

Models:

- NLI: `Xenova/nli-deberta-v3-xsmall`, q8@3fac2500
- Embeddings: `Xenova/all-MiniLM-L6-v2`, q8@afdb6f1a

| Component | Heuristic | Local pretrained | Delta |
|---|---:|---:|---:|
| NLI accuracy | 0.307036 | **0.524520** | +0.217484 |
| NLI macro-F1 | 0.205958 | **0.536936** | +0.330978 |
| NLI ECE-10 | 0.141591 | 0.309079 | +0.167488 |
| Mean embedding margin | 0.039649 | **0.551816** | +0.512167 |
| Positive embedding-margin rate | 0.654255 | **1.000000** | +0.345745 |

Calibration is not claimed improved. These are component metrics only, not final TruthLens verdict accuracy.

## Current validation

The current authoritative end-to-end gate is SciFact run #91:

- Frozen SciFact dev claims: 300
- Frozen corpus documents: 5,183
- Candidate K: 100
- Final evidence K: 8
- Sealed local pretrained NLI/embedding models
- Dataset and model seal checks: passed
- Benchmark execution: still running
- Artifact: **not yet produced**

An older SciFact run #90 on the immediately preceding documentation head is also still marked in progress. Neither incomplete run is treated as a result.

## Remaining gates

1. Complete SciFact run #91 and verify its machine-readable artifact, dataset hashes, model seals, and metrics.
2. If documentation/result state changes after that artifact, run one final CI/documentation consistency gate.
3. Review retrieval Recall@K, NLI quality, directional verdict metrics, abstention, source-independence behavior, and calibration together.
4. Keep production migration/deployment separate from research measurements.

## Limitations

ISOT, LIAR, and SciFact measure different tasks and must not be combined into one headline accuracy number. High ISOT F1 is dataset-specific. SciFact is also a research benchmark and its one-gold-paper convention does not by itself satisfy the production two-independent-source policy.

No world-leading or universal real-world accuracy claim is justified by the current evidence.
