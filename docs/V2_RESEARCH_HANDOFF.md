# TruthLens V2 Research Handoff

**Status:** Engineering-complete research branch; production `main` remains frozen. The latest completed SciFact result is still the frozen Run #19 baseline because the current-head Run #91 has not yet produced an artifact.

## Current repository state

- Production `main`: `32db8230547658b7d5d2a615599526d88c22fce9`
- Research head: `4c0581e199f86c278d7b8ce08d3639adeba41c2f`
- PR #26: open, not merged, mergeable, research-only.
- CI #248: SUCCESS.
- Phase 2 pipeline #162: SUCCESS.
- Phase 2 data validation #158: SUCCESS.
- Phase 7 benchmark #147: SUCCESS.
- Model-quality evaluation #195: SUCCESS.
- SciFact E2E #91: IN PROGRESS.

## Production boundary

The research branch adds an experimental `POST /api/v2/evidence/verify` route and a V2 health component in the shared `server/appFactory.ts`. This is additive research behavior. The production article/claim/evidence verdict contracts, production model artifact, thresholds, source policy and abstention policy were not replaced or retuned, and `main` itself remains unchanged.

## Engineering completed

- Evidence-grounded V2 pipeline: claim -> query expansion -> hybrid BM25/dense retrieval -> reranking -> pretrained NLI -> aggregation/abstention -> provenance.
- Diversified claim-extractor queries are preserved; deterministic support/contradiction variants are added.
- Full-corpus dense retrieval supports explicit candidate depth.
- Synthetic SciFact source-independence handling avoids collapsing independent papers solely because of fixture hostnames.
- Batched pretrained-NLI relatedness embeddings preserve inference semantics while reducing worker round-trips.
- Calibration diagnostics include raw ECE/Brier and held-out temperature-scaling analysis.
- V2 pipeline, route and model-quality regression suites are green.
- CI includes a dependency audit gate.

## Current verified research measurements

### ISOT

The current Phase 7 run #147 completed successfully on 44,898 rows with zero split-straddling near-duplicate groups. Calibrated linear SVM test F1 is 0.994048 and temporal F1 is 0.998107; the Reuters-dateline-mitigated test F1 remains 0.994048.

### Pretrained V2 component quality

Run #195 completed successfully. Local pretrained NLI accuracy is 0.524520 and macro-F1 is 0.536936 on 300 frozen SciFact claims / 469 evaluator-compatible passages. ECE-10 is 0.309079, worse than the heuristic comparator's 0.141591 in this evaluation. These are component-level measurements.

### SciFact end-to-end

The authoritative completed baseline remains Run #19:

- Open candidate recall: 53.67%
- Gold evidence Recall@5: 68.09%
- Directional accuracy: 37.00%
- Directional macro-F1: 0.341899

Current-head Run #91 is evaluating the same frozen 300 claims / 5,183 documents with sealed local models. No new score is inferred before the artifact is complete.

## Integrity rules

- Never combine ISOT, LIAR and SciFact metrics into one headline score.
- Never promote a partial/canceled SciFact run to a benchmark result.
- Keep production migration/deployment separate from research measurements.
- Treat source independence, temporal cutoff, abstention and calibration as explicit properties, not hidden assumptions.

## Remaining scientific/release gates

1. Finish SciFact run #91 and validate the resulting artifact.
2. Update the authoritative SciFact result record only from that completed artifact.
3. Run one final CI/docs-consistency gate after any result-state commit.
4. Review retrieval Recall@K, NLI component quality, verdict metrics, abstention, source independence and calibration together.
