# ISOT Dataset Sources — Phase 2

## Canonical dataset transfer

Phase 2 uses the real ISOT Fake News Dataset CSVs. The repository does **not** commit the raw CSV bytes.

The current transfer is stored as GitHub Release **`isot-data-v1`** in this repository:

- `Fake.csv`
- `True.csv`

Release page:
https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/releases/tag/isot-data-v1

### Integrity metadata

These values come from the GitHub Release asset metadata and are verified again by the Phase 2 CI workflow before the pipeline runs.

| File | Release size | SHA-256 |
|---|---:|---|
| Fake.csv | 62,789,876 bytes | `bebf8bcfe95678bf2c732bf413a2ce5f621af0102c82bf08083b2e5d3c693d0c` |
| True.csv | 53,582,940 bytes | `ba0844414a65dc6ae7402b8eee5306da24b6b56488d6767135af466c7dcb2775` |

Total transfer size: 116,372,816 bytes.

## Expected schema

Both CSVs must have exactly these columns, in this order:

`title,text,subject,date`

The Phase 2 pipeline refuses to continue if the schema differs.

## Validation workflow

`.github/workflows/isot-real-data-validation.yml` downloads both release assets, verifies their SHA-256 digests, runs:

`python scripts/isot_data_pipeline.py`

and uploads the measured `stats.json`, manifest, split ID files, and source checksums as a GitHub Actions artifact.

The raw CSVs are not committed by the workflow.

## Important boundary

No training is performed by this preparation workflow. It does not modify:

`data/saved_model_artifacts.json`

Measured dataset statistics must come from a successful real-data pipeline run; this document intentionally does not hard-code analytical results.
