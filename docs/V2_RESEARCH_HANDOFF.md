# TruthLens V2 Research Handoff

**Status:** Engineering-complete research branch; production remains frozen. The latest fully completed external SciFact benchmark remains the frozen Run #19 baseline. A newer full-corpus rerun is configured on the current head but has not yet produced an artifact because the GitHub Actions job was cancelled while queued/infrastructure execution was being retried.

## Current production boundary

- Production `main`: `32db8230547658b7d5d2a615599526d88c22fce9`
- Current V2 research branch head: `0832f9be1ac38987c222e3bd54054a1fd5a15eba`
- PR #26 remains open and research-only.
- No research branch has been merged or deployed to production.

## Engineering work completed in this research branch

- Evidence-grounded V2 pipeline: claim -> query expansion -> hybrid BM25/dense retrieval -> reranking -> pretrained NLI -> aggregation/abstention -> provenance.
- All diversified queries from the shared production claim extractor are preserved; deterministic support/contradiction variants are added without replacing the production extractor.
- Full-corpus dense retrieval is supported with explicit candidate depth. The benchmark configuration uses candidate K=100, dense K=300, and final evidence K=8.
- Synthetic SciFact `.local/document/<id>` URLs are clustered per document so independent papers are not incorrectly collapsed into one source cluster. Real registrable-domain clustering is unchanged.
- Regression tests cover query diversity, deterministic expansion, dense retrieval candidate contribution, and synthetic-source independence.
- Pretrained NLI relatedness embeddings are batched to reduce worker round-trips while preserving the same inference semantics.
- External calibration diagnostics record raw ECE/Brier and a held-out temperature-scaling analysis; runtime production confidence semantics were not changed.
- The legacy 36-row demo assumptions in `scripts/test_pipeline.ts` are retired; the entry point delegates to the canonical production+V2 gate.
- CI includes an explicit `npm audit --audit-level=moderate` gate.
- Heavy V2 evaluation workflows are PR-only, ignore docs-only changes, do not auto-cancel an active benchmark, and have extended timeouts.

## Latest completed verification

- Full CI #176 on the preceding research head: **SUCCESS**, including dependency audit, type-check/build, production suites, V2 pipeline/route/model-quality suites.
- Phase 2 ISOT pipeline tests #131: **SUCCESS**.
- The current head contains workflow-only hardening after CI #176; the current CI #180 is the fresh validation run for that final head.
- Latest completed external model-quality component evaluation: sealed local pretrained run #54. It evaluated all 300 SciFact dev claims and 469 evaluator-compatible passages.
- A newer model-quality run on the current head passed the token-free harness smoke stage but its long local-pretrained stage was cancelled by Actions before producing a new artifact; the job is being retried without code changes.

## Latest completed end-to-end SciFact benchmark

The current authoritative completed benchmark remains **Run #19**:

- Workflow: **V2 SciFact End-to-End Benchmark**
- Run ID: `36512277229`
- Evaluated commit: `f40440d8caf58126f215fce2aa1e7c843934538b`
- Artifact: `truthlens-v2-scifact-end-to-end`
- Artifact ID: `11012755708`
- Artifact SHA-256: `29322f9630fd693b658bf3c108b2621c487d1d8c3ee178b90f6090cbd1a3d38c`
- Frozen inputs: **300 SciFact dev claims / 5,183 corpus documents**
- Candidate K: **100**
- Final evidence K: **8**

### Measured result

- Open candidate recall: **53.67%**
- Gold-evidence Recall@5: **68.09%**
- Directional accuracy: **37.00%**
- Directional macro-F1: **0.341899**
- SUPPORT F1: **0.176471**
- CONTRADICT F1: **0.380090**
- NOT_ENOUGH_INFO F1: **0.469136**

Production-policy diagnostics on this benchmark were mapped accuracy **37.33%**, mapped macro-F1 **0.181230**, abstention **100%**, non-abstain coverage **0%**, and CONFLICTED rate **0.33%**. Those figures are diagnostic only because classic SciFact does not satisfy the unchanged TruthLens requirement for two independent directional sources.

## Research integrity boundary

The 37% result is not presented as production accuracy or as a world-level claim. It is the last completed end-to-end measurement on frozen inputs and sealed research models. The newer dense-retrieval/query-diversity/reranking fixes are intentionally **not assigned a new accuracy number** until a complete 300-claim artifact is produced.

The production two-independent-source rule remains unchanged. No production thresholds, source policy, abstention rules, or production model artifacts have been changed.

## Remaining scientific gate

The code-side implementation work is complete. The unresolved research gate is empirical: obtain a completed current-head 300-claim SciFact artifact, compare it against Run #19, and keep it separate from production metrics. If the new end-to-end result remains weak, further progress should target retrieval recall/reranking and independently labelled calibration rather than changing production policy to fit the benchmark.

PR #26 must remain research-only until an end-to-end result provides sufficient evidence for any proposed production change.
