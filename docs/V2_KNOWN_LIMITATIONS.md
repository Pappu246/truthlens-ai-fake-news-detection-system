# TruthLens V2 — Known Limitations & Next Milestone

This is an honest limitations list for the first vertical slice. None of
these are hidden from, or smoothed over in, the evaluation output — see
`docs/V2_BENCHMARK_PROTOCOL.md` and `data/v2/eval_results.json`.

## 1. Dense retrieval is a deterministic hashing embedding, not a pretrained model

`server/v2/retrieval/embeddings.ts#HashingNgramEmbeddingModel` builds a
signed hashing-trick vector over character n-grams. It captures fuzzy /
sub-word lexical overlap, which is a legitimate complement to exact-token
BM25 — but it is **not** a pretrained sentence-transformer embedding and will
not capture synonym-level semantics (e.g. "automobile" vs "car"). This
design was chosen deliberately so retrieval is 100% reproducible offline,
requires no model download, and needs no paid API key for local/CI testing —
a hard constraint of this task.

**Next milestone:** swap in a local sentence-embedding model (e.g. an
ONNX/transformers.js encoder) behind the existing `EmbeddingModel` interface.
No other retrieval/rerank code needs to change.

## 2. Evidence classification is a rule-based lexical adapter, not a pretrained NLI model

`server/v2/nli/heuristicNliAdapter.ts` classifies SUPPORTS/REFUTES/NEUTRAL/
UNCLEAR using cue-word lexicons, topical token overlap, and the existing
numeric/temporal consistency checks — not a transformer entailment model.
This is explicitly disclosed via `modelName`/`modelVersion` on every
classification (`truthlens-heuristic-nli` / `v0.1.0-rule-based`) so no
consumer of the API can mistake it for a real NLI model's output.

Concretely, this heuristic:
- Cannot handle negation/scope robustly (`"officials confirmed the claim is
  false"` is handled via an explicit asymmetric-weighting rule that treats
  refutation vocabulary as the stronger signal, but more complex negation
  patterns will still be misread).
- Cannot detect entailment that requires world knowledge or multi-hop
  reasoning.
- Performs worst on the `CONFLICTED` class in the evaluation set (see
  `docs/V2_BENCHMARK_PROTOCOL.md`) because `CONFLICTED` requires two
  independent passages to land confidently on *opposite* sides — a heuristic
  is more likely to end up with one confident side and one `NEUTRAL`/
  `UNCLEAR` passage instead.

**Next milestone:** swap in a real local entailment model (e.g. a
DeBERTa/BART-MNLI style cross-encoder run via ONNX) behind the existing
`NliAdapter` interface. No other classification/decision code needs to
change; `ClassifiedEvidence.nli.modelName/modelVersion` already exists to
carry the new model's identity through provenance.

## 3. The evaluation fixture set is small, synthetic, and self-consistent — not a benchmark

`data/v2/eval_fixtures.json` (56 claims) pairs each claim with a small,
hand-authored corpus whose language is written to plausibly resemble real
reporting patterns. It is not scraped from real outlets, and is not a
world-level or externally validated benchmark. Its purpose is narrowly to
validate that the pipeline's plumbing (query expansion → retrieval → rerank
→ classify → aggregate → abstain → provenance) behaves correctly end to end,
and to give a reproducible number to diff future changes against. See the
explicit `dataset_type: "DEVELOPMENT_EVALUATION_SET_NOT_A_BENCHMARK"` field in
the file itself, and the printed banner in `scripts/v2Evaluate.ts`.

Because the fixture corpus text is written with the heuristic NLI adapter's
cue lexicon in mind (it has to be, for a rule-based adapter to be
testable at all), the evaluation numbers describe **pipeline correctness**,
not real-world semantic accuracy against arbitrary phrasing. This is called
out explicitly rather than left implicit.

## 4. Live retrieval depends on outbound network access

`LiveEvidenceProviderCorpusSource` wraps the existing production
`evidenceProvider` (Google News RSS + Wikipedia). In network-restricted
environments (including this development sandbox) it returns zero
candidates, and the pipeline correctly abstains with `INSUFFICIENT_EVIDENCE`
rather than fabricating results — this is exercised directly in
`scripts/v2RouteTests.ts`.

## 5. Full-text enrichment is implemented but disabled by default

`server/v2/retrieval/fullTextEnricher.ts` can fetch and extract full article
bodies (reusing the existing SSRF-safe `safeFetchHtml` and
`extractArticleFromHtml`), but it is off by default (`enableFullTextEnrichment:
false`) for the first vertical slice, which runs on headlines/snippets only
and labels them honestly (`contentType: 'HEADLINE_ONLY' | 'SUMMARY'`) rather
than pretending a headline is a full article.

## 6. Calibration is weak in the small evaluation set

The evaluation harness's Expected Calibration Error (~0.39 on the 56-fixture
set) is not low. Confidence is currently a hand-tuned formula
(`server/v2/decision/decisionPolicy.ts`), not a calibrated probability. A
future milestone should fit calibration (e.g. Platt scaling, matching the
existing pattern already used in `server/claimModel.ts`) against a larger,
independently labelled set.

## Explicitly out of scope for this vertical slice (per task constraints)

Multimodal verification, multilingual support, model retraining, and a
human-review dashboard were explicitly out of scope for this milestone and
are not implemented here.

## Recommended next milestone (single, scoped increment)

Swap the two rule-based adapters (`EmbeddingModel`, `NliAdapter`) for real
local pretrained models behind their existing interfaces, re-run
`npm run eval:v2` unchanged, and compare the new numbers against
`data/v2/eval_results.json` from this slice — without touching retrieval
fusion, reranking, decision policy, or provenance, which should remain
stable across that swap.
