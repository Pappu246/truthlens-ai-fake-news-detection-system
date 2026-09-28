# TruthLens V2 — Phase 2 / Phase 7 Validation Record

## Frozen current-head validation

Branch: `research/truthlens-v2-model-quality`  
Commit: `f9bc9c7dca32093aa44ebdcedb0372e52e23b110`

### Phase 2 — real ISOT data validation

Workflow run: **#60**  
Conclusion: **SUCCESS**

Verified source assets:

| Asset | Size | SHA-256 |
|---|---:|---|
| `Fake.csv` | 62,789,876 bytes | `bebf8bcfe95678bf2c732bf413a2ce5f621af0102c82bf08083b2e5d3c693d0c` |
| `True.csv` | 53,582,940 bytes | `ba0844414a65dc6ae7402b8eee5306da24b6b56488d6767135af466c7dcb2775` |

The run completed the real-data preparation pipeline and uploaded the prepared split/manifest artifacts.

### Phase 7 — leakage-aware ISOT benchmark

Workflow run: **#49**  
Conclusion: **SUCCESS**  
Artifact: `isot-phase7-benchmark`  
Artifact SHA-256: `b58fde1977c75b4f716f8a29450f7ce06fb648cda6b2fe034b25ebeb1a422d60`

The benchmark explicitly keeps the production model artifact unchanged and evaluates near-duplicate-aware splits plus a separate temporal test.

Selected measured results from the frozen artifact:

| Model / variant | Split | Accuracy | Macro-F1 | ROC-AUC | PR-AUC | Brier | ECE-10 |
|---|---|---:|---:|---:|---:|---:|---:|
| Logistic Regression / raw | test | 0.989607 | 0.989601 | 0.999043 | 0.999184 | 0.014702 | 0.058941 |
| Calibrated Linear SVM / raw | test | 0.993912 | 0.993909 | 0.999310 | 0.999464 | 0.005358 | 0.005812 |
| Logistic Regression / Reuters-dateline mitigated | test | 0.989607 | 0.989601 | 0.999044 | 0.999184 | 0.014705 | 0.059072 |
| Calibrated Linear SVM / Reuters-dateline mitigated | test | 0.993912 | 0.993909 | 0.999312 | 0.999465 | 0.005360 | 0.005824 |
| Calibrated Linear SVM / raw | temporal test | 0.998677 | 0.998545 | 0.999928 | 0.999887 | 0.001608 | 0.004156 |

The Reuters-dateline ablation changed the measured metrics only marginally on this run. That should be recorded as a diagnostic result, not interpreted as proof that source shortcuts are absent in broader settings.

## Research disposition

These Phase 2/Phase 7 results are evaluation records for the research branch. They do not replace the frozen production artifact or authorize a production model change.

The separate Hugging Face pretrained-model comparison remains unexecuted because the repository `HF_TOKEN` secret is absent. The token-free external harness smoke test is green and is explicitly not a pretrained-model benchmark.
