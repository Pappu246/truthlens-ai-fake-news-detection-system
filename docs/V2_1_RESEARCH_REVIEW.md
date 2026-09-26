# TruthLens V2.1 — research review and external evaluation

**Review date:** 2026-09-26

**Reviewed implementation:** `4dc8da7812408670a63386c35300a8c55bc4a0b0`

**Production baseline:** `32db8230547658b7d5d2a615599526d88c22fce9`

**Disposition:** research only; **do not merge, deploy, or replace the production model**.

## Executive conclusion

The recorded 56-fixture result is exactly reproducible in this environment:
41.1% accuracy, 0.302 macro-F1, 100% high-confidence precision at 12.5%
coverage, 87.5% abstention, ECE 0.353, Recall@5 100%, and the harness's
on-topic voting precision 91.5%. Wall time was 11.97 seconds on 2 CPU cores.

That set is not a retrieval benchmark: every fixture corpus has only one to
three documents and all survive the top-12 pipeline. The 33 wrong fixture
verdicts are overwhelmingly classification/task-fit failures (18 clear NLI
weaknesses, 14 fixture/task mismatches, one aggregation/reranking boundary),
not retrieval misses.

The untouched SciFact dev evaluation changes the conclusion from “precision is
preserved” to “the current full system does not generalize reliably.” On all
300 claims, xsmall reached 37.3% final accuracy, 0.308 macro-F1, 27.2%
high-confidence precision at 30.7% HC coverage, and ECE 0.429. Rationale-level
NLI macro-F1 was 0.543. It was particularly conservative on SUPPORTS: precision
0.941, recall 0.296. This is direct evidence that xsmall is too conservative for
supporting evidence passages, but it is not the only bottleneck: lexical
candidate recall was 80.9%, final Recall@5 was 66.5%, and 178/188 directional
SciFact claims have one gold paper while the unchanged policy requires two.

A second realistic pretrained MNLI candidate,
`Xenova/distilbert-base-uncased-mnli`, was worse on the same frozen run (25.3%
accuracy; NLI macro-F1 0.356; ECE 0.563). Its higher directional coverage did
not produce reliable verdicts. Therefore “a less conservative generic MNLI
model” is not, by itself, supported as the next model change.

## 1. Implementation review

Reviewed end to end:

* model manifests, sealed downloader, local-only worker, synchronous worker
  client, mode/readiness resolution, and model tests;
* dense embedding adapter and hybrid BM25+dense RRF retrieval;
* full-text boundary, sanitization, URL deduplication, reranker/source
  independence, NLI adapter, hypothesis conditioning, relatedness gate,
  aggregation/prior policy, provenance, metrics, route wiring, documentation,
  fixture generator, and both evaluation harnesses;
* unchanged production-path separation in `server/appFactory.ts` and the
  additive `/api/v2/evidence/verify` route.

### What is sound

1. The V2 path remains isolated from the production verdict path.
2. Pretrained mode fails closed when required files are absent; it does not
   silently substitute the heuristic adapter.
3. Model identity/version is emitted in provenance, and the download/test path
   verifies content SHA-256.
4. The worker disables remote models before loading Transformers.js.
5. The LIAR prior cannot create or flip a categorical verdict.
6. Source deduplication and the two-independent-source requirement are
   conservative and auditable.
7. The default thresholds and 56 fixtures were not changed during this review.
8. Model-swap support added by this review is additive: optional worker/model
   identity parameters sit behind the unchanged `EmbeddingModel` and
   `NliAdapter` contracts. The default resolver still selects xsmall.

### Findings

#### High — the 56-fixture retrieval figures do not diagnose real retrieval

`FixtureCorpusSource` returns the complete one-to-three-document corpus and the
retriever keeps up to 12. Recall@5 is therefore structurally easy and cannot
separate retrieval, fusion, or reranking quality. The external run found 80.9%
BM25 candidate recall and 66.5% final Recall@5, demonstrating the gap.

#### High — NLI/model-to-task mismatch dominates the development errors

The adapter misses direct contradictions and many short corroborations, while
meta-linguistic “denied/debunked/no evidence” passages are often not strict
logical contradictions at all. Those are two different issues and should not
be combined into one model score. The SciFact rationale test confirms the model
shape: SUPPORTS recall 29.6%, REFUTES recall 60.7%, NEUTRAL recall 84.7%.

