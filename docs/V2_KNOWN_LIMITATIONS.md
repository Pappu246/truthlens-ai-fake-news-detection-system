# TruthLens V2 / V2.1 — Known Limitations & Next Milestone

This is an honest limitations list for the research stack (V2 first slice
**and** the V2.1 pretrained-adapter upgrade). None of these are hidden from,
or smoothed over in, the evaluation output — see
`docs/V2_BENCHMARK_PROTOCOL.md`, `data/v2/eval_results_v2_baseline.json`
(V2 heuristic stack) and `data/v2/eval_results.json` (V2.1 pretrained stack).

## 1. ~~Dense retrieval is a deterministic hashing embedding~~ — RESOLVED IN V2.1

Originally `HashingNgramEmbeddingModel` (signed hashing-trick over char
n-grams) — a legitimate BM25 complement but not a pretrained model.

**V2.1 replacement:** `TransformerEmbeddingModel` —
`Xenova/all-MiniLM-L6-v2` (q8@afdb6f1a, 384-dim, mean-pooled, L2-normalised),
local offline ONNX inference (`docs/V2_MODELS.md`). The original class
remains intact and is used as the explicit *fixture* adapter for lightweight
tests/CI — disclosed in provenance whenever it runs. New, honest caveats
in V2.1: sentence-encoder semantics can drift across ONNX-runtime builds
(tiny float drift), and the model is English-centric.

## 2. ~~Evidence classification is a rule-based lexical adapter~~ — RESOLVED IN V2.1, WITH NEW MEASURED FINDINGS

Originally `HeuristicNliAdapter` (cue-word lexicons; disclosed identity
`truthlens-heuristic-nli / v0.1.0-rule-based`).

**V2.1 replacement:** `PretrainedNliAdapter` —
`Xenova/nli-deberta-v3-xsmall` (q8@3fac2500; base
`cross-encoder/nli-deberta-v3-xsmall`, MNLI), local offline ONNX inference.
No lexical rules exist anywhere in its decision path (see
`docs/V2_MODELS.md` for the two-pass hypothesis selection and the pretrained
relatedness gate policies).

**New measured limitations of the real model (these are why V2.1 currently
abstains MORE, not less — see the exact numbers in
`docs/V2_BENCHMARK_PROTOCOL.md`):**
- **Strict entailment on elliptical snippets.** Strict MNLI refuses to
  entail from second-source passages that omit the subject
  ("Independent reviewers verified and corroborated the 80% reduction") →
  NEUTRAL → single remaining supporting source → policy abstains
  (INSUFFICIENT_EVIDENCE). Correct MNLI behavior; a fact-check
  miscalibration of the dev fixtures, and precisely the phrasing the old
  keyword heuristic was accidentally tuned to (documented here, not hidden).
- **Meta-linguistic denials.** "Denied/debunked the claim as false"
  describe a refutation *event*, and MNLI does not treat them as a
  contradiction of the proposition → fewer REFUTES votes on refutation-style
  reporting. FEVER-NLI–trained cross-encoders target exactly this pattern
  (next milestone).
- **xsmall-class model.** 87 MB int8 was chosen for CPU-only CI; a
  `-base`/FEVER variant is a drop-in upgrade behind the same manifest.

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
testable at all), the V2 numbers describe **pipeline correctness**,
not real-world semantic accuracy against arbitrary phrasing. The V2.1
pretrained run on the same fixtures is the first honest stress test of that
statement — and it shows (lower accuracy, much higher abstention) — both are
reported side by side in `docs/V2_BENCHMARK_PROTOCOL.md`.

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

## 7. (V2.1) Model provisioning depends on pinned third-party mirrors

The sandbox/CI for this project cannot reach `huggingface.co`. Sealed model
files are therefore fetched from content-addressed, pinned GitHub git-blob
mirrors (plus git-blob-SHA attestation and SHA-256 seals — see
`docs/V2_MODELS.md`). If those mirrors disappear, fresh clones must either
reach the canonical Hugging Face repos or supply equivalent mirrors whose
bytes match the recorded seals; verification refuses anything else. Already
provisioned installs are unaffected (models are local files).

## 8. (V2.1) Synchronous facade blocks the request thread during inference

The V2 adapter contracts are synchronous, so V2.1 runs ONNX in a dedicated
worker and blocks the calling thread on `Atomics.wait` (~6 ms embedding,
~35 ms NLI warm on a 2-core box). This is fine for the research endpoint and
the evaluation harness; a throughput-bound deployment would need batching or
a worker pool — a deliberately deferred milestone (the interface stays the
same).

## Explicitly out of scope for the research stack (per task constraints)

Multimodal verification, multilingual support, model retraining, and a
human-review dashboard were explicitly out of scope and are not implemented.

## Recommended next milestone (single, scoped increment)

**Done (V2.1, this milestone):** swapped both placeholder adapters for real
pretrained local models behind the unchanged interfaces, kept the pipeline
architecture frozen, and reported the exact old-vs-new delta.

**Next:** upgrade the NLI cross-encoder to a fact-verification–trained
variant (e.g. a DeBERTa-v3-base MNLI+FEVER-ANLI model, q8 ONNX), add
per-passage gold NLI labels to the fixture generator (so entailment quality
is measured directly, not only through verdicts), then re-run the unchanged
harness and diff against both `data/v2/eval_results_v2_baseline.json` and
`data/v2/eval_results.json`.
