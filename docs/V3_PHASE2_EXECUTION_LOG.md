# TruthLens V3 Phase 2 Execution Log

## Current branch

- Branch: `research/truthlens-v3-phase2-benchmark-harness`
- Phase: 2 — Multi-benchmark evaluation harness
- Production promotion: blocked

## Resolved CI/infrastructure failures

1. `scripts/v3SealOpenWebHoldout.mjs` had a malformed line-splitting regular expression. Corrected to handle LF and CRLF input.
2. FEVER official scorer smoke lacked the legacy `six` dependency. The smoke/pilot/full environments now install it explicitly.
3. AVeriTeC's pinned legacy `leven` dependency does not build on the previous Python 3.11 setup. AVeriTeC smoke/pilot/full environments now use Python 3.10.
4. `scripts/v3BenchmarkCoordinator.mjs` used `crypto` without importing it. The import is now explicit.
5. Coordinator CI validation now performs a runtime dry-check with `--check-only`, not only `node --check`.
6. Long benchmark workflows previously used `cancel-in-progress: true`, which cancelled authoritative benchmark runs as the PR advanced. The Phase 2 full, pilot, and adapter-smoke workflows now preserve runs until completion.

## Integrity rules

- No benchmark score is inferred from an incomplete or cancelled run.
- No current Phase 2 result is promoted into a SOTA/world-leading claim.
- The external open-web holdout remains an independent human-annotation gate; labels cannot be fabricated by TruthLens.
- The production branch remains untouched by Phase 2 until all declared gates are verified.

## Remaining Phase 2 gates

- Current exact-head CI green.
- Current exact-head adapter smoke green.
- Completed FEVER development evaluation with official scorer artifact.
- Completed AVeriTeC development evaluation with official scorer artifact.
- Completed FEVEROUS structured evaluation with official scorer artifact, subject to runner resource feasibility.
- Preserve an explicit external open-web holdout gate for later generalization if no independent 300+ claim annotated set is available.
- Update the Phase 2 state only after the preceding evidence is complete.