#### High — final-policy metrics are confounded on single-document benchmarks

The unchanged policy requires two independent directional sources. SciFact has
one gold paper for 178 of 188 directional claims. This is intentionally not
“fixed” in the harness; it is reported as a fixture/task mismatch. Per-passage
NLI and retrieval metrics must accompany final verdict metrics.

#### Medium — NLI basis text can state an impossible condition

When pass A has majority NEUTRAL, the adapter falls through to the
attribution-stripped pass B, but its basis says pass A was “undecided
(maxP=...<0.5).” Recorded examples include `maxP=0.999<0.5`. The control flow is
based on “no directional majority,” not `maxP < 0.5`; provenance wording is
incorrect and should be fixed before relying on it in audits.

#### Medium — the documented four-way score sum invariant is false after rounding

Each score is independently rounded to three decimals. In the reviewed 96
fixture passages, 38 score vectors summed to 0.999 or 1.001 rather than exactly
1.0. Labels/confidences were unaffected in the recorded run, but the comment
and schema invariant are overstated.

#### Medium — evaluation freshness is wall-clock dependent

`rerankEvidence()` computes freshness with `Date.now()`. The fixture documents
have fixed publication dates, so rerank weights, confidences, and potentially
threshold crossings drift over time. The run reproduced on the recorded date,
but “fully deterministic” is not strictly true without a frozen evaluation
clock.

#### Medium — evidence precision relies on title naming, not passage judgments

The fixture harness defines relevance as “title does not begin with
`Unrelated`.” `politics-004` (“Political commentary roundup”) and `science-003`
(“Battery hype roundup”) are described by their gold explanations as unrelated,
but are counted as relevant voting evidence. Conversely, the metric does not
measure whether the directional NLI label is correct; it measures only the
on-topic status of a voting document. The 91.5% number is accurately reproduced
but should not be read as NLI precision.

#### Medium — normal provenance omits information needed for NLI error analysis

The adapter computes four-way scores, raw-probability summaries, hypothesis
pass, relatedness gate, and basis, but the provenance record keeps only NLI
label and confidence. Reconstructing this review required an explicit adapter
pass. Per-passage evaluation artifacts now record gold/prediction/confidence,
but production-independent V2 provenance still cannot explain a classification
from its own output alone.

#### Low — runtime readiness is a size check

Default resolution checks file presence and byte size. Full SHA-256 is performed
by the downloader and model tests, not every server start. Documentation should
say “presence/size readiness” rather than imply that every runtime boot rejects
same-size tampering.

#### Low — injected adapter description previously named the default model

`verifyClaimV2()` called `describeActiveAdapters()` even when an experiment
injected another adapter. This review changed only the description path so
provenance names the actual injected adapters; default behavior and decisions
are unchanged.

## 2. Exact 56-fixture reproduction

Command:

```bash
npm run eval:v2
```

| Metric | Recorded | Reproduced |
|---|---:|---:|
| Accuracy | 41.1% (23/56) | 41.1% (23/56) |
| Macro-F1 | 0.302 | 0.302 |
| HC precision (≥0.75) | 100% | 100% |
| HC coverage | 12.5% (7/56) | 12.5% (7/56) |
| Abstention | 87.5% | 87.5% |
| ECE (5 bins) | 0.353 | 0.353 |
| Evidence Recall@5 | 100% (32 claims) | 100% (32 claims) |
| Harness on-topic voting precision | 91.5% (43/47) | 91.5% (43/47) |

The generated timestamp is expected to differ. Metric fields and all 56
predicted verdicts matched.

## 3. Per-fixture analysis

Primary categories below describe the verdict failure. “Masked” means the final
verdict is correct only because conservative aggregation prevented a bad NLI
vote from becoming directional. No gold-referenced fixture had a retrieval miss.

