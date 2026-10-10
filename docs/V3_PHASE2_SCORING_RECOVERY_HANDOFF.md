# TruthLens V3 Phase 2 Scoring Recovery Handoff

Updated: 2026-10-11

Repository: Pappu246/truthlens-ai-fake-news-detection-system

Research PR: [#62](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/pull/62)
Research branch: `research/v3-phase2-current-main`
Current research head at handoff update: `05b398f32206a64d07afe630c1ee0e3e552dff00` (newer corrective commits may follow)
Production baseline: `3530dead5dea67b89e8327c0994c1aeafb1fe68a`

## Production boundary

Phase 2 changes are research-only. No production model, model weights/artifacts, thresholds, source policy, API runtime, or deployment are to be changed by this work. Keep PR #62 open and unmerged until the required benchmark artifacts and human-holdout requirements are genuinely satisfied.

## Verified public benchmark result

AVeriTeC dev-500 has a completed official evaluation artifact from [GitHub Actions run #53](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/38026849131):
- Verdict accuracy: 0.522 (52.2%).
- Veracity macro-F1: 0.2822664929 (28.23%).
- Claims SHA-256: `499793726b4a5406780928a3d9dedc48d6dd53de778f22437d129cacdb08e300`.
- Evidence store revision `26238ae`; SHA-256: `021e258cd6fb5fe6d627a4667d663e95c184c966939c15124df9206142fc2212`.
- Gold evidence was not injected into retrieval. This is a research-only AVeriTeC dev result, not production/universal accuracy.

## Frozen FEVER/FEVEROUS assets and expected evaluation sizes

- FEVER v1 labeled `shared_task_dev.jsonl`: SHA-256 `e89865bfe1b4dd054e03dd57d7241a6fde24862905f31117cf0cd719f7c78df7`, exactly **19,998 labeled development claims**. The former 37,566 expected count was wrong for this pinned file; workflow, manifest, public-only gate, and regression fixtures must use 19,998.
- FEVER Wikipedia archive: SHA-256 `4b06d95da6adf7fe02d2796176c670dacccb21348da89cba4c50676ab99665f2`, 1,713,485,474 bytes.
- FEVEROUS dev file: SHA-256 `97dc8e2be8982774b0cbb1dc04c0fd5b0966e711e93c8ea01b234ab64356f234`; expected labelled evaluation is **7,890 claims** (the downloaded JSONL includes its header).
- FEVEROUS wiki DB archive: SHA-256 `e25e034d9848c75ab3311a7a7ad8e80e769240b5a36b055da475f20071314881`, 10,353,775,701 bytes.

## Research runner and CI fixes

- FTS5 `rank` top-K selection with regression tests.
- FEVEROUS JSONL/newline and incremental-index fixes with regression tests.
- Ranged downloader validates exact byte ranges, retry and response lengths; ignored range responses now fall back to resumable curl where configured.
- Hash-pinned source assets and archive lengths.
- Public benchmark gate and test suite verify official artifact counts/provenance without unlocking production promotion or the human holdout.

## Current gate semantics

The new `scripts/publicBenchmarkExitGate.mjs` can only declare `READY_PUBLIC_BENCHMARKS_ONLY` after valid official score and provenance artifacts exist for FEVER 19,998, FEVEROUS 7,890, and AVeriTeC 500 claims. It always reports the Open-Web human holdout as deferred and keeps production promotion disabled.

The original `scripts/phase2ExitGate.mjs` remains authoritative for full Phase 2. Full Phase 2 is currently **BLOCKED** because the full public benchmark artifacts are not all verified and the fresh 100-claim blind human-labelled Open-Web holdout/attestation do not exist. AI-generated labels must never be passed off as independent human ground truth.

## Current test/workflow links

- Scoring Recovery #65: https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/38076969327
- AVeriTeC E2E #58: https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/38076969332
- Dataset materialization #184: https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/38076969319
- Open-Web holdout gate #57 (automated tests pass; holdout remains deferred): https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/38076969336
- Full Phase 2 exit gate #21 (blocked, fail-closed): https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/38076969335

Do not merge this PR or deploy research code from queued, failed, or in-progress benchmark states.
