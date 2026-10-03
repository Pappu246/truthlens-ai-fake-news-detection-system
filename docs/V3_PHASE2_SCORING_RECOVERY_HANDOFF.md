# TruthLens V3 Phase 2 Scoring Recovery Handoff

Updated: 2026-10-04

Repository: Pappu246/truthlens-ai-fake-news-detection-system

Current production main baseline: 6c1a535d3b0b2ddd89b42ef933789537d69db2d9

## Active research state

Phase 2 is still in progress. Phase 0 and Phase 1 are complete. Phase 3+ remain locked until the Phase 2 exit gate is satisfied.

## PR

PR #47 — research: recover Phase 2 FEVER and FEVEROUS scoring

Branch: research/v3-phase2-scoring-recovery

This branch is additive and currently contains:
- FEVER open-retrieval candidate preparation and TruthLens evaluation;
- pinned official FEVER scorer wrapper;
- FEVEROUS structured candidate preparation and TruthLens evaluation;
- pinned official FEVEROUS scorer wrapper;
- SHA-256-locked FEVER/FEVEROUS materialization;
- 100-claim recovery pilot workflow;
- resumable Phase 2 coordinator with checkpoint persistence.

The branch is 0 commits behind main. Do not merge until the latest CI/pilot results are completed and reviewed.

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

## Current known blockers

- FEVER and FEVEROUS pilot workflow runs are queued because GitHub Actions is currently handling a large queue of pull-request workflows.
- AVeriTeC PR #44 run #8 is still in progress at the pinned evidence-store download step. No result is considered valid until the official scorer artifact exists.

## Recovery rule

After interruption:
1. Read this handoff.
2. Check PR #47 latest head and newest completed workflow.
3. Read the Phase 2 coordinator checkpoint if present.
4. Re-run only incomplete benchmark states.
5. Never recompute the verified SciFact baseline.
6. Never merge/deploy from a queued, failed, or in-progress benchmark state.

## Production boundary

No production model, threshold, source policy, merge, or deployment is changed by this branch.
