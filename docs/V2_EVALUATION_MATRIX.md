# TruthLens V2 Evaluation Matrix

| Dimension | Gate | Status / interpretation |
|---|---|---|
| Static correctness | Type-check, build, regression suite | Required and continuously gated |
| Dependency security | npm audit at moderate level | CI gated |
| Retrieval | Query diversity, dense contribution, candidate recall | Regression + benchmark measured |
| Evidence quality | Reranking + source independence | Regression tested |
| NLI quality | Sealed local pretrained component evaluation | Completed component benchmark |
| Calibration | ECE/Brier + temperature-scaling diagnostics | Measured; no improvement claim |
| Scientific verification | Full-corpus SciFact | Benchmark artifact required before publishing the current-head result |
| Misinformation benchmark | ISOT Phase 2 validation | Current research gate |
| Leakage-aware evaluation | ISOT Phase 7 | Current research gate |
| Provenance | URL/evidence preservation | Implemented |
| Abstention | Insufficient/conflicted handling | Implemented |
| Reproducibility | Frozen inputs + hashes + artifacts | Documented |
| Security boundary | SSRF + dependency + production isolation | Gated |
| Production safety | Independent production policy boundary | Preserved |

## Publication rule

No result is promoted into a headline accuracy claim unless the exact dataset, split, workflow run, commit, and evaluation protocol are documented.

## Research conclusion rule

“Research-grade” describes engineering discipline and reproducibility. “World-leading” requires comparative evidence against strong external baselines on representative datasets and should not be inferred from architecture alone.