| Fixture | Gold → prediction | Passage labels | Primary category | Analysis |
|---|---|---|---|---|
| politics-001 | VERIFIED → IE | S, N | NLI model weakness | Second explicit 62% corroboration becomes NEUTRAL; only one supporting domain remains. |
| politics-002 | VERIFIED → VERIFIED | S, S | — | Correct two-source support. |
| politics-003 | REFUTED → IE | N, R | Fixture/task mismatch | A denial/reporting passage is treated as gold refutation but is not strict contradiction; one refuting vote cannot pass policy. |
| politics-004 | IE → IE | R | Provenance/data issue (masked) | Off-topic commentary receives REFUTES and is incorrectly counted “relevant” by the title heuristic; one-source policy catches it. |
| politics-005 | CONFLICTED → IE | S, N | NLI model weakness | “Win incorrect and unconfirmed” is not recognized as refuting. |
| politics-006 | VERIFIED → IE | S, N | NLI model weakness | Near-explicit bipartisan passage becomes NEUTRAL. |
| politics-007 | IE → IE | N | — | Correct neutral abstention. |
| science-001 | VERIFIED → IE | S, N | Fixture/task mismatch | Second passage omits the claimed 40-light-year detail. |
| science-002 | REFUTED → REFUTED | R, R | — | Correct two-source refutation. |
| science-003 | IE → IE | R | Provenance/data issue (masked) | Off-topic roundup receives high-confidence REFUTES and is counted relevant because its title lacks the `Unrelated` prefix. |
| science-004 | CONFLICTED → IE | S, N | NLI model weakness | Explicitly disputed size estimate becomes NEUTRAL. |
| science-005 | VERIFIED → IE | S, R | NLI model weakness | Supporting lunar-ice corroboration is spuriously REFUTES. |
| science-006 | REFUTED → REFUTED | R, R | — | Correct two-source refutation. |
| science-007 | IE → IE | N | — | Correct abstention. |
| technology-001 | VERIFIED → IE | S, N | Fixture/task mismatch | Terse teardown passage omits the smartphone-chip referent. |
| technology-002 | REFUTED → IE | N, R | Fixture/task mismatch | Denial/no-evidence language yields only one strict refuting vote. |
| technology-003 | IE → IE | R | NLI model weakness (masked) | Unrelated funding news is spuriously REFUTES; low one-source weight prevents a verdict. |
| technology-004 | CONFLICTED → IE | N, R | NLI model weakness | The positive cyberattack passage becomes NEUTRAL. |
| technology-005 | VERIFIED → IE | S, N | NLI model weakness | Regulator-filing corroboration becomes NEUTRAL. |
| technology-006 | REFUTED → IE | N, N | NLI model weakness | Both direct old-rumor refutations become NEUTRAL. |
| technology-007 | IE → IE | N | — | Correct neutral abstention. |
| finance-001 | VERIFIED → VERIFIED | S, S | — | Correct two-source support. |
| finance-002 | REFUTED → IE | N, R | Fixture/task mismatch | Denial/no-evidence passage is not strict contradiction; only one refuting vote remains. |
| finance-003 | IE → IE | R | NLI model weakness (masked) | Unrelated market roundup is spuriously REFUTES; aggregation catches it. |
| finance-004 | CONFLICTED → IE | N, N | NLI model weakness | Both forecast sides become NEUTRAL. |
| finance-005 | VERIFIED → VERIFIED | S, S | — | Correct two-source support. |
| finance-006 | REFUTED → IE | N, R | NLI model weakness | Fabricated guaranteed-return scheme yields only one weak refuting vote. |
| finance-007 | IE → IE | R | NLI model weakness (masked) | Unrelated bank earnings are spuriously REFUTES; aggregation catches it. |
| health-001 | VERIFIED → IE | S, N | Fixture/task mismatch | Terse “80 percent reduction” passage omits the vaccine referent. |
| health-002 | REFUTED → IE | N, N | NLI model weakness | Two explicit false/refuted clinical passages become NEUTRAL. |
| health-003 | REFUTED → IE | R, N | NLI model weakness | Direct “no effect on diabetes” passage becomes NEUTRAL. |
| health-004 | IE → IE | N | — | Correct neutral abstention. |
| health-005 | CONFLICTED → IE | N, N | Fixture/task mismatch | Methodology dispute does not strictly negate rising cases; even the positive passage is missed. |
| health-006 | VERIFIED → IE | S, N | NLI model weakness | Independent contamination result becomes NEUTRAL. |
| health-007 | IE → IE | N | — | Correct neutral abstention. |
| climate-001 | VERIFIED → IE | S, N | Fixture/task mismatch | Corroboration omits the “last year” temporal scope. |
| climate-002 | REFUTED → REFUTED | R, R | — | Correct two-source refutation. |
| climate-003 | IE → IE | R | NLI model weakness (masked) | Unrelated regional report is spuriously REFUTES; aggregation catches it. |
| climate-004 | CONFLICTED → IE | N, N | Fixture/task mismatch | “Premature assessment” is not strict negation, while the positive passage is also missed. |
| climate-005 | VERIFIED → VERIFIED | S, S | — | Correct two-source support. |
| climate-006 | REFUTED → IE | N, N | NLI model weakness | Explicitly false/misread timeline passages become NEUTRAL. |
| climate-007 | IE → IE | N | — | Correct neutral abstention. |
| history-001 | VERIFIED → IE | S, N | Fixture/task mismatch | Second passage omits the 1863/date and entity linkage. |
| history-002 | REFUTED → IE | N, N | NLI model weakness | “Decades, not three years” is missed. |
| history-003 | IE → IE | N | — | Correct neutral abstention. |
| history-004 | CONFLICTED → IE | S, R | Aggregation/decision policy (rerank secondary) | Both sides are classified, but rerank-weighted ratio is ~0.585, just below the unchanged 0.60 conflict band; one support source cannot verify. |
| history-005 | VERIFIED → IE | S, N | NLI model weakness | Explicit 1848 corroboration becomes NEUTRAL. |
| history-006 | REFUTED → IE | R, N | Fixture/task mismatch | Second passage says “no evidence” rather than directly establishing occurrence; one weak refuting vote remains. |
| history-007 | IE → IE | N | — | Correct neutral abstention. |
| current-events-001 | VERIFIED → IE | S, N | Fixture/task mismatch | Second passage omits coastal-region/overnight scope. |
| current-events-002 | REFUTED → IE | N, N | NLI model weakness | “Old footage/no riot this week” direct correction becomes NEUTRAL. |
| current-events-003 | IE → IE | N | — | Correct neutral abstention. |
| current-events-004 | CONFLICTED → IE | S, N | NLI model weakness | “Postponed rather than cancelled” is missed as contradiction. |
| current-events-005 | VERIFIED → IE | S, N | Fixture/task mismatch | Second passage omits the 5,000-acre component. |
| current-events-006 | REFUTED → IE | N, R | Fixture/task mismatch | Meta debunk/no-evidence wording gives only one weak refuting vote. |
| current-events-007 | IE → IE | N | — | Correct neutral abstention. |

