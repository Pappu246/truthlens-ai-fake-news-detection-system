# TruthLens AI — Phase 2 Real-Data Handoff

Generated from the successful GitHub Actions real-data validation run on 2026-09-20.

## Current branch state

- Working branch: ml-upgrade-phase2
- Main branch: not merged
- Production artifact: data/saved_model_artifacts.json unchanged
- Real-data validation workflow: .github/workflows/isot-real-data-validation.yml
- Pipeline: scripts/isot_data_pipeline.py
- Synthetic pipeline tests: 17/17 passed
- Real-data validation run: https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/35496731662
- Validation artifact: isot-phase2-validation
- Artifact SHA-256: dcca29fdcea06504fdfecaae01cdf59e34561eebaaf490bd1998b2fca444966a

## Dataset integrity

The workflow downloaded the real Release isot-data-v1 assets and verified their SHA-256 digests before processing.

| File | Bytes | SHA-256 |
|---|---:|---|
| Fake.csv | 62,789,876 | bebf8bcfe95678bf2c732bf413a2ce5f621af0102c82bf08083b2e5d3c693d0c |
| True.csv | 53,582,940 | ba0844414a65dc6ae7402b8eee5306da24b6b56488d6767135af466c7dcb2775 |

Expected schema: title,text,subject,date.

## Measured dataset statistics

These numbers are measured from the real files by the pipeline; they are not estimates.

- FAKE rows: 23,481
- REAL rows: 21,417
- Total rows: 44,898
- Empty text: 631
- Very-short text (<60 chars): 246
- Exact duplicate extra rows beyond first occurrence: 5,795
- Unparseable dates: 10

### Subject leakage

- FAKE subjects: Government News, Middle-east, News, US_News, left-news, politics
- REAL subjects: politicsNews, worldnews
- Subject overlap: none
- Therefore, the subject field is fully disjoint by label and must not be used as a model feature.

### Reuters leakage

- Strict Reuters dateline matches: 18,618
- (Reuters) mentioned in first 100 chars: 21,116
- Strict Reuters dateline among REAL: 86.93%
- Strict Reuters dateline among FAKE: 0.00%

This is a major dataset/source-style signal. Any training/evaluation comparison must document whether Reuters/dateline cues are present in the text, and a debiased experiment should be considered.

### Near duplicates

Configuration:
- MinHash permutations: 128
- Shingle size: 5 words
- LSH Jaccard threshold: 0.7

Measured:
- Near-duplicate groups with >1 article: 5,401
- Articles in near-duplicate groups: 12,133
- Largest group: 631
- Cross-label near-duplicate groups: 2

### Leakage-safe random split

Target fractions: train 70%, validation 15%, test 15%.

Actual group-aware split:
- Train: 31,428 (REAL 14,917; FAKE 16,511)
- Validation: 6,735 (REAL 3,222; FAKE 3,513)
- Test: 6,735 (REAL 3,278; FAKE 3,457)
- Near-duplicate groups crossing split boundaries: 0

### Temporal split

Cutoff: 2017-01-01.

- Temporal train: 19,198 (REAL 4,720; FAKE 14,478)
- Temporal test: 25,690 (REAL 16,697; FAKE 8,993)
- Excluded undated rows: 10

The temporal split is strongly class-imbalanced, so report per-class metrics and do not compare it to the balanced random split without making the difference explicit.

## Exact next phase for Claude

1. Keep all work on ml-upgrade-phase2. Do not merge into main.
2. Build a Phase 2 training/evaluation script that consumes the group-aware split IDs produced by scripts/isot_data_pipeline.py.
3. Do not use subject as a feature.
4. Avoid training on date as a shortcut feature unless explicitly testing a date-robustness experiment.
5. Evaluate at least:
   - title-only baseline
   - text-only TF-IDF baseline
   - title+text TF-IDF baseline
   - a debiased text experiment that removes obvious Reuters dateline/source-style cues
6. Use group-aware random test as the primary leakage-safe benchmark.
7. Also evaluate the 2017 temporal test separately.
8. Report accuracy, precision, recall, F1, confusion matrix, and class-wise metrics. Do not fabricate or pre-fill values.
9. Save new model artifacts separately from data/saved_model_artifacts.json until results are reviewed.
10. Add automated tests for the training/evaluation utilities and keep CI green.
11. After real metrics are generated, create a concise model-comparison report and only then decide whether a new production artifact should replace the existing one.

## Important caution

The current pipeline is a data preparation and validation pipeline only. A successful validation run does not prove the current model has improved. Model quality must be established by the real-data experiments above.

## Reference files

- scripts/isot_data_pipeline.py
- backend/tests/test_isot_pipeline.py
- .github/workflows/isot-phase2-tests.yml
- .github/workflows/isot-real-data-validation.yml
- docs/DATA_SOURCES.md

The generated validation artifact contains stats.json, the full manifest, split ID files, and the source checksum report.
