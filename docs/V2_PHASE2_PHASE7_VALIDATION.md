# TruthLens V2 — Phase 2 / Phase 7 Validation Record

## Current completed validation

Branch: `research/truthlens-v2-model-quality`

The current research head has separately completed Phase 2 and Phase 7 validation workflows with success. These evaluate the ISOT dataset and remain distinct from the SciFact/V2 evidence-grounding benchmark.

## Phase 2 — real ISOT data validation

Latest completed validation: **run #158 — SUCCESS**  
Run ID: `36605230722`  
Validated commit: `4c0581e199f86c278d7b8ce08d3639adeba41c2f`  
Artifact ID: `11050851349`  
Artifact ZIP SHA-256: `ee65b9ac7d897174eb68c7b036de596519a5715fda67d5b5e71b6a992713ea30`

Preparation results:

- 44,898 raw rows: 23,481 fake / 21,417 real
- Exact duplicate extra rows: 5,795
- Near-duplicate groups: 5,401 involving 12,133 articles
- Cross-label near-duplicate groups: 2
- Near-duplicate groups crossing train/validation/test splits: 0
- Strict Reuters-dateline matches: 18,618
- Unparseable dates: 10
- Temporal cutoff: 2017-01-01

The Reuters dateline shortcut risk is measured explicitly rather than hidden.

## Phase 7 — leakage-aware ISOT benchmark

Latest completed benchmark: **run #147 — SUCCESS**  
Run ID: `36605230497`  
Validated commit: `4c0581e199f86c278d7b8ce08d3639adeba41c2f`  
Artifact ID: `11051501395`  
Artifact ZIP SHA-256: `ed9b80fc0d91fd5fd67f98758287e7a98c08dafe4854e7f8e788c894a626e77e`

Measured F1 values:

| Model | Variant | Validation F1 | Test F1 | Temporal F1 |
|---|---|---:|---:|---:|
| Logistic regression | raw | 0.987810 | 0.989831 | 0.993817 |
| Calibrated linear SVM | raw | 0.993997 | 0.994048 | 0.998107 |
| Logistic regression | Reuters-dateline mitigated | 0.987952 | 0.989831 | 0.993873 |
| Calibrated linear SVM | Reuters-dateline mitigated | 0.993853 | 0.994048 | 0.998107 |

The benchmark log confirms `production_artifact_modified=false`. These are controlled dataset measurements, not universal real-world accuracy claims.

## Research disposition

- Production `main` remains `32db8230547658b7d5d2a615599526d88c22fce9`.
- No Phase 2/Phase 7 result replaces the production release snapshot.
- The V2 SciFact benchmark remains a separate evidence-grounding gate.
- A SciFact score is published only after a complete 300-claim artifact exists.
