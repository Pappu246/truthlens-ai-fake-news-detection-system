# TruthLens V2.3 — Evidence Reasoning Improvement Report

**Status:** research only; no production change, merge, deployment, threshold change,
or candidate-model retry.

**Production baseline:** `32db8230547658b7d5d2a615599526d88c22fce9`

**Research branch:** `arena/01a0df81-truthlens-ai-fake-news-detecti`

**Evaluation clock:** frozen V2 clock, `2026-09-26T00:00:00.000Z`.

## 1. Executive result

V2.3 adds an optional, deterministic evidence-presentation experiment. The
frozen default remains raw evidence. The new `enriched` mode presents the same
retrieved content as:

```text
[CLAIM]
...
[SOURCE TITLE]
...
[PUBLISHER]
...
[EVIDENCE]
...
```

The enrichment layer copies only values already present in the claim and
retrieved document. It resolves no new facts, performs no web lookup, and
selects a deterministic sentence window using claim-term overlap. The existing
NLI adapter, thresholds, decision policy, abstention rules, retrieval set, gold
labels, and default xsmall model are unchanged.

No SciFact V2.3 experiment was accepted. The required SciFact files could not
be fetched in this environment: both the pinned raw GitHub transport and the
pinned `api.github.com` blob transport failed while provisioning the untouched
claims file. Consequently, this report contains no fabricated V2.3 SciFact
metrics or deltas.

The DeBERTa-v3-base-mnli-fever-anli candidate was not retried.

## 2. Frozen baseline reference

The following is the already-sealed xsmall result recorded in
`data/v2/external_eval_results.json` from the prior frozen SciFact run. It is
reported as the reference baseline; this turn attempted reproduction but could
not re-provision the missing SciFact files, so it is not claimed as a fresh
rerun.

| Metric | xsmall reference |
|---|---:|
| Final accuracy | 0.373333 |
| Final macro-F1 | 0.308484 |
| NLI macro-F1 | 0.542976 |
| SUPPORTS precision / recall / F1 | 0.941176 / 0.296296 / 0.450704 |
| REFUTES precision / recall / F1 | 0.678899 / 0.606557 / 0.640693 |
| NEUTRAL precision / recall / F1 | 0.393617 / 0.847328 / 0.537530 |
| Recall@5 | 0.664894 |
| Precision@5 | 0.135106 |
| HC precision | 0.271739 |
| HC coverage | 0.306667 |
| Coverage | 0.360000 |
| Abstention | 0.640000 |
| ECE | 0.428663 |
| NLI ECE | 0.305776 |
| Gold passage judgments | 469 |
| Claims / corpus documents | 300 / 5,183 |

The recorded baseline has SUPPORTS recall of **29.6%**. This is the primary
error-analysis target, but it is not evidence that changing thresholds is
appropriate. The baseline also has low evidence precision at 5 (13.5%) and
high final ECE (0.429), so coverage-only improvements would not be acceptable.

The prior report contains the corresponding DistilBERT comparison. No values
were copied into a V2.3 experiment, and no candidate values were inferred.

## 3. Phase 2 — reference resolution

### Configuration

- **Changed component:** optional `server/v2/evidenceContext.ts`.
- **Unchanged:** claim extraction, retrieval, reranking, NLI model, thresholds,
  decision policy, abstention, provenance schema, fixtures, labels, and clock.
- **Input:** existing `ExtractedClaim` fields (`entities`, `locations`, `dates`,
  `numbers`, and `keywords`) plus existing document `title`, `publisher`, and
  passage text.
- **Selection:** deterministic sentence splitting and maximum token overlap;
  ties choose the earlier sentence; one-sentence radius.
- **Safety:** no entity or date is generated. Missing values are represented as
  `none` only in diagnostics, not inserted into NLI evidence.

The layer preserves the claim, resolved entity strings, title, publisher, and a
relevant sentence window. It is opt-in through
`V2PipelineOptions.evidencePresentation = 'enriched'`.

### Deterministic checks

