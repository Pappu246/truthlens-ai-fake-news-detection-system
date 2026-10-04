# TruthLens V3 Phase 2 Scoring Recovery Handoff

Updated: 2026-10-04

Repository: Pappu246/truthlens-ai-fake-news-detection-system

Current production main baseline: 8c8ef1d7aa4c567f7e6c97002c1fedd2f5633aa7

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
- AVeriTeC's pinned dev evidence store has already been materialized and hash-verified; end-to-end scoring is still required.
- The AVeriTeC runner has a research-only chunked embedding adapter to avoid the prior worker response-buffer overflow.
- The Phase 2 resumable coordinator now reads frozen inputs from artifacts/v3/benchmark-assets/<benchmark> and writes benchmark outputs under artifacts/v3/<benchmark>.

## Current blockers

1. FEVER official scoring artifact is not yet present in the repository/CI artifacts.
2. FEVEROUS official scoring artifact is not yet present in the repository/CI artifacts.
3. AVeriTeC official evaluation artifact is not yet complete/verified on the current branch.
4. The Open-Web 100-claim human-labelled blind holdout has not been sealed.
5. Vercel research preview deployment guard is configured; production main remains eligible for normal deployment.

No benchmark result is treated as valid until its complete official scorer/evaluator artifact and provenance are available.

## Resumable coordinator

scripts/v3Phase2ResumableCoordinator.mjs

Default operation:
- FEVER v1 and FEVEROUS pilots;
- max claims defaults to 100;
- writes artifacts under artifacts/v3;
- writes artifacts/v3/phase2-coordinator/checkpoint.json;
- resumes completed lanes from an existing compatible checkpoint;
- never treats the human-labelled Open-Web lane as autonomous;
- keeps production mutation disabled.

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