Abbreviations: IE = `INSUFFICIENT_EVIDENCE`, S = `SUPPORTS`, R = `REFUTES`,
N = `NEUTRAL`.

### Failure-category summary

* **NLI model weakness:** 18/33 wrong verdicts primary, plus four masked false
  refutes on correct IE verdicts.
* **Fixture/task mismatch:** 14/33 wrong verdicts primary. These mostly require
  reference resolution, omitted claim details, or treating a denial/absence of
  evidence as logical contradiction.
* **Aggregation/decision-policy weakness:** 1/33 primary (`history-004`).
* **Reranking weakness:** no standalone primary failure; rerank weighting is a
  secondary cause for `history-004`.
* **Retrieval weakness:** no primary failure is observable in this tiny fixture
  setup; all 32 single-gold URLs were retrieved.
* **Provenance/data issue:** two off-topic documents are miscounted as relevant
  by the title heuristic; NLI scores/basis are absent from normal provenance;
  freshness is not clock-frozen.

## 4. External evaluation results

Protocol: `docs/V2_EXTERNAL_EVALUATION_PROTOCOL.md`. Both runs use identical
SciFact bytes, embedding model, candidate pool, retrieval/reranking, thresholds,
and policy. Only the NLI adapter model changes.

| Model | Final accuracy | Final macro-F1 | NLI macro-F1 | Recall@5 | Precision@5 | HC precision | HC coverage | Coverage | Abstention | ECE | Runtime / peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `Xenova/nli-deberta-v3-xsmall` q8 | **37.3%** | **0.308** | **0.543** | 66.5% | 13.5% | 27.2% | 30.7% | 36.0% | 64.0% | **0.429** | **924.3 s / 1200.9 MB** |
| `Xenova/distilbert-base-uncased-mnli` q8 | 25.3% | 0.295 | 0.356 | 66.5% | 13.5% | **31.1%** | **53.7%** | **57.7%** | **42.3%** | 0.563 | 959.5 s / **1012.1 MB** |