`scripts/v2EvidenceReasoningTests.ts` verifies:

- stable sentence-window selection;
- claim, title, and publisher preservation;
- no invented subject, date, publisher, or fact;
- identical retrieved-candidate count between raw and enriched modes;
- raw mode remains passage-only;
- enriched mode uses the labelled structured format.

Result: **7 passed**.

## 4. Phase 3 — evidence passage construction

The same pipeline and injected NLI seam can now compare `raw` and `enriched`
presentation without changing the model. The default is explicitly `raw`, so
this is an experiment rather than a behavior change.

A valid SciFact comparison requires the same 300 claims, 5,183 documents, 469
gold passage judgments, same retrieval candidates, same frozen clock, and the
same xsmall files. That comparison was not run because the pinned SciFact data
could not be provisioned in this environment. No raw/enriched SciFact delta is
reported.

The local deterministic harness confirms that only the NLI input string
changes; retrieval and candidate cardinality do not.

## 5. Phase 4 — source-policy analysis

The production policy was not changed. It still requires two independent
sources for a directional final verdict and still abstains when corroboration
is insufficient.

The requested research conditions are defined as:

- **A — current policy:** unchanged two-independent-source decision policy.
- **B — single-gold-aware analysis:** an evaluation-only accounting condition
  that recognizes SciFact's single-gold evidence structure; it must not be
  presented as a production policy or used to alter the decision function.

Condition B was not executed because it requires the untouched SciFact
per-claim/per-passage inputs. It is intentionally not approximated from the
aggregate baseline. Existing evidence indicates the structural issue is real:
the prior protocol records 178 of 188 directional claims with exactly one gold
evidence document, while the production policy requires two independent
sources. That observation is context, not a measured V2.3 improvement.

## 6. Phase 5 — SUPPORTS-focused error analysis

The measured SUPPORTS result is 64/216 recall = **29.6%**. Without the
per-example SciFact data in this run, the following categories remain
hypotheses to measure, not counted causes:

- subject/entity omitted from a retrieved passage;
- date or numerical qualifier omitted;
- paraphrase or lexical mismatch;
- corroboration expressed indirectly;
- evidence granularity mismatch between claim and sentence;
- passage truncation or sentence-window loss.

The new layer is designed to measure the first, second, fourth, fifth, and
sixth categories without adding facts. It does not tune a threshold first and
does not weaken abstention. A future run must emit per-gold-passage rows with
the raw/enriched input, preserved fields, NLI output, retrieval rank, and an
error category assigned from observed text—not from a guessed label.

## 7. Acceptance decision

**No V2.3 reasoning change is accepted for production.** There are no complete
SciFact raw-vs-enriched metrics, no source-policy condition-B measurements, and
no measured support-error category counts in this environment. Increasing
coverage without reliability and calibration measurements would violate the
acceptance criteria.

The enriched mode is therefore research-only and opt-in. The xsmall model,
production resolver, thresholds, decision policy, abstention system, fixtures,
and gold labels remain unchanged.

## 8. Verification and blocked commands

Completed successfully:

- `npm run test:v2` — 61 existing V2 tests plus 7 V2.3 reasoning tests passed.
- `npm run test:v2-route`
- `npm run test:v2-models` — attempted; it correctly failed closed because
  the sealed xsmall and embedding files are absent from this checkout. It did
  not fall back to heuristics.
- `npm run eval:v2 -- --mode=fixture` — existing 56-fixture research harness;
  83.9% accuracy, 0.734 macro-F1, 100% Recall@5 and 0.394 ECE. These are not
  SciFact results and are not used as V2.3 acceptance evidence.
- Type-check and build were run after the changes.
- `npm audit` was run with no high-severity vulnerabilities.

Blocked in this environment:

```text
npm run external:v2-data
  raw.githubusercontent.com: fetch failed
  api.github.com git blob fallback: fetch failed
  Could not fetch claims_dev.jsonl
```

Therefore the external SciFact evaluation could not be honestly rerun this
turn. No production PR, merge, deployment, or candidate-model action was
performed.
