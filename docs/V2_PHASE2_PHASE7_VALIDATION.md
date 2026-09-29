# TruthLens V2 — Phase 2 / Phase 7 Validation Record

## Current completed validation

Branch: `research/truthlens-v2-model-quality`

The research branch has separately completed current Phase 2 and Phase 7 validation workflows with success. These benchmarks evaluate the ISOT dataset and remain distinct from the SciFact/V2 evidence-grounding benchmark.

## Phase 2 — real ISOT data validation

Latest completed validation run: **#157** — SUCCESS.

The workflow verified the official Phase 2 dataset assets, executed the real-data preparation pipeline, and uploaded the measured preparation/split artifacts.

## Phase 7 — leakage-aware ISOT benchmark

Latest completed benchmark run: **#146** — SUCCESS.

The benchmark uses near-duplicate-aware grouping and a separate temporal test while leaving the production model artifact unchanged.

The latest measured ISOT results remain controlled dataset benchmarks, not claims of universal real-world fake-news detection accuracy. They must never be combined with SciFact, LIAR, or live-news measurements.

## Research disposition

- Production model artifacts remain unchanged.
- No Phase 2/Phase 7 benchmark result replaces the production release snapshot.
- The separate V2 SciFact benchmark is the gate for evidence-grounded research quality.
- A full current-head SciFact result must be published only from a completed artifact on the frozen 300-claim / 5,183-document setup.

## Latest completed artifact record — Phase 2

Workflow run: **#157**  
Run ID: `36597318281`  
Validated commit: `ba7631ebf4e3f1d6917d8fd04ab167ad50130b2f`  
Artifact SHA-256: `b1059307465f721e2a5dfe8e9c0b7e9cf3e64cc57609d959574c6f3b03b7faf8`

The preparation artifact records:
- 44,898 raw rows (23,481 fake / 21,417 real)
- 5,401 near-duplicate groups involving 12,133 articles
- 0 near-duplicate groups straddling train/validation/test splits
- 2 cross-label near-duplicate groups
- 18,618 strict Reuters-dateline matches (86.93% of real rows)
- 10 invalid dates excluded from the temporal split
- temporal cutoff: 2017-01-01

The Reuters dateline rate is a material shortcut risk and is explicitly measured rather than hidden.

## Latest completed artifact record — Phase 7

Workflow run: **#146**  
Run ID: `36597318432`  
Validated commit: `ba7631ebf4e3f1d6917d8fd04ab167ad50130b2f`  
Artifact SHA-256: `0ed6d6a57a06c64901b92859fbf792a422f1719823fa5ba2d221688e1e92e8cb`

The leakage-aware benchmark reported, on its held-out test split:

| Model variant | Accuracy | Macro-F1 | ROC-AUC | PR-AUC | ECE-10 |
|---|---:|---:|---:|---:|---:|
| Logistic regression | 0.989607 | 0.989601 | 0.999043 | 0.999183 | 0.059294 |
| Calibrated linear SVM | 0.993764 | 0.993761 | 0.999311 | 0.999464 | 0.005818 |
| Logistic regression, Reuters dateline mitigated | 0.989607 | 0.989601 | 0.999043 | 0.999184 | 0.059309 |
| Calibrated linear SVM, Reuters dateline mitigated | 0.993912 | 0.993909 | 0.999311 | 0.999464 | 0.005822 |

Separate temporal evaluation for the calibrated linear SVM reported accuracy **0.998677** and macro-F1 **0.998545**. The benchmark is dataset-specific and is not evidence of universal real-world fake-news detection accuracy.

The benchmark explicitly records `production_artifact_modified=false`.
