# Phase 9 — Model Governance

Phase 9 establishes a canonical real-data candidate workflow without changing the production model.

## Flow

1. Phase 2 prepares leakage-aware ISOT splits.
2. `scripts/train_isot_canonical.py` trains a versioned candidate.
3. The candidate is written under `artifacts/models/<version>/`.
4. `scripts/evaluate_liar_candidate.py` performs LIAR out-of-domain validation.
5. A human reviews the manifest and validation evidence.
6. Only an explicit promotion command can replace `data/saved_model_artifacts.json`.
7. Promotion creates a hashed backup and an audit event.

Normal training never writes the production artifact.

## Commands

```bash
python scripts/train_isot_canonical.py --variant raw
python scripts/evaluate_liar_candidate.py --model-version <VERSION>
python scripts/promote_model.py --model-version <VERSION> --approve --yes
```

Promotion remains intentionally blocked unless the candidate manifest is explicitly marked `production_eligible: true`. External validation alone does not make that decision.

The candidate manifest records dataset hashes, a deterministic fingerprint, split configuration, preprocessing, model configuration, calibration, metrics, artifact hash, and git commit.

High ISOT benchmark performance is not evidence of real-world fake-news detection accuracy; LIAR is retained as an out-of-domain check and further validation is required.

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
