# SciFact Official Evaluation Protocol

## Scope

This research-only adapter evaluates the TruthLens V2 open-retrieval pipeline on the frozen SciFact dev split (300 claims, 5,183 corpus abstracts). It emits predictions in the official SciFact submission schema and runs the upstream SciFact evaluator.

It does not change production models, thresholds, retrieval settings, verdict policy, or deployment behavior.

## Pinned inputs

- Claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- Corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`
- NLI model: `Xenova/nli-deberta-v3-xsmall`, hash-verified through the repository model manifest
- Embedding model: `Xenova/all-MiniLM-L6-v2`, hash-verified through the repository model manifest
- Official evaluator: `allenai/scifact-evaluator` commit `66feffc5b2cc9e28e3ce3b8c9e824c3c642981eb`
- Evaluator license: Apache-2.0

The workflow first runs the upstream evaluator's own 10-claim fixture and compares all metrics with the upstream expected JSON before scoring the full dev split.

## Prediction protocol

1. Retrieve from the complete frozen 5,183-document corpus using the normal V2 BM25+dense retrieval and reranking path. Gold evidence IDs and rationale labels are not supplied to retrieval.
2. Run the sealed local NLI model on the retrieved candidate passages.
3. For directional evidence only, map `SUPPORTS` to `SUPPORT` and `REFUTES` to `CONTRADICT`. `NEUTRAL` and `UNCLEAR` documents are omitted from the official prediction.
4. For each predicted abstract, rank its original abstract sentences by cosine similarity between the claim embedding and sentence embeddings. Emit the top three sentence indices, with deterministic index-order tie breaking.
5. Score the resulting 300 ordered predictions with the pinned upstream evaluator.

The rationale selector receives only the claim text, original abstract sentences, and embedding vectors. It does not receive gold rationale sentence indices or labels. It is a simple, auditable sentence-selection baseline, not a trained rationale model.

## Reported official metrics

The upstream evaluator reports precision, recall, and F1 for:
- abstract label-only
- abstract rationalized
- sentence selection
- sentence selection plus label

These metrics are not interchangeable with the custom directional accuracy or retrieval hit-rate diagnostics in `v2ScifactEndToEnd.ts`. Keep them separate in reports.

## Limitations

- This is one frozen public dev split, not a blind holdout.
- Sentence ranking uses semantic similarity and may miss compositional evidence requiring multiple sentences.
- The NLI label is assigned at abstract level; the rationale selector is a separate embedding-based component.
- Passing the official scorer does not imply production readiness or global real-world accuracy.
- The independently blind, human-annotated Open-Web holdout remains a separate Phase 2 exit requirement.
