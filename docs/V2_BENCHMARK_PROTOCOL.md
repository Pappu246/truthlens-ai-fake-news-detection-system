# TruthLens V2 — Evaluation Protocol (Phase 9 / Phase 12)

> This is a **development/evaluation protocol for the first vertical slice**,
> not a world-level benchmark, and it is never used to claim a global
> accuracy figure. See `docs/V2_KNOWN_LIMITATIONS.md` for why the numbers
> below should be read as "pipeline correctness on a small, self-consistent
> fixture set", not "real-world semantic accuracy."

## Dataset

* File: `data/v2/eval_fixtures.json`
* Generator (fully reproducible): `scripts/generate_v2_eval_fixtures.ts`
  (`npm run generate:v2-fixtures`)
* 56 claims across 8 categories: politics, science, technology, finance,
  health, climate, history, current events (7 each).
* Each fixture: `id`, `domain`, `claim`, `gold_verdict`
  (`VERIFIED`/`REFUTED`/`INSUFFICIENT_EVIDENCE`/`CONFLICTED`),
  `gold_evidence_reference` (`{url, title, publisher}` or `null` when no
  single reference URL applies), `evidence_explanation`, and a small
  `corpus` of 1-3 documents (clearly synthetic, not scraped real articles)
  that the pipeline retrieves over via `FixtureCorpusSource`.
* Verdict distribution: 17 VERIFIED, 15 REFUTED, 16 INSUFFICIENT_EVIDENCE,
  8 CONFLICTED.

## Running the evaluation

```
npm run eval:v2                     # V2.1 pretrained adapters (needs npm run download:v2-models first)
npm run eval:v2 -- --mode=fixture   # V2 baseline: heuristic research adapters (no models needed)
```

Runs `server/v2/pipeline.ts#verifyClaimV2()` once per fixture, entirely
offline (no network call — the corpus source is the fixture's own
documents), and writes `data/v2/eval_results.json`. Both modes run the
IDENTICAL harness, fixtures, and metrics code; only the intelligence
adapters differ, and the mode + adapter identities are recorded inside the
results file itself (`adapter_mode`, `adapters`).

## Metrics reported (Phase 9)

1. **Verdict accuracy + macro-F1 + per-class precision/recall/F1** across the
   4-way verdict space (`multiClassAccuracyF1`).
2. **Evidence Recall@5** — computed ONLY over the 32/56 fixtures that carry a
   single `gold_evidence_reference` URL (VERIFIED/REFUTED fixtures). The
   remaining 24 (INSUFFICIENT_EVIDENCE/CONFLICTED) fixtures do not have one
   "correct" URL by construction and are excluded from this specific metric
   — the harness prints exactly how many fixtures were excluded and why,
   rather than silently scoring them.
3. **Evidence precision** — fraction of evidence items that were given a
   voting label (SUPPORTS/REFUTES) and came from an on-topic document, vs.
   an intentionally off-topic distractor document. Measures whether
   classification correctly avoids putting words in an irrelevant source's
   mouth.
4. **High-confidence precision + coverage together, always** — see
   `highConfidencePrecisionWithCoverage()`. Coverage is always printed next
   to precision; there is no code path that reports one without the other.
5. **Abstention rate** — fraction of fixtures where the pipeline returned
   `INSUFFICIENT_EVIDENCE` or `CONFLICTED`.
6. **Calibration (Expected Calibration Error)** — 5 equal-width confidence
   bins comparing average stated confidence to actual accuracy in that bin.
7. **NLI accuracy/F1** is exercised directly in `scripts/v2PipelineTests.ts`
   scenario-by-scenario (fixture-level SUPPORTS/REFUTES/NEUTRAL/UNCLEAR
   assertions) rather than aggregated numerically here, since the dev fixture
   set does not carry per-passage gold NLI labels (only claim-level gold
   verdicts) — adding those is listed as a natural extension, not silently
   assumed.

## Results snapshot — V2 (baseline, heuristic research adapters)

`data/v2/eval_results_v2_baseline.json` — adapters:
`truthlens-hashing-ngram-embedding` + `truthlens-heuristic-nli`.

| Metric | Value |
|---|---|
| Verdict accuracy | 83.9% (47/56) |
| Verdict macro-F1 | 0.734 |
| VERIFIED precision / recall | 1.00 / 0.94 |
| REFUTED precision / recall | 1.00 / 0.93 |
| INSUFFICIENT_EVIDENCE precision / recall | 0.64 / 1.00 |
| CONFLICTED precision / recall | 1.00 / 0.13 |
| Evidence Recall@5 | 100% (n=32 gold-referenced fixtures) |
| Evidence precision | 100% (TP=78, FP=0) |
| High-confidence (≥0.75) precision | 100% |
| High-confidence coverage | 48.2% (27/56) |
| Abstention rate | 46.4% |
| Calibration ECE | 0.394 |

**Read this honestly, not triumphantly:** `CONFLICTED` recall is weak
(0.13) — the heuristic NLI adapter struggles to land two independent
passages confidently on opposite sides, which is exactly the failure mode
documented in `docs/V2_KNOWN_LIMITATIONS.md`. `INSUFFICIENT_EVIDENCE`
precision (0.64) means the system abstains somewhat more often than the
gold label strictly requires — an acceptable, disclosed bias for a system
whose design goal is to prefer abstention over a wrong directional verdict.
Nothing here is used to claim 99% accuracy, and nothing here is claimed to
generalise beyond this fixture set.

