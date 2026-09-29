# TruthLens V2 Research Handoff

**Status:** Research engineering and benchmark gates are complete for the unchanged V2 runtime. PR #26 is ready for production review/merge subject to normal repository governance.

## Current verified state

- Production `main`: `32db8230547658b7d5d2a615599526d88c22fce9`
- Research branch: `research/truthlens-v2-model-quality`
- PR #26: open, unmerged, mergeable.
- CI #250: SUCCESS.
- Phase 2 pipeline #163: SUCCESS.
- Phase 2 validation #159: SUCCESS.
- Phase 7 benchmark #148: SUCCESS.
- Model-quality evaluation #196: SUCCESS.
- SciFact Run #87: completed SUCCESS with a valid full-corpus artifact.

## Scientific disposition

Run #87 is the latest completed benchmark whose code/runtime is demonstrably equivalent to the current V2 implementation. Its artifact reports:

- Open candidate recall: 60.33%
- Gold evidence Recall@5: 73.40%
- Directional accuracy: 34.33%
- Directional macro-F1: 0.320335
- Production-policy abstention: 75%

No current-head metric is fabricated from an incomplete run. The runtime-equivalence comparison is explicit and reproducible.

## Production boundary

The V2 branch adds an experimental endpoint in `server/appFactory.ts`; it does not replace the existing production article/claim/evidence contracts or model artifact. Production `main` remains frozen at `32db823...` until PR #26 is actually merged.

## Final checks

- Dependency audit on committed dependencies: 0 vulnerabilities.
- CI and V2 regression suites: green.
- ISOT data leakage checks: zero split-straddling near-duplicate groups.
- Production artifact was not modified by Phase 7.
- V2 model-quality and SciFact artifacts preserve dataset/model hashes.
- Metrics are kept separated by task and dataset.

No universal real-world accuracy or world-leading claim is made.
