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
python scripts/promote_model.py --model-version <VERSION> --yes
```

Promotion remains intentionally blocked unless the candidate manifest is explicitly marked `production_eligible: true`. External validation alone does not make that decision.

The candidate manifest records dataset hashes, a deterministic fingerprint, split configuration, preprocessing, model configuration, calibration, metrics, artifact hash, and git commit.

High ISOT benchmark performance is not evidence of real-world fake-news detection accuracy; LIAR is retained as an out-of-domain check and further validation is required.
