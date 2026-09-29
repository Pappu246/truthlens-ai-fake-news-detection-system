# TruthLens V2 Research Status — 2026-09-29

## Scope

This is a research-branch status record. Production behavior is unchanged and the V2 work remains isolated from the production verdict contract.

## Verified repository state

- Current research head: `ba7631ebf4e3f1d6917d8fd04ab167ad50130b2f`
- Production baseline remains on the separate production branch.
- Latest CI/type-check/build run on the research code head: **success**; the current docs-only head also has a passing CI gate.
- Phase 2 ISOT pipeline tests: **success**.
- Phase 2 real ISOT data validation: **success**.
- Phase 7 real ISOT benchmark: **success** on run #146; its artifact is recorded below.

## Real ISOT benchmark

The benchmark used 44,898 rows from the ISOT dataset and a leakage-safe group-aware split.

Data preparation checks reported:

- Exact duplicate extra rows: 5,795
- Near-duplicate groups: 5,401
- Articles in near-duplicate groups: 12,133
- Cross-label near-duplicate groups requiring review: 2
- Near-duplicate groups crossing train/validation/test splits: **0**

Benchmark results:

| Model | Variant | Validation F1 | Test F1 | Temporal F1 |
|---|---|---:|---:|---:|
| Logistic regression | raw | 0.987810 | 0.989831 | 0.993817 |
| Calibrated linear SVM | raw | 0.993997 | 0.993902 | 0.998107 |
| Logistic regression | Reuters-dateline mitigated | 0.987952 | 0.989831 | 0.993873 |
| Calibrated linear SVM | Reuters-dateline mitigated | 0.993997 | 0.994048 | 0.998107 |

These are **dataset/model benchmark measurements**, not claims of real-world fake-news detection accuracy. The benchmark script explicitly leaves the production model artifact unchanged.

## Local pretrained V2 model-quality evaluation

The sealed local evaluation processed 300 SciFact development claims over 5,183 corpus documents.

Models:

- NLI: `Xenova/nli-deberta-v3-xsmall`
- Embeddings: `Xenova/all-MiniLM-L6-v2`

NLI component measurements:

- Heuristic accuracy: 0.307036
- Local pretrained accuracy: 0.524520
- Heuristic macro-F1: 0.205958
- Local pretrained macro-F1: 0.536936
- Accuracy delta: +0.217484
- Macro-F1 delta: +0.330978

Embedding diagnostic:

- 188 comparisons
- Heuristic mean margin: 0.039649
- Local pretrained mean margin: 0.551816
- Positive-margin rate: 0.654255 → 1.000000

Calibration was **not** declared improved: local pretrained ECE was 0.309079 versus 0.141591 for the heuristic component in this evaluation.

The result is a component-quality evaluation, not final TruthLens verdict accuracy.

## Current validation still running

The only long-running research validation still active on the current research head is:

- Full open-corpus SciFact end-to-end benchmark **Run #90**, frozen 300 claims / 5,183 documents, with sealed local pretrained models. Setup, dataset-hash verification, dependencies, runtime installation, and model-seal verification have passed; the benchmark step is still running and has not produced a final artifact.

Phase 2, Phase 7, CI, and the external model-quality evaluation are completed successfully on the current research head. No SciFact result is published until the complete artifact exists.

## Remaining research gates

1. Complete the current Run #90 full SciFact end-to-end benchmark.
2. Record its exact artifact/result and dataset/model hashes.
3. Run the final research-branch regression/CI gate after documentation/result updates.
4. Review retrieval Recall@K, NLI quality, verdict metrics, abstention and calibration together.
5. Keep any production migration decision separate from research measurements.

## Important limitations

The ISOT benchmark is a controlled dataset benchmark. Its high F1 values must not be presented as universal real-world TruthLens accuracy.

The SciFact fixture benchmark and component evaluation are also research measurements. Retrieval quality, source independence, temporal reasoning, calibration, claim scope and real-world web evidence remain separate concerns.

