# TruthLens AI — World-Level ML Upgrade: Progress Log

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

## Next Task (read this first in the next session)

**Tasks 1, 2, 7, 9, and 10 are all complete and independently verified. Do
not repeat any of them.**

**Next priority: Task 11, end-to-end Live News / article pipeline audit.**
Trace the full path: headline -> article URL -> SSRF-safe URL validation ->
fetch -> article extraction -> actual article body -> content-quality gate
-> ML analysis -> claim extraction -> evidence verification. The critical
requirement: a headline alone must never be presented as if it were a full
article analysis -- if the real article body cannot be obtained, the result
must be NEEDS MORE CONTEXT with a clear reason, not a verdict based on the
headline text alone. Test specifically: successful extraction, extraction
failure, headline-only, malformed URL, private/loopback IP, localhost,
redirects, oversized response, timeout, unsupported content type, and that
fetched HTML/article text is always treated as untrusted data, never as
instructions (prompt-injection-via-webpage resistance). After Task 11:
Task 12 (evidence/claim verification audit -- corroborated / contradicted /
unsupported / insufficient-evidence must stay distinct, "no evidence found"
must never become "fake"), then Task 13 (security audit).
