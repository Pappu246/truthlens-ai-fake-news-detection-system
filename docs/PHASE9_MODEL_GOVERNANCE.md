# Phase 9 — Model Governance

Phase 9 establishes a canonical real-data candidate workflow without changing the production model.

## Flow

1. Phase 2 prepares leakage-aware ISOT splits.
2. `scripts/train_isot_runtime_candidate.py` trains a versioned, exact runtime-compatible calibrated candidate.
3. The candidate and manifest are written under `artifacts/models/<version>/`; the canonical production artifact is snapshotted and must remain byte-identical throughout training.
4. The workflow evaluates WELFake as an **external full-article** benchmark using `scripts/evaluate_welfake_candidate.py`. It verifies the pinned dataset MD5, removes normalized exact-text overlap with ISOT, deduplicates identical articles and excludes conflicting duplicate groups.
5. `external_validation.json` from LIAR remains a separate **claim-level diagnostic**. It must not be treated as an article-classification accuracy score or used as the sole promotion gate.
6. The workflow blocks promotion unless the full-article report has at least 10,000 eligible articles, balanced accuracy >= 0.70, fake recall >= 0.70, and real recall >= 0.70. It also reruns the same samples after removing common publisher bylines/title suffixes and requires balanced accuracy, fake recall and real recall to remain >= 0.65. This stress test is intended to catch obvious dependence on wire-service attribution terms; it does not remove all source/style cues. These are project release thresholds, not universal scientific guarantees.
7. A human reviews the candidate manifest, article-level report, LIAR diagnostic and safety-test results. Only explicit `--approve --yes` promotion can replace `data/saved_model_artifacts.json`.
8. Promotion verifies inference contract, all hashes and eligibility fields, creates a hashed backup, and records an audit event.

Normal training never writes the production artifact.

## Commands

```bash
python scripts/train_isot_runtime_candidate.py
python scripts/evaluate_welfake_candidate.py --candidate-dir artifacts/models/<VERSION> --welfake data/WELFake_Dataset.csv
python scripts/promote_model.py --model-version <VERSION> --approve --yes
```

Promotion remains intentionally blocked unless the candidate manifest is explicitly marked `production_eligible: true`. External validation alone does not make that decision.

The candidate manifest records dataset hashes, a deterministic fingerprint, split configuration, preprocessing, model configuration, calibration, metrics, artifact hash, and git commit.

**Primary article-model external gate:** WELFake is downloaded only in the candidate CI job from the Zenodo record and checked against MD5 `73c9675a4b3d09f86a6933d0b8d7d908`. The CSV is evaluation-only (never a training input) and is not uploaded in CI artifacts. The evaluator writes aggregate metrics and hashes only; it does not persist article text. It reports both raw metrics and a publisher-byline ablation to test whether common wire-service attribution patterns materially inflate results. WELFake is historical and mixed-source, so it is additional evidence, not a guarantee of performance on current news. Exact-normalized-text overlap and byline ablation cannot eliminate every near-duplicate or source/style shortcut.

High ISOT benchmark performance is not evidence of real-world fake-news detection accuracy. LIAR remains an out-of-domain claim-verification diagnostic; WELFake provides a task-matched full-article external evaluation. Both should be reported under their own task headings, never blended into a single accuracy number.

## Verified end-to-end run (independently reproduced)

The full lifecycle below was executed live, from scratch, against the real ISOT
release assets (SHA-256 verified) and the real LIAR test set. Every number
here is a direct, freshly-computed result -- none of it is copied from an
earlier claim without independently reproducing it.

- `data/isot_prepared/` regenerated from raw ISOT: 44,898 rows, near-duplicate
  groups=5,401 covering 12,133 articles, 2 cross-label near-dup groups, 0
  groups straddling a train/val/test split boundary.
- `scripts/train_isot_canonical.py --variant raw` trained successfully.
  Candidate `isot-svm-37fc02617260` (dataset fingerprint
  `37fc02617260155fb4ac53c18cd2d5e9c378d6d1eb356bde3c2b62f88f9bb638`),
  model family Linear SVM (Calibrated):
  - validation: accuracy 0.9947, F1 0.9949, ROC-AUC 0.9998
  - test: accuracy 0.9961, F1 0.9962, ROC-AUC 0.9994
  - temporal_test: accuracy 0.9991, F1 0.9988, ROC-AUC 1.0000 (rounded)
  - `artifact_sha256` in the manifest was verified to match the real
    artifact file's computed hash.
- `scripts/evaluate_liar_candidate.py` completed against this exact
  candidate: 790 eligible binary-mapped LIAR test samples (477 excluded as
  `barely-true`/`half-true`), **accuracy 0.4266, precision 0.4282, recall
  0.9795, F1 0.5959, macro-F1 0.3045** -- i.e. worse than chance on
  accuracy, with the model predicting FAKE on nearly everything. This is
  concrete, measured evidence -- not a caveat added out of caution -- that
  in-domain ISOT performance (>99%) does not transfer to a different
  real-world text distribution. Any report of this system's accuracy MUST
  cite the LIAR number alongside the ISOT number, never the ISOT number
  alone.
- `data/saved_model_artifacts.json` confirmed byte-identical (SHA-256
  match) to the version on `main` throughout -- untouched by any of the
  above.
- Governance test suite (`backend/tests/test_phase9_model_governance.py`):
  previously 1 failed / 2 passed due to a wording mismatch between
  `promote_model.py`'s unconditional confirmation message and the test's
  assertion (the message did not contain the literal word "required",
  even though it correctly blocked promotion). Fixed by making the two
  blocking messages in `promote_model.py` consistent -- both now state
  that confirmation/approval is "required" -- without changing the
  underlying safety behavior. Now 3/3 passing. A second, previously-dead
  approval check (unreachable because the unconditional gate above it
  already guarantees `--approve` is set) was documented in place rather
  than removed, as defense-in-depth.
