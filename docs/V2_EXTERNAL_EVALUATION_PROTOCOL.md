# TruthLens V2.1 — External evaluation protocol (frozen v1)

**Status:** research evaluation only. Do not merge to production, deploy, change
thresholds, or use the 56 development fixtures to select a model.

This protocol evaluates an untouched evidence-grounded benchmark independently
of `data/v2/eval_fixtures.json`. The executable protocol is
`scripts/v2ExternalEvaluate.ts`; the compact recorded output is
`data/v2/external_eval_results.json`.

## 1. Dataset and immutable inputs

Dataset: **SciFact development split**, all 300 claims and all 5,183 scientific
abstracts. SciFact supplies SUPPORT and CONTRADICT evidence rationales and cited
papers for which annotators found no evidence. This supports document retrieval,
rationale-level NLI, NEUTRAL evaluation, and claim-level decisions.

The public data are provisioned out of band because benchmark inputs are not
committed to this repository:

```bash
npm run external:v2-data
```

The provisioner uses commit-pinned mirror
`vidi-deshp12/scifact-claim-verification@051b5245aa9d4b98c1302920cc5e4958b9e30ef9`
and rejects bytes that do not match:

| File | SHA-256 |
|---|---|
| `claims_dev.jsonl` | `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217` |
| `corpus.jsonl` | `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62` |

No claim, label, rationale, or hard case is edited or removed. The primary run is
all 300 dev claims sorted by numeric claim ID. `--max-claims=N` exists only for
smoke tests and must not be presented as the primary result.

## 2. Frozen mappings

| SciFact annotation | Passage NLI gold | Final-verdict gold |
|---|---|---|
| `SUPPORT` rationale | `SUPPORTS` | `VERIFIED` |
| `CONTRADICT` rationale | `REFUTES` | `REFUTED` |
| cited document with no evidence annotation | `NEUTRAL` | — |
| claim with empty `evidence` | — | `INSUFFICIENT_EVIDENCE` |

A directional passage is exactly the concatenation, in annotation order, of
one gold rationale's sentence indices. A NEUTRAL passage is the full abstract
of a `cited_doc_id` for which SciFact records no evidence. Unjudged retrieval
negatives are **not** silently assigned NEUTRAL.

SciFact papers do not have publisher-domain URLs. Each document is therefore
mapped reproducibly to the reserved locator
`https://scifact-<doc_id>.test/abstract`. This treats each paper as one
independent evidence unit for the existing domain-cluster policy without
pretending the locator is a real source URL. This benchmark mapping is stated in
every result and must not be reused as live-news provenance.

The LIAR prior is marked unavailable so it cannot affect external calibration.
All `DEFAULT_DECISION_THRESHOLDS` remain unchanged.

## 3. Retrieval and reranking

A corpus-source boundary first runs global BM25 over all 5,183 title+abstract
documents and returns the top 25 for each of the existing three deterministic
query expansions. The unchanged V2 hybrid retriever then applies BM25+dense RRF,
URL deduplication, final top-12 selection, unchanged reranking, NLI, and decision
policy. Exact-text embedding memoization avoids duplicate inference but changes
no vectors or scores.

This two-stage design is explicit: V2's `EmbeddingModel.embed()` is a synchronous,
non-batched adapter and is not a practical exhaustive dense index. Accordingly,
the report includes both candidate recall and final Recall@5.

Metrics:

* **Lexical candidate recall:** fraction of evidence-bearing claims for which a
  gold document appears in any top-25 candidate set.
* **Evidence Recall@5:** fraction of evidence-bearing claims with at least one
  gold evidence document in final top five.
* **Evidence precision@5:** micro fraction of final top-five documents that are
  gold evidence, over evidence-bearing claims only.
* **NLI accuracy/macro-F1:** fixed `SUPPORTS`, `REFUTES`, `NEUTRAL` classes over
  all judged rationale/cited-no-evidence passages. `UNCLEAR` is an error for the
  gold class and is not added as a zero-support macro class.
