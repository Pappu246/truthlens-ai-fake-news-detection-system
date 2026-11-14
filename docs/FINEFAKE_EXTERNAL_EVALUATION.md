# FineFake external article evaluation — intake and safety contract

## State

**Not yet measured.** The FineFake source archive is distributed through the dataset authors' Google Drive link as a pickle-containing download. The source repository README does not publish a signed SHA-256 digest. This repository must not automatically unpickle the dataset in CI, and this document does not claim a FineFake result or source-independent validation.

Official source: https://github.com/Accuser907/FineFake
Official dataset link: https://drive.google.com/file/d/16D9ix7ZOisa4VVBznBTBcv1N7TA-jodH/view

## Safe intake sequence

1. Obtain the archive from the official repository's linked source and save it outside the repository working tree.
2. Run the metadata-only audit. It computes a SHA-256 and, for ZIP archives, lists member names and declared sizes without extraction or pickle loading:

   \`\`\`bash
   python scripts/audit_finefake_archive.py --archive /path/to/FineFake.zip --output /path/to/FineFake.archive-audit.json
   \`\`\`

3. Review the source path, archive size, member listing and digest before using the file. A locally computed digest identifies exact bytes but does not by itself authenticate the publisher. Keep the audit report and pin the reviewed archive SHA-256 in the dataset intake manifest.
4. Review the dataset usage terms/permission before conversion and record the outcome in the sidecar manifest. Only after provenance and usage review, convert the DataFrame in a trusted, isolated environment. Do not run pickle deserialization on an unreviewed archive, and do not perform this conversion in GitHub Actions. Export only text, binary label, fine-grained label, platform, topic, and date; the evaluator rejects author, comment, image, knowledge, and other extra columns. Do not commit the raw archive or article texts to this repository.
5. Beside the converted CSV, create a sidecar manifest named finefake_text_only.csv.manifest.json:

   \`\`\`json
   {
     "dataset": "FineFake",
     "official_repository": "https://github.com/Accuser907/FineFake",
     "source_archive_sha256": "<64-character reviewed archive SHA-256>",
     "csv_sha256": "<SHA-256 of the exact exported CSV bytes>",
     "row_count": 16909,
     "conversion_method": "trusted_offline_conversion_after_archive_hash_review",
     "usage_permission_reviewed": true,
     "permission_review_note": "Document the source terms reviewed and why this use is permitted."
   }
   \`\`\`

   The expected row count is a reference value from the dataset description, not a substitute for validating the actual exported row count. The evaluator checks the sidecar count and CSV hash against the supplied files.

## Task-matched evaluation

Run this after the research workflow has produced a candidate artifact and verified ISOT/WELFake data are present:

\`\`\`bash
python scripts/evaluate_finefake_candidate.py \
  --candidate-dir artifacts/models/<candidate-model-version> \
  --dataset-csv /path/to/finefake_text_only.csv \
  --dataset-manifest /path/to/finefake_text_only.csv.manifest.json \
  --welfake data/WELFake_Dataset.csv \
  --output artifacts/external-validation/finefake_candidate_evaluation.json
\`\`\`

The evaluator checks the candidate artifact SHA-256 and frozen policy fingerprint, then uses the same runtime scorer and deployed 0.98 fake / 0.35 real thresholds with current out-of-domain abstention behavior. It checks exact text overlap against the full ISOT corpus and WELFake, removes normalized exact matches, deduplicates identical text, and drops conflicting-label duplicate groups. It applies minimum length filters of 300 characters and 50 words.

Only FineFake fine-grained label 0 (real) and label 3 (text-based fake) are task-matched to the text-only classifier. Labels for text-image inconsistency, knowledge inconsistency, image-based fake and other items are excluded. FineFake's binary convention is 0=fake and 1=real; the evaluator cross-checks this against fine-grained labels before mapping to TruthLens' runtime positive class (FAKE=1).

## Interpretation restrictions

- This is an external cross-corpus stress test, not automatically a source-independent test. FineFake lists platforms/publishers, but the current candidate training data do not contain a complete publisher-level registry proving disjointness. The report records source independence as NOT_PROVEN.
- The evaluator writes counts, hashes and aggregate/platform-level metrics only. It does not write article text, authors, comments or image paths.
- The output file finefake_candidate_evaluation.json is deliberately not external_article_validation.json, which scripts/promote_model.py requires. This evaluator always reports production_eligible=false and cannot unlock promotion.
- No metric threshold, production model artifact, deployed alias, or production runtime policy is changed by this work.
