# TruthLens AI — World-Level ML Upgrade: Progress Log

> **Current verified status (2026-10-22).** This block is the source of truth for the next work session. The numbered audit sections further below are historical implementation notes; where their old descriptions conflict with this current block, trust the current block and update the historical notes only when their original context matters.

## Current production baseline — verified against the live Vercel alias

- **Production commit:** `ad9dd3ffeaa273824a06bfc26ed8d300a41f849f` on `main`.
- **Live checks:** `/api/health`, `/api/models/metrics`, `/api/model/diagnostics`, `/api/claim/metrics`, and the homepage returned HTTP 200 during the 2026-10-22 audit. The current main SHA's CI, Render production-smoke workflow, and Vercel production-smoke workflow all completed successfully on 2026-10-20.
- **Article classifier:** ISOT-trained Linear SVM with an exact three-member calibrated ensemble, version `3.1.0-isot`; production model lock is on. Frozen decision thresholds are `P(FAKE) >= 0.98` and `P(FAKE) <= 0.35` for REAL. Inputs between thresholds or failing safety/OOD checks can abstain. The production benchmark reports 99.59% accuracy on its 7,732-example ISOT held-out split; this is a same-corpus benchmark result, **not** evidence of 99.59% real-world accuracy.
- **Claim classifier:** LIAR-based claim-specific model `1.1.0-liar-claim`, available separately from the full-article classifier. Its reported text-only LIAR test accuracy is 62.72% (n=802); metadata-assisted is 65.84% (n=802). Claim scores must not be presented as full-article accuracy, or combined into a fake-news probability.
- **Evidence retrieval:** API component reports READY, but retrieval depends on outbound providers and per-request results. An unsuccessful or blocked publisher fetch is not proof that a claim is false. `INSUFFICIENT_EVIDENCE`, `SEARCH_UNAVAILABLE`, claim-model probability, and article-model probability are different signals.
- **V2 research stack:** marked EXPERIMENTAL and additive; it does not govern the production article/claim verdicts.
- **History persistence:** the latest main UI explicitly says analysis history is stored in the browser on that device; shared server-side per-user history is disabled until authenticated per-user storage exists.
- **Observed runtime events:** grouped Vercel logs show publisher extraction HTTP 403 and 404 events and a recurring Node `DEP0169 url.parse` deprecation warning. HTTP 403/404 can be expected publisher restrictions/missing URLs; verify that the API reports them safely rather than retrying aggressively or inferring a truth label. The warning's source has not yet been identified. Vercel Hobby log retention prevented a full 24-hour raw-log query in this audit.

## Research candidate status — NOT PROMOTABLE