## Results snapshot — V2.1 (pretrained ONNX adapters)

`data/v2/eval_results.json` — adapters: `Xenova/all-MiniLM-L6-v2`
(q8@afdb6f1a) + `Xenova/nli-deberta-v3-xsmall` (q8@3fac2500), local offline
ONNX inference. Identical harness, fixtures, metrics, decision policy.

| Metric | V2 baseline | V2.1 pretrained | Delta |
|---|---|---|---|
| Verdict accuracy | 83.9% (47/56) | **41.1% (23/56)** | −42.8 pt |
| Verdict macro-F1 | 0.734 | **0.302** | −0.433 |
| VERIFIED precision / recall | 1.00 / 0.94 | 1.00 / 0.24 | −0.70 recall |
| REFUTED precision / recall | 1.00 / 0.93 | 1.00 / 0.20 | −0.73 recall |
| INSUFFICIENT_EVIDENCE precision / recall | 0.64 / 1.00 | 0.33 / 1.00 | −0.31 precision |
| CONFLICTED precision / recall | 1.00 / 0.13 | 0.00 / 0.00 | −0.13 recall |
| Evidence Recall@5 | 100% (n=32) | 100% (n=32) | ±0 |
| Evidence precision | 100% (TP=78, FP=0) | 91.5% (TP=43, FP=4) | −8.5 pt |
| High-confidence (≥0.75) precision | 100% | 100% | ±0 |
| High-confidence coverage | 48.2% (27/56) | 12.5% (7/56) | −35.7 pt |
| Abstention rate | 46.4% | 87.5% | +41.1 pt |
| Calibration ECE | 0.394 | 0.353 | −0.041 (better) |

**Honest reading (this is the report, not a marketing slide):** the real
pretrained stack is *worse than the heuristic slice on this dev set on the
headline metrics, and that is expected and disclosed*. Three mechanisms,
each verified per-fixture rather than inferred:

1. **The baseline was partially fit to the fixtures.** The fixture corpora
   reuse the same cue vocabulary ("confirmed", "verified", "debunked",
   "refuted") that the heuristic NLI adapter fires on — a known, previously
   documented self-consistency bias (limitation #3 above). The pretrained
   model ignores that vocabulary channel entirely.
2. **Strict MNLI ≠ fixture-corpus semantics.** Second-source corroboration
   in the fixtures is frequently elliptical and omits the subject
   ("Independent reviewers verified and corroborated the 80 percent
   reduction"); strict cross-encoder entailment between that passage and the
   claim propositions is *neutral* — so the second vote needed for a
   VERIFIED verdict (policy: ≥2 independent domains) never materialises, and
   the pipeline abstains. Likewise, meta-linguistic denials ("denied the
   claim as false") read as neutral to an MNLI model. This is not a defect
   the adapter can paper over without tuning to the dev set (which would be
   leakage); it is a model/task-fit finding.
3. **Precision-of-verdicts is preserved; coverage collapses.** When the
   real stack DOES reach a verdict, it is still right (precision 1.00 on
   VERIFIED/REFUTED; high-confidence precision 100% unchanged), and
   calibration improved (ECE 0.353 < 0.394). The cost is recall/coverage:
   abstention rose to 87.5%. Evidence Recall@5 (retrieval side) held at
   100%, confirming the regression is *classification-side*, not retrieval.

**Conclusion carried into the next milestone:** keep the V2.1 pretrained
adapters as the honest default (fixture mode remains available for CI and as
the recorded baseline), and upgrade the cross-encoder to a
fact-verification–trained model (MNLI+FEVER family) — see
`docs/V2_MODELS.md` and `docs/V2_KNOWN_LIMITATIONS.md`.

## Regenerating / extending

* `npm run generate:v2-fixtures` regenerates `data/v2/eval_fixtures.json`
  deterministically from `scripts/generate_v2_eval_fixtures.ts`.
* `npm run eval:v2` re-runs the evaluation and overwrites
  `data/v2/eval_results.json`.
* `npm run test:v2` runs the 15 required deterministic pipeline scenarios
  (`scripts/v2PipelineTests.ts`) — strong support, strong refute, neutral,
  unclear, conflicting, multiple independent agreeing sources, duplicate
  sources, stale evidence, insufficient evidence, malicious/injected
  content, SSRF attempts, provenance completeness, abstention behaviour, and
  LIAR-model disagreement. Runs in explicit fixture mode (no model files
  needed).
* `npm run test:v2-route` boots the real Express app and exercises the new
  `POST /api/v2/evidence/verify` endpoint and the additive `/api/health`
  field, without asserting network-dependent retrieval outcomes. Also
  explicit fixture mode.
* `npm run download:v2-models` provisions the sealed V2.1 model files, then
  `npm run test:v2-models` runs the pretrained-adapter suite (`scripts/v2ModelTests.ts`):
  seal/hash verification, embedding determinism + semantics, NLI schema
  invariants + label semantics, fail-closed policy checks, and end-to-end
  adversarial paths (malformed/conflicting/insufficient evidence, prompt
  injection, provenance completeness) under the real models. This suite
  fails loudly when the sealed files are absent — it never substitutes the
  heuristic adapters.
