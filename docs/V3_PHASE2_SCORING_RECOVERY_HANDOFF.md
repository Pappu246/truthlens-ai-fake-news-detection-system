# TruthLens V3 Phase 2 Scoring Recovery Handoff

Updated: 2026-10-04 23:18 IST

Repository: Pappu246/truthlens-ai-fake-news-detection-system

GitHub `main` ref currently resolves to `8c8ef1d7aa4c567f7e6c97002c1fedd2f5633aa7`. Vercel's newest READY production deployment is docs-only commit `4f677654e3a8d0d69c6ea73561f2e9f29095a6bb`, whose content records `8c8ef1d7aa4c567f7e6c97002c1fedd2f5633aa7` as the production code commit. No Phase 2 research code is deployed to production.

## Active research state

Phase 2 is still in progress. Phase 0 and Phase 1 are complete. Phase 3+ remain locked until the Phase 2 exit gate is satisfied.

## Active research PRs

Only current-main Phase 2 research PRs remain active: #54 and #55.

## Verified baseline state

- Production main is 8c8ef1d7aa4c567f7e6c97002c1fedd2f5633aa7.
- Main's production Vercel deployment for that exact SHA is READY.
- No production model, threshold, source policy, or runtime artifact is changed by the Phase 2 research branches.
- SciFact is an existing frozen/baselined lane and is not recomputed by the recovery coordinator.
- FEVER and FEVEROUS inputs have frozen SHA-256 expectations and materialization workflows.
- #54 now runs explicit full-split FEVER (37,566 claims) and FEVEROUS (7,890 claims) jobs; pilot output cannot satisfy the exit gate.
- #55 now runs an explicit full 500-claim AVeriTeC job and retains the research-only chunked embedding fix.
- AVeriTeC's pinned dev evidence store has already been materialized and hash-verified; end-to-end scoring is still required.
- The AVeriTeC runner has a research-only chunked embedding adapter to avoid the prior worker response-buffer overflow.
- The Phase 2 resumable coordinator now reads frozen inputs from artifacts/v3/benchmark-assets/<benchmark> and writes benchmark outputs under artifacts/v3/<benchmark>.
- Recovery checkpoints distinguish 100-claim PILOT_COMPLETE from full-split COMPLETE, so a pilot can never suppress the required full benchmark run.

## Current blockers

1. The newly triggered full FEVER/FEVEROUS/AVeriTeC benchmark workflows have not yet produced verified official score artifacts visible through the connected GitHub run interface.
2. The Open-Web 100-claim human-labelled blind holdout has not been sealed; this remains a genuine human-only gate.
3. Vercel research preview deployment guard is configured; production main remains eligible for normal deployment.
4. Phase 2 cannot exit until `scripts/phase2ExitGate.mjs` validates all full benchmark artifacts plus the sealed Open-Web holdout.

No benchmark result is treated as valid until its complete official scorer/evaluator artifact and provenance are available.

## Resumable coordinator

scripts/v3Phase2ResumableCoordinator.mjs

Default operation:
- FEVER v1 and FEVEROUS recovery evaluation; the CI branch now enforces their full evaluation sizes;
- local coordinator default remains 100 claims for resumable recovery/pilot use; pilot state is explicitly distinct from COMPLETE;
- writes artifacts under artifacts/v3;
- writes artifacts/v3/phase2-coordinator/checkpoint.json;
- resumes completed lanes from an existing compatible checkpoint;
- never treats the human-labelled Open-Web lane as autonomous;
- keeps production mutation disabled.

## Latest CI-trigger note

The previous PR-associated benchmark/materialization jobs were queued. The current changes on #54 and #55 trigger the intended full benchmark workflows on their actual research branches. Their Vercel checks are SUCCESS while research deployments are intentionally skipped/canceled.

## Recovery rule

After interruption:
1. Read this handoff.
2. Check PR #54 and PR #55 latest heads and newest completed benchmark workflows.
3. Read the Phase 2 coordinator checkpoint if present.
4. Re-run only incomplete benchmark states.
5. Never recompute the verified SciFact baseline.
6. Never merge/deploy from a queued, failed, or in-progress benchmark state.
7. Do not treat a Vercel research-preview quota failure as a benchmark failure.

## Exit gate

scripts/phase2ExitGate.mjs is fail-closed. It requires:
- a complete FEVER official score artifact;
- a complete FEVEROUS official score artifact;
- a complete AVeriTeC official evaluation artifact with parsed metrics;
- a sealed 100-claim human-labelled TruthLens Open-Web holdout with matching SHA-256;
- intact Phase 2 protocol and production immutability rules.

The gate status is BLOCKED until all requirements are satisfied. This is a research gate, not a production deployment gate.