Open draft PR [#131](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/pull/131) is based on an older `main` SHA than the current production commit. Keep it research-only and **do not merge/promote its model**.

Latest recorded candidate validation (workflow [39475286707](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/39475286707)) completed training, Python/Node artifact parity, and existing model/verdict regressions, but its release gate failed. On the untouched WELFake same-corpus holdout (n=11,621), the frozen production decision policy plus abstention produced about 66.3% coverage, 64.1% operational balanced accuracy, and 57.3% fake recall, below required gates. More seriously, the candidate-specific regression classified a clearly fabricated synthetic fixture as `LIKELY REAL` with `P(FAKE)=0.0045`; its safety run recorded 12 assertions passed and 1 failed. The final gate also reported that the artifact-bound safety report did not pass its hash/zero-failure contract. These are legitimate blockers, not CI flakes. Do not weaken thresholds or remove the regression to obtain green CI.

A separate, source-independent full-article validation report on at least 10,000 eligible articles is still missing. WELFake is a same-corpus holdout; LIAR evaluates a different claim-level task. FineFake intake/evaluator tooling exists in PR #131, but the archive has not been obtained and verified in the recorded run, and no FineFake score exists. Do not execute unverified pickle data or treat FineFake as source-independent validation without proving source separation.

## Prioritized next actions

1. **Keep production frozen.** No changes to `main`, `data/saved_model_artifacts.json`, production thresholds, deployment aliases/settings, or model promotion as part of research debugging. Do not merge PR #131.
2. **Diagnose PR #131's safety failure.** Preserve the synthetic fabricated-article false-REAL regression. Identify why it produces `LIKELY REAL`/0.0045, report the artifact-bound safety JSON failure accurately, and fix the candidate/model or reject it. Re-run the same full workflow on one exact head SHA. Green unit tests alone are not the release gate.
3. **Build independent full-article validation.** Select a legally usable, hash-pinned, source-independent dataset with article-level truth labels; exclude overlap with fitting/calibration/model-selection data; retain a reproducible manifest, source/date split, sample counts and metrics; require the exact runtime policy and adversarial safety suite to pass. Do not claim global real-world accuracy from ISOT/WELFake alone.
4. **Complete the Phase 2 benchmark protocol tracked in [issue #132](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/issues/132).** Use official pinned scorers for FEVER, FEVEROUS, SciFact and AVeriTeC, complete the required sample counts, bind reports to model/config/data hashes, and create/seal the planned blind human-labelled Open-Web holdout (at least 100 claims). AI-generated annotations are not gold labels. Every gate must run against the same commit.
5. **Re-test the live article/news pipeline and signal separation.** Verify the fetched body (not headline alone), freshness, SSRF/redirect/size/timeout handling, publisher-block handling, provenance, and prompt-injection resistance. Missing evidence must never automatically become FAKE. Keep claim model, article classifier, and evidence verdict visible as separate signals.
6. **Investigate runtime warnings from evidence, not guesswork.** Identify the dependency/source of Node `DEP0169` before changing packages. Track publisher 403/404 as per-request extraction outcomes; use fallback evidence retrieval only within bounded budgets and never fabricate citations.
7. **Only after the above:** update final release notes/UI claims from measured evidence, rerun CI + production smoke on the exact candidate SHA, and require human review of all reports before any separately approved promotion.

## Session rule

Read this current block first. The rest of this file preserves historical audits and implementation notes and may contain statements that were true when written but are no longer the current deployed state. Do not silently treat those snapshots as current production facts.

---


This file is the persistent state for the 19-phase upgrade. Read this file
first in every new work session before touching any code. It records what
is verified, what is missing, and the exact next task.

**Do not start Phase 2+ work without reading this file's "Next Task"
section at the bottom.**

---

## Phase 1 — Repository Audit (COMPLETE)

Audit date: see git log of the commit that introduced this file.
Everything below was verified directly against files in this repository —
nothing here is assumed, estimated, or fabricated.

### 1. Current architecture (as it exists today)

The production app is a single Node/Express service (`server.ts`). It
serves the frontend and every `/api/*` route from one process. The active
runtime model is loaded from `data/saved_model_artifacts.json` by
`server/mlEngine.ts` — this is the **only** model that real user requests
ever hit.

There are, however, **three separate, disconnected training code paths**
in the repo, which is itself a finding:

| # | Location | Trains on | Writes to | Actually used by production? |
|---|---|---|---|---|
| 1 | `server/mlEngine.ts` → `train()` | `data/news.csv` (36 rows) | `data/saved_model_artifacts.json` | **Yes** — this is what the "Retrain" button in the UI and `/api/train` call |
| 2 | `backend/ml/train.py` | `DEFAULT_DATASET_PATH` / `SAMPLE_DATASET_PATH` (resolves to `data/news.csv` / `data/sample_news.csv`, both 36 rows) | `backend/models/*.joblib`, `backend/models/metrics.json` | No — offline only, never called by the Node server |
| 3 | `scripts/train_isot.py` | `data/True.csv` + `data/Fake.csv` (real ISOT dataset) | `backend/models/*.joblib` **and** `data/saved_model_artifacts.json` (the actual runtime file!) | No — **has never been run**; this is the one script capable of producing a real production model, and it already writes to the correct runtime location |

**Key implication:** `scripts/train_isot.py` is the right foundation to
build on. It is already designed to write directly into the file the
production server reads. It has never been executed because the real ISOT
CSV bytes are not present (see §2).

### 2. Datasets verified locally

| Dataset | Files | Status | Verified size / shape |
|---|---|---|---|
| Demo dataset (currently in production) | `data/news.csv`, `data/sample_news.csv` | **Real, present, tiny** | 36 data rows + header, columns `title,text,label` |
| LIAR benchmark | `train.tsv`, `test.tsv`, `valid.tsv` (duplicated identically at repo root and in `data/`) | **Real, present, full-size, verified authentic** | 10,269 / 1,283 / 1,284 rows, 14 tab-separated columns. Label distribution confirmed by direct count (see §7). Row counts match the published LIAR dataset exactly. |
| ISOT Fake News Dataset | `data/Fake.csv`, `data/True.csv` | **Configured via Git LFS, but only pointer files are checked out — the real data is NOT present in this working copy** | Pointer files are 133 bytes each. The LFS pointer metadata (SHA-256 oid + declared size) says the real files are 62,789,876 bytes (`Fake.csv`) and 53,582,940 bytes (`True.csv`) — consistent with the ISOT dataset's known ~45k-article scale. **Not fabricated — this is the literal content of the LFS pointer files**, which is publicly verifiable. |
| Out-of-domain validation cache | `data/external_validation.json` | Real, present | Pre-computed output of `scripts/evaluate_liar.py` run against the **current 36-row demo model** — i.e. this is a real evaluation, but of the wrong (demo) model. Needs to be regenerated once a real model exists. |

### 3. Schemas confirmed

- **Demo dataset:** `title,text,label` (label is the string `REAL` or `FAKE`).
- **LIAR (`train.tsv`/`test.tsv`/`valid.tsv`):** 14 tab-separated columns,
  no header row. Column 2 is the label. Verified 6-way label taxonomy:
  `pants-fire`, `false`, `barely-true`, `half-true`, `mostly-true`, `true`.
- **ISOT (`Fake.csv`/`True.csv`):** schema not yet directly verifiable
  (pointer files only), but `scripts/train_isot.py` already assumes the
  well-documented ISOT column layout: `title, text, subject, date`. This
  matches the dataset's known public schema and is a reasonable
  assumption to proceed on once the real files are pulled — but must be
  **re-verified against the real header row** the moment the actual CSV
  bytes are available, before trusting any of it.

### 4. Label distribution verified (LIAR, real counts, not estimated)

```
train.tsv (10,269 rows): half-true 2123, false 1998, mostly-true 1966,
                          true 1683, barely-true 1657, pants-fire 842
test.tsv  (1,283 rows):  half-true 267,  false 250,  mostly-true 249,
                          barely-true 214, true 211, pants-fire 92
valid.tsv (1,284 rows):  false 263, mostly-true 251, half-true 248,
                          barely-true 237, true 169, pants-fire 116
```

ISOT label distribution cannot be verified yet — real bytes are not
present locally (see §2, §6).

### 5. Existing training scripts — reviewed in detail

`scripts/train_isot.py` (554 lines) is a genuinely well-built pipeline:

- Reads `data/True.csv` + `data/Fake.csv`, tags REAL=0 / FAKE=1.
- Cleans: drops rows with empty title+text; **deduplicates on exact
  string match** of `title + " " + text` only.
- Stratified 80/20 train/held-out-test split (`random_state=42`).
- Stratified 5-fold CV **on the training split only**, with TF-IDF
  refit fresh inside every fold — this is correct leakage-prevention
  for the CV step specifically.
- Compares Logistic Regression vs. Linear SVM (Platt-calibrated via
  `CalibratedClassifierCV`), selects by mean CV F1.
- Trains the selected model on the full training split, evaluates once
  on the held-out test split, extracts Platt `a`/`b` calibration
  parameters directly from the fitted calibrator.
- Writes `backend/models/metrics.json` **and** `data/saved_model_artifacts.json`
  (the real production runtime file) in the same run.

**Gaps identified in this script (to fix in Phase 2, not yet fixed):**

1. **Deduplication is exact-match only.** ISOT is well known in the NLP
   literature to contain many *near*-duplicate wire-service articles
   (same story, minor rewording). Exact-string dedup will not catch
   these. Near-duplicate detection (e.g. shingling / MinHash, or a
   simple normalized-text + high n-gram-overlap check) is not yet
   implemented anywhere in this repo.
2. **No temporal split.** The script captures a `date` field per article
   but never uses it — the split is a random stratified split only. A
   temporal split (train on older articles, test on newer ones) is what
   the user's Phase 1 spec calls for and is not present.
3. **Known ISOT leakage risk not addressed.** This is a widely
   documented property of the ISOT dataset specifically: `True.csv`
   articles are Reuters wire copy and their text is unusually likely to
   start with a dateline pattern (e.g. `"WASHINGTON (Reuters) - "`),
   while `Fake.csv` articles do not have this pattern. A classifier can
   trivially learn "does this text start with a Reuters dateline" as a
   proxy for the real label instead of learning genuine
   real-vs-fake linguistic signal. **This has not been checked or
   mitigated anywhere in the current script or repo.** It must be
   investigated once the real CSV bytes are available (check for the
   pattern, and if present, decide whether to strip it or keep it as a
   deliberately-disclosed limitation).
4. **No cross-domain split built into training itself** — cross-domain
   checking currently only happens *after* training, via the separate
   `scripts/evaluate_liar.py` script (see §7), not as an integrated part
   of the train/validate loop.

`backend/ml/train.py` (the offline, config-driven Python pipeline) was
also reviewed: it only ever trains on the 36-row demo dataset via
`DEFAULT_DATASET_PATH`/`SAMPLE_DATASET_PATH`, has no knowledge of ISOT at
all, and is not called by the running server. It is redundant with
`scripts/train_isot.py` and with `server/mlEngine.ts`'s own `train()`
method. This three-way redundancy needs a decision in Phase 2: keep
`scripts/train_isot.py` as the single canonical training entry point
(recommended, since it already writes the correct runtime artifact), and
either delete or clearly re-document `backend/ml/train.py` as
demo/offline-only.

### 6. Git LFS status — verified, not assumed

- `.gitattributes` correctly declares `data/Fake.csv` and `data/True.csv`
  as `filter=lfs diff=lfs merge=lfs -text`.
- `git-lfs` was **not installed** in this working environment; it was
  installed successfully via `apt-get install git-lfs`.
- `git lfs pull` was attempted. The LFS protocol handshake with GitHub
  **succeeded** — GitHub issued valid, signed S3 presigned download URLs
  for both objects, which only happens if the objects actually exist in
  GitHub's LFS storage for this repo. The actual file download then
  failed with an HTTP 403 from this specific working environment's
  network proxy (`x-deny-reason: host_not_allowed` for
  `github-cloud.githubusercontent.com`), confirmed by a direct `curl -I`
  to the same presigned URL returning that same header. **This is a
  restriction of the current sandboxed work environment's network
  allowlist, not a problem with the repository, the LFS configuration,
  or the dataset itself.**

### 7. LIAR dataset usage — how it fits correctly

`scripts/evaluate_liar.py` (already exists, already correct in design)
does **not** train on LIAR — it uses LIAR purely as an **out-of-domain
generalization check** for whatever model is currently in
`data/saved_model_artifacts.json`. It maps LIAR's 6-way truthfulness
scale down to binary:

- `pants-fire`, `false` → `FAKE`
- `mostly-true`, `true` → `REAL`
- `barely-true`, `half-true` → **excluded** (genuinely ambiguous
  middle ground; not fake enough or real enough to score either way)

This is a defensible, honest design choice — it deliberately avoids
forcing a binary label onto statements that are not clearly one or the
other, rather than silently mislabeling them. It should be **kept as-is**
in Phase 2, not treated as something to "fix." The only action item is to
**re-run it once a real ISOT-trained model exists**, since right now it
is only evaluating the 36-row demo model (which is what
`data/external_validation.json`'s cached output currently reflects — see
the `source_training_dataset: "data/news.csv (36 benchmark articles)"`
field inside that file).

### 8. Current model training pipeline status

The model actually serving live predictions today is:

- Trained on 36 rows (`data/news.csv`)
- Vocabulary size 2,910 TF-IDF features
- Self-labeled in its own artifact as `DEMO DATASET — NOT SUITABLE FOR
  FINAL MODEL EVALUATION` (this honesty banner is already correctly
  wired through the UI and was verified live in production)

This has **not changed** as a result of this audit. No retraining has
happened. Phase 1 is read-only investigation.

### 9. Every place the 36/37-row demo dataset is referenced

Confirmed by direct repo-wide search — these are the files that know
about `data/news.csv` / `data/sample_news.csv` and will need to be
revisited once a real dataset becomes the production default:

```
server/mlEngine.ts
server/dataValidation.ts
src/components/ExternalValidationSection.tsx
src/components/ModelSpecsView.tsx
src/data/mockData.ts
backend/main.py
backend/config.py
backend/models/metrics.json
backend/ml/data_validation.py
scripts/validate_ml.ts
scripts/evaluate_liar.py
data/external_validation.json
data/saved_model_artifacts.json
server.ts
```

Most of these don't need code changes — they read whatever is in
`data/saved_model_artifacts.json` / `backend/models/metrics.json`
dynamically and will correctly reflect a real model once one is trained
and saved to those same paths. The exception is anywhere that
hardcodes the string `"36"`, a demo-specific badge label, or a fixed
`source_training_dataset` description — those need to be confirmed
dynamic (most already are, per the file review in §5 and §7) rather than
hardcoded, on a file-by-file basis in Phase 2.

### 10. What must change to make a real training pipeline possible

In priority order for Phase 2:

1. **Obtain the real ISOT CSV bytes.** This cannot be done from the
   current sandboxed environment (see §6). Options, in order of
   preference:
   - Run `git lfs pull` on a machine with unrestricted internet access
     (e.g. the user's own computer, which has already proven it can
     push/pull this repo normally) — the objects are confirmed to exist
     in GitHub's LFS storage, so this should just work.
   - If that fails for any reason, download the ISOT dataset directly
     from its original source (University of Victoria ISOT lab) or a
     verifiable mirror, and replace the LFS pointer files.
2. **Verify the real ISOT schema and label balance** the moment the
   real bytes are available — do not assume the header matches what
   `train_isot.py` expects; check it first.
3. **Check for the Reuters-dateline leakage pattern** described in §5
   point 3, and decide how to handle it, before trusting any accuracy
   number the pipeline produces.
4. **Add near-duplicate detection** to the cleaning step (§5 point 1).
5. **Add a temporal split option** using the `date` field (§5 point 2),
   alongside the existing random stratified split — the spec asked for
   both temporal and cross-domain splits, and cross-domain (via LIAR) is
   already handled by `scripts/evaluate_liar.py`.
6. **Add a genuine three-way train/validation/test split**, not just
   train/test with CV standing in for validation — CV is a reasonable
   substitute for model *selection*, but a true held-out validation set
   is cleaner and matches what was asked for.
7. **Decide and document the single canonical training entry point**
   (recommend `scripts/train_isot.py`, evolved to include the above),
   and clearly mark `backend/ml/train.py` as demo/offline-only or retire
   it, to end the three-way pipeline redundancy found in §1.
8. **Pin `requirements.txt` to exact versions** (currently `>=`
   constraints only) so a retrain is actually reproducible — this
   directly supports Phase 2/8's "model versioning" goal.

None of the above has been implemented yet. Phase 1 is audit-only, as
instructed.

---

## Completed tasks

- [x] Full repository audit
- [x] Verified every dataset actually available locally (sizes, real vs.
      LFS-pointer-only, row counts)
- [x] Verified exact schemas and label distributions where data is
      actually present (demo dataset, LIAR)
- [x] Verified all three existing training code paths and their gaps
- [x] Verified Git LFS configuration and pinned down exactly why the
      real ISOT bytes aren't available here (sandbox network, not a
      repo problem)
- [x] Verified how the LIAR dataset is (correctly) used — out-of-domain
      validation, not training
- [x] Verified current production training pipeline status
- [x] Located every reference to the demo dataset across the repo
- [x] Identified the exact, concrete list of changes needed for a real
      training pipeline

## Phase 2 — Real Dataset Pipeline (COMPLETE)

The real ISOT dataset is now verified through the published `isot-data-v1`
release assets and the Phase 2 GitHub Actions validation workflow.

### Verified source integrity

| File | Bytes | SHA-256 |
|---|---:|---|
| `Fake.csv` | 62,789,876 | `bebf8bcfe95678bf2c732bf413a2ce5f621af0102c82bf08083b2e5d3c693d0c` |
| `True.csv` | 53,582,940 | `ba0844414a65dc6ae7402b8eee5306da24b6b56488d6767135af466c7dcb2775` |

Both files were verified in CI with the expected schema:
`title,text,subject,date`.

### Measured dataset quality

- Raw articles: **44,898**
- REAL: **21,417**
- FAKE: **23,481**
- Empty text rows: **631**
- Very short text rows: **246**
- Exact duplicate extra rows: **5,795**
- Invalid dates: **10**
- Near-duplicate groups with more than one article: **5,401**
- Articles involved in near-duplicate groups: **12,133**
- Largest near-duplicate group: **631 articles**
- Cross-label near-duplicate groups: **2**
- Near-duplicate groups straddling the random train/validation/test splits: **0**

### Leakage finding

The dataset contains a strong Reuters-source shortcut:

- Strict Reuters dateline matches: **18,618**
- Strict matches among REAL rows: **86.93%**
- Strict matches among FAKE rows: **0.0%**

This is a measured dataset property, not a model-quality claim. It must be treated explicitly during Phase 7 benchmarking so that headline/source artifacts are not mistaken for general fake-news understanding.

### Splits

The preparation pipeline produced:

- Train: **31,428**
- Validation: **6,735**
- Test: **6,735**
- Temporal train (before 2017-01-01): **19,198**
- Temporal test (2017-01-01 onward): **25,690**
- Undated rows excluded from temporal split: **10**

No production model artifact was changed by Phase 2.

### Phase 2 CI verification

The following workflows completed successfully on the Phase 2 pull request:

1. Node type-check + production build
2. Phase 2 synthetic pipeline tests
3. Real ISOT download, SHA-256 verification, preparation pipeline, and artifact upload

The measured report is retained as a GitHub Actions artifact.

---

## Phase 7 — Model Benchmarking (COMPLETE)

The real-data benchmark was executed in GitHub Actions using the verified
Phase 2 preparation pipeline. The benchmark compared TF-IDF Logistic
Regression and a Platt-calibrated Linear SVM on the group-aware random
splits and the separate temporal test set.

### Measured benchmark results

| Model / variant | Test F1 | Temporal F1 | Test Brier | Test ECE (10-bin) |
|---|---:|---:|---:|---:|
| Logistic Regression / raw | 0.98983 | 0.99382 | 0.01470 | 0.05929 |
| Calibrated Linear SVM / raw | 0.99390 | 0.99811 | 0.00536 | 0.00582 |
| Logistic Regression / Reuters dateline mitigated | 0.98983 | 0.99387 | 0.01471 | 0.05931 |
| Calibrated Linear SVM / Reuters dateline mitigated | 0.99405 | 0.99811 | 0.00536 | 0.00582 |

These numbers are measurements on the ISOT benchmark and should not be
treated as proof of real-world fake-news detection accuracy. In particular,
the extremely strong scores, combined with the previously measured
source-pattern imbalance, require cross-domain validation before production
promotion.

The strict Reuters dateline ablation changed the aggregate metrics only
slightly. That means removing the leading dateline alone does not explain
the benchmark performance; additional source/style artifacts and
out-of-domain testing remain important.

### Calibration

The calibrated Linear SVM achieved a test Brier score of approximately
**0.00536** and 10-bin ECE of approximately **0.00582** in the raw-text
benchmark. Calibration is therefore measured on real data, but it still
needs validation outside the ISOT domain.

### Production safety

- `data/saved_model_artifacts.json` was **not modified**.
- No benchmark model was promoted to production.
- Benchmark output was retained as a GitHub Actions artifact.

---

## Phase 8 — Proper Calibration (COMPLETE FOR ISOT BENCHMARK)

Platt-sigmoid calibration is exercised through
`CalibratedClassifierCV` and evaluated using Brier score and ECE. The
production artifact remains unchanged until the full model-versioning and
cross-domain validation process is complete.

---

## Remaining tasks (Phases 9–19)

Phase 1–8 are now verified at the preparation/benchmark level. The next
stage is model versioning and canonical training, followed by cross-domain
validation integration, multilingual support, security/API/UI hardening,
automated acceptance coverage, documentation, and deployment verification.

---

## Task 10 — Continued: root-caused and fixed the accidental production-write side effect

The initial Task 10 fix (commit a55c746) correctly stopped the engine from
silently serving degenerate P(FAKE)=0.5 predictions on a corrupt artifact,
but introduced a more serious problem: its fallback called `train()`, and
`train()` unconditionally persists to `data/saved_model_artifacts.json`.
That meant merely **importing** `server/mlEngine.ts` -- which constructs a
module-level `mlEngine` singleton against the real production path as a
side effect -- or calling the lazy `getDiagnostics()`/`getMetrics()`
initializers, could silently overwrite the canonical, possibly carefully-
promoted production model, with no human action and no record of it
happening. This was caught during this session's own testing (a real
working-tree mutation of the local production artifact was observed,
investigated, and traced to this exact mechanism) and is exactly the kind
of accidental production-model replacement the Phase 9 governance system
(explicit `--approve`/`--yes` promotion only) exists to prevent -- an
implicit runtime fallback should never be able to bypass it.