* **Final accuracy/macro-F1:** fixed `VERIFIED`, `REFUTED`,
  `INSUFFICIENT_EVIDENCE`. A predicted `CONFLICTED` is wrong on SciFact because
  SciFact has no conflicted gold class.
* **Coverage:** non-abstained fraction (`VERIFIED` or `REFUTED`).
* **Abstention:** `INSUFFICIENT_EVIDENCE` or `CONFLICTED` fraction.
* **HC precision and HC coverage:** correctness and all-claim coverage at the
  pre-existing 0.75 confidence threshold.
* **Calibration:** five-bin ECE, matching the V2 development harness.
* **Resources:** wall runtime, process peak/ending RSS, model bytes, platform,
  Node version, and CPU count.

## 4. Models and adapter isolation

The default sealed xsmall run:

```bash
npm run eval:v2-external -- \
  --output=artifacts/v2-review/external-scifact-xsmall-full.json
```

The sealed comparison-only DistilBERT model is provisioned without adding it to
`ALL_MODEL_MANIFESTS` or the default resolver:

```bash
npm run download:v2-eval-model
npm run eval:v2-external -- \
  --nli-model-id=Xenova/distilbert-base-uncased-mnli \
  --output=artifacts/v2-review/external-scifact-distilbert-full.json
```

The worker and `PretrainedNliAdapter` accept additive model-id/dtype/identity
options, but the `EmbeddingModel` and `NliAdapter` interfaces are unchanged.
The V2.1 default remains `Xenova/nli-deberta-v3-xsmall`.

Any other locally provisioned Transformers.js sequence-classification model can
be evaluated with:

```bash
npm run eval:v2-external -- \
  --nli-model-id=<local model id> \
  --nli-dtype=q8 \
  --nli-version=<content seal>
```

The harness validates that `id2label` includes entailment, contradiction, and
neutral by name. It reads label names rather than assuming class order.

## 5. Base and MNLI+FEVER candidates

Two candidates remain specifically recommended for a future sealed run, not
assumed winners:

1. `Xenova/nli-deberta-v3-base`, revision
   `80a99030ce45a69a39ea2a6f50756d03859ff521`, generic SNLI+MNLI family. The
   observed q8 ONNX SHA-256 is
   `9d83d9d0ba179cab8b78b942dcc42756da7712b2bbe101a2a4c25fdfa7968e2f`.
   It is larger than xsmall but is not fact-verification trained; size alone is
   not evidence that it fixes evidence-passage behavior. The Xenova mirror's
   redistribution license also needs explicit resolution.
2. `Xenova/DeBERTa-v3-base-mnli-fever-anli`, revision
   `72a1ce83a0144efaf828b3c3844320a61197a53d`. Its MNLI+FEVER+ANLI training is a
   better task-fit hypothesis, but it must be evaluated on **SciFact**, not
   FEVER, to avoid evaluating on a training-family benchmark. FP32 and q8 must
   be identified separately; quantization is not assumed lossless.

Neither model had a complete content-sealed local Transformers.js file tree in
this evaluation environment, so neither receives invented metric cells. Once
provisioned, run this exact protocol without threshold changes, add the result
to the comparison table, and only then consider a model swap.

## 6. Interpretation constraints

SciFact is scientific-abstract verification, not live-news verification. Also,
178 of its 188 directional claims have exactly one gold evidence document,
while the unchanged TruthLens policy requires two independent directional
sources. Final verdict coverage therefore measures a real policy/task mismatch
in addition to retrieval and NLI. Rationale-level NLI is the cleaner model-fit
measurement; final metrics remain necessary because they expose system behavior.

Do not tune thresholds on SciFact and then report SciFact as untouched. If
threshold or policy work begins, split off a calibration set and reserve a new
unseen test set first.