Retrieval values are identical by design because the embedding/retrieval stack
is fixed. “Evidence precision” here is standard gold-document precision@5, not
the development harness's title-based on-topic voting metric.

### Per-passage NLI

| Model | Class | Precision | Recall | F1 | Gold passages |
|---|---|---:|---:|---:|---:|
| xsmall | SUPPORTS | 0.941 | **0.296** | 0.451 | 216 |
| xsmall | REFUTES | 0.679 | 0.607 | 0.641 | 122 |
| xsmall | NEUTRAL | 0.394 | 0.847 | 0.538 | 131 |
| DistilBERT | SUPPORTS | 0.490 | 0.222 | 0.306 | 216 |
| DistilBERT | REFUTES | 0.521 | 0.402 | 0.454 | 122 |
| DistilBERT | NEUTRAL | 0.230 | 0.466 | 0.308 | 131 |

This is 469 gold passage judgments, including all available SciFact dev
rationales and all cited-no-evidence passages. It is not inferred from final
verdicts.

## 5. Is xsmall too conservative?

**Yes for SUPPORTS, with qualifications.** Its 94.1% SUPPORTS precision and
29.6% recall show a strong neutral/abstain bias on gold supporting rationales.
The 56-fixture pattern (one support plus one neutral) is therefore not only a
fixture artifact. However:

* xsmall is materially better than the tested generic DistilBERT candidate on
  NLI F1, final accuracy, and ECE;
* final VERIFIED recall (2.4%) is also constrained by retrieval and the
  two-source policy, not only by xsmall;
* REFUTES behavior is less conservative and can become spuriously directional
  on unjudged retrieved abstracts, explaining poor final HC precision;
* lowering thresholds would not address retrieval misses, single-source gold,
  or incorrect contradictions and is not supported by this review.

## 6. Base / MNLI+FEVER recommendation

`Xenova/nli-deberta-v3-base` is adapter-compatible after label-name
normalization, but it is still a generic SNLI+MNLI model. The worse DistilBERT
result does not prove base will fail, but it removes any basis for assuming that
less-conservative generic MNLI behavior is automatically better.

A MNLI+FEVER+ANLI model is a stronger **hypothesis** because the measured failure
is evidence-verification task fit. It is not a conclusion: FEVER-family training
may improve directional recall while worsening false contradictions or
calibration. Evaluating it on SciFact avoids reporting a FEVER-trained model on
its training-family benchmark. Complete content-sealed bytes were unavailable
here, so no number is fabricated for either base candidate.

## 7. Evidence-only next change

**Next change: provision a content-sealed
`Xenova/DeBERTa-v3-base-mnli-fever-anli` candidate and run the unchanged full
SciFact protocol.** Do not change thresholds, policy, fixtures, or the default
model first. Promote nothing unless that run improves passage NLI macro-F1 and
SUPPORTS recall without degrading REFUTES/NEUTRAL precision, final HC precision,
ECE, and resource feasibility.

Pure `nli-deberta-v3-base` may be run as an additional size ablation, but the
current evidence does not justify making it the default or assuming it will
beat xsmall.

## 8. Validation record

| Command | Result |
|---|---|
| `npm run test:all` | PASS (all production contract, Vercel simulation, verdict, claim, evidence, artifact, and SSRF suites) |
| `npm run test:v2` | PASS — 61/61 |
| `npm run test:v2-route` | PASS — 9/9 |
| `npm run test:v2-models` | PASS — 90/90 with sealed xsmall/MiniLM bytes |
| `npm run eval:v2` | PASS — exact recorded metrics and all fixture verdicts reproduced |
| `npm run external:v2-data` | PASS — both SciFact hashes verified |
| `npm run eval:v2-external` (xsmall, 300/300) | PASS — full result recorded |
| `npm run eval:v2-external -- --nli-model-id=Xenova/distilbert-base-uncased-mnli` (300/300) | PASS — full result recorded |
| `npm run lint` (`tsc --noEmit`) | PASS |
| `npm run build` | PASS; esbuild reports the existing direct-`eval` worker-path warning |
| `npm audit` | PASS — 0 vulnerabilities |

No deployment, production-model replacement, merge, or pull request was
performed.
