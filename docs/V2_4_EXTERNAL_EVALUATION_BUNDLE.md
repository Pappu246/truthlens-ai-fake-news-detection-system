# TruthLens V2.4 — Reproducible External Evaluation Bundle

## Purpose and status

This is research/evaluation infrastructure only. It does not alter production,
`ALL_MODEL_MANIFESTS`, the xsmall model, thresholds, the decision policy,
gold labels, or the unavailable FEVER/ANLI candidate.

The frozen SciFact inputs are **not present in this checkout**. This change
therefore does not report a new raw-vs-enriched result. It supplies a
checksum-verified offline import path and makes both evaluation modes explicit.

## Exact required inputs

`npm run eval:v2-external` requires, under its `--data-dir` (default
`data/external/scifact`):

| File | Frozen SHA-256 | Role |
|---|---|---|
| `claims_dev.jsonl` | `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217` | 300 sorted SciFact dev claims and gold evidence annotations |
| `corpus.jsonl` | `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62` | 5,183 SciFact abstracts |

The frozen protocol expects 469 gold passage judgments. The exact source
identity is recorded in `data/v2/scifact_bundle_manifest.json`:

- dataset: SciFact development split
- source repository: `vidi-deshp12/scifact-claim-verification`
- source commit: `051b5245aa9d4b98c1302920cc5e4958b9e30ef9`
- upstream source file names are unchanged

The manifest deliberately does not invent byte sizes that are not recorded in
the existing protocol. The importer measures local sizes while verifying the
frozen SHA-256 values.

## Offline provisioning

Supply a directory containing exactly the two upstream-named files, then run:

```bash
npm run external:v2-data:offline -- \
  --source=/absolute/path/to/exact/scifact/files
```

The importer:

1. requires both exact file names;
2. hashes each source file before writing anything;
3. refuses any SHA-256 mismatch;
4. refuses to overwrite a recognized destination with different bytes;
5. copies only into the ignored `data/external/scifact/` directory;
6. performs no download, regeneration, transformation, or silent replacement.

No benchmark bytes are committed to Git. The remaining external artifact that
must be supplied is a directory containing those two exact files, obtained from
an approved offline/archive channel. A tarball, object-store item, or release
asset may be used operationally, but it must be unpacked and imported through
the checksum gate above; the archive itself is not trusted by name.

## Models and frozen environment

Evaluation never downloads models. It requires the already sealed local model
tree under `models/v2` (or `TRUTHLENS_V2_MODEL_DIR`) and fails clearly when
xsmall or MiniLM files are unavailable. The model manifests remain the source
of truth for model identity, revision, file sizes, and hashes.

The evaluation keeps these frozen values:

- clock: `2026-09-26T00:00:00.000Z`
- lexical candidates: 25 per expanded query
- evidence K: 5
- high-confidence threshold: 0.75
- default decision thresholds and policy
- LIAR prior: disabled for external calibration
- claims/corpus SHA-256 values above

## Raw versus enriched runs

After the offline data and sealed models are supplied, run separate output
files:

```bash
npm run eval:v2-external -- \
  --evidence-presentation=raw \
  --output=artifacts/v2-review/external-scifact-xsmall-raw.json

npm run eval:v2-external -- \
  --evidence-presentation=enriched \
  --output=artifacts/v2-review/external-scifact-xsmall-enriched.json
```

The enriched presentation is the V2.3 structured input containing only the
existing claim, title, publisher, and deterministic relevant sentence window.
The evaluator records both `raw_passage` and `presented_passage` per gold row.
Retrieval, ranking, NLI model, thresholds, policy, corpus, claims, and clock
are identical between runs.

Each output reports final accuracy/macro-F1, NLI macro-F1 and per-class
SUPPORTS/REFUTES/NEUTRAL metrics, Recall@5, Precision@5, HC precision and
coverage, coverage/abstention, ECE, runtime, and peak RSS.

No enrichment acceptance decision is made from coverage alone. It requires a
reproduced SUPPORTS-recall improvement without material NLI degradation,
precision collapse, or unacceptable calibration regression.

## Verification performed

- `npm run test:all`: passed.
- `npm run test:v2`: passed, including the V2.3 reasoning tests.
- `npm run test:v2-route`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `npm run eval:v2` and `npm run test:v2-models`: failed closed because sealed model files are absent.
- `npm run eval:v2-external -- --evidence-presentation=raw`: failed clearly because the exact SciFact files are absent.

## Current execution status

In this checkout:

- the offline importer and manifest are present;
- raw/enriched evaluation selection is implemented;
- exact SciFact inputs are missing;
- sealed xsmall and MiniLM model files are missing;
- therefore neither external run can honestly be completed here;
- no missing metric is estimated or fabricated.