**Fix:** `train()` now takes a `persist` parameter (default `true`,
preserving existing behavior exactly for the three genuinely explicit,
human-initiated call sites -- `POST /api/train`, `POST /api/dataset/reset-
demo`, and the dataset-import method). Every implicit/lazy fallback call
site (constructor recovery, `getDiagnostics()`, `getMetrics()`) now passes
`persist: false`: recovery still trains a real, working in-memory model
(so `isModelTrained()` is `true` and predictions are non-degenerate), but
can never write to disk.

**A second, related real bug was found and fixed in the same pass:**
`getDiagnostics()`/`getMetrics()` only checked `this.metrics` for
truthiness before using it. An artifact whose `metrics` field is *present
but incomplete* (missing `best_model`, e.g. from a different pipeline or a
hand-edited file) passed that check and then crashed with an unhandled
`TypeError` reading `this.metrics.best_model.metrics`. Fixed by checking
for the specific shape both methods actually depend on
(`this.metrics && this.metrics.best_model && this.metrics.dataset_info`)
before proceeding, falling back to an in-memory (non-persisting) retrain
otherwise -- found via the new regression test below, not assumed.

**Regression tests added** (`scripts/test_artifact_lifecycle.ts`, now 12
assertions, 12/12 passing):
- A corrupt artifact recovers to a working in-memory model, and the
  corrupt file on disk is verified byte-identical before and after
  construction -- proving the fallback never wrote back to it.
- The real production artifact (`data/saved_model_artifacts.json`) is read
  and compared byte-for-byte before and after constructing engines and
  calling `getDiagnostics()`/`getMetrics()` on isolated instances --
  proving that importing/exercising this module can never touch the
  canonical file.

**Verified exhaustively with a hash guard around every test run in this
session:** `sha256sum data/saved_model_artifacts.json` was checked
immediately before and after each of the following, all showing zero
change (`e8b904c4...` throughout): the new 12-test suite,
`scripts/regressionVerdictTests.ts` (28/28 passing), and
`scripts/adversarialAcceptanceTests.ts` run against a live server (24/25
groups passing -- the sole failure, "REAL EVIDENCE TEST", requires
`GEMINI_API_KEY` for live search and is confirmed pre-existing/
environmental, unrelated to this change; that suite's own Test 24, "MODEL
INTEGRITY", independently self-reports "Production model retrained = NO").

## Next Task

Follow **Prioritized next actions** at the top of this file. The old Task 11 handoff below was written before later production article-pipeline, model and deployment work; do not execute it as the current plan without re-checking the current baseline.
