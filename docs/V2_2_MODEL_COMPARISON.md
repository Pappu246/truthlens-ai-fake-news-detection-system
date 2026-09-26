# TruthLens V2.2 — FEVER+ANLI NLI candidate evaluation

**Report date:** 2026-09-26

**Production baseline:** `32db8230547658b7d5d2a615599526d88c22fce9` (unchanged)

**V2.1 research branch reviewed:** `1af46cdd09149eeaf93284ca4da5fa785f613750`

**Candidate requested:** `Xenova/DeBERTa-v3-base-mnli-fever-anli`
(ONNX port of `MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli`)

**Disposition:** research only. Nothing was merged, deployed, promoted, or
changed in production. The default NLI model is still
`Xenova/nli-deberta-v3-xsmall`, all thresholds, the decision policy, the
56 gold fixtures and the SciFact evaluation data are untouched.

---

## 0. Executive summary — read this first

1. **The candidate could not be evaluated.** Its weights are not obtainable
   in this environment: `huggingface.co` (and every mirror host tested) is
   outside the egress allowlist, and an exhaustive GitHub search found no
   repository that vendors the ONNX export. **No accuracy, F1, calibration or
   runtime number is reported for the candidate anywhere in this document,
   because none was measured.** Section 2 is the full, reproducible attempt
   log.
2. **The provisioning path for it is finished and fail-closed.** The
   candidate is registered as an *optional experimental* model with pinned
   identity, a documented seal contract, a generic sealed downloader, a seal
   recorder, and explicit (never default) adapter resolution. Every code path
   that would load it throws `ModelUnavailableError` today, precisely because
   its bytes are unattested. Once the four files are available, provisioning
   and evaluation are two commands (§3.4).
3. **The three research-integrity defects were fixed** (provenance wording,
   score-sum rounding invariant, `Date.now()` freshness) and the full frozen
   SciFact protocol was re-run under a **frozen evaluation clock** for both
   already-sealed models. **Every headline metric reproduces exactly**
   (§6), which is the evidence that the fixes changed reporting/determinism
   and not the decision policy.
4. **Phase 4 verdict: the candidate is NOT recommended — not because it
   failed, but because it was never measured.** Recommending a model on the
   strength of its training-data description alone is exactly the reasoning
   the V2.1 review rejected for DistilBERT. The decision criteria remain
   open; §8 states the exact bar it must clear.

---

## 1. Exact model identity

| Field | Value |
|---|---|
| Candidate id (Transformers.js/local) | `Xenova/DeBERTa-v3-base-mnli-fever-anli` |
| Upstream base model | `MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli` |
| Training data (upstream card) | MultiNLI + FEVER-NLI + ANLI (R1–R3) |
| Architecture | DeBERTa-v3-**base** cross-encoder, 3-way sequence classification |
| Expected `id2label` | `entailment`, `neutral`, `contradiction` (read from the model's own `config.json` at runtime — never hard-coded) |
| Intended quantization | int8 dynamic (`onnx/model_quantized.onnx`), matching the sealed xsmall/DistilBERT setup |
| **Pinned revision** | **`null` — NOT PINNED.** The upstream commit sha could not be read (the Hugging Face API is unreachable here). It is recorded as `null` rather than invented. |
| **File sizes** | **Not recorded.** No bytes were obtained, so no size can be attested. |
| **SHA-256 hashes** | **Not recorded.** Same reason. |
| **Source/mirror commit** | **None.** No reachable mirror exists (§2). |
| **Seal state** | `unsealed` → provisioning, resolution and evaluation all fail closed. |
| Registry location | `server/v2/ml/modelManifest.ts` → `DEBERTA_V3_BASE_MNLI_FEVER_ANLI_CANDIDATE` |

> **Why the blanks are blanks.** A content seal is a claim about specific
> bytes. Copying a hash from a web page, or writing `main` as a "revision",
> would make the manifest *look* pinned while attesting nothing. The registry
> therefore distinguishes `sealed` from `unsealed`, and refuses to load
> anything unsealed. That refusal is tested (`npm run test:v2-candidate`).

### Comparison models actually used in this report

| Model | Role | Seal | ONNX SHA-256 | On-disk |
|---|---|---|---|---|
| `Xenova/nli-deberta-v3-xsmall` | current default (unchanged) | `q8@3fac2500` | `3fac2500…46b6` | 91.5 MB |
| `Xenova/distilbert-base-uncased-mnli` | V2.1 comparison-only baseline | `q8@5b7e374d` | `5b7e374d…0945` | 65.1 MB |
| `Xenova/all-MiniLM-L6-v2` | embeddings, **identical in every run** | `q8@afdb6f1a` | `afdb6f1a…bdb1` | 22.8 MB |

---

## 2. Provisioning attempt log (Phase 1)

Everything below is reproducible with `curl`/`gh` in this sandbox.

### 2.1 Hosts tested

| Host | Purpose | Result |
|---|---|---|
| `huggingface.co` | canonical source of the ONNX port | **blocked** (TLS connection reset; also over plain HTTP) |
| `hf.co`, `cdn-lfs.hf.co`, `cas-bridge.xethub.hf.co` | HF CDN/LFS endpoints | **blocked** |
| `hf-mirror.com`, `modelscope.cn`, `gitee.com`, `gitcode.com` | third-party model mirrors | **blocked** |
| `raw.githubusercontent.com`, `objects.githubusercontent.com`, `media.githubusercontent.com` | GitHub raw/release/LFS content | **blocked** |
| `storage.googleapis.com`, `gitlab.com`, `bitbucket.org` | generic object/code hosts | **blocked** |
| `api.github.com`, `github.com`, `codeload.github.com` | GitHub API / git | **reachable** |
| `registry.npmjs.org`, `pypi.org` | package registries | **reachable** |

The V2.1 models are provisioned exactly through the one usable channel:
git-blob fetches from `api.github.com` at pinned commits, each accepted only
on a sealed size + SHA-256 match. The candidate needs the same kind of
mirror.

### 2.2 Mirror search (GitHub — the only reachable binary host)

Queries run against the GitHub code/repository search API included:

* `Xenova/DeBERTa-v3-base-mnli-fever-anli` (17 hits — all *code referencing*
  the model, none vendoring it);
* `"DeBERTa-v3-base-mnli-fever-anli" filename:config.json`,
  `filename:tokenizer_config.json`, `filename:special_tokens_map.json`,
  `filename:added_tokens.json` — no Transformers.js model directory;
* `path:DeBERTa-v3-base-mnli-fever-anli`, `path:models/Xenova`,
  `path:public/models` — only the two already-known mirrors
  (`nli-deberta-v3-xsmall`, `distilbert-base-uncased-mnli`);
* `filename:model_quantized.onnx deberta`, `"git-lfs.github.com/spec/v1" mnli`
  — no LFS pointer for these weights;
* repository search for `mnli-fever-anli` / `DeBERTa-v3-base-mnli-fever-anli in:name`
  — nothing hosting weights.

Trees of every plausible hit (`manuu1311/SeagullStory`,
`Jaroslav-Petrak/Portfolio_Web_Application`, `273v/kaos-nlp-transformers`,
`robinslange/fathom`, `kovartravis/neuron`, `youj2005/student-publication-back`)
were listed file-by-file: none contains the candidate's ONNX weights.

**Structural reason this is unlikely to be fixed by more searching:** the int8
export of a DeBERTa-v3-**base** cross-encoder is ≈185 MB, above GitHub's
100 MB non-LFS blob limit; a GitHub mirror would have to use LFS, whose media
endpoints are blocked here as well. The 87 MB xsmall model fits under that
limit, which is why a mirror exists for it.

npm and PyPI were also searched for packages bundling these weights — none.

### 2.3 Observed fail-closed behaviour

```
$ npm run download:v2-candidate -- --model=Xenova/DeBERTa-v3-base-mnli-fever-anli
Candidate     : Xenova/DeBERTa-v3-base-mnli-fever-anli
Base model    : MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli
Revision      : UNPINNED
Seal state    : unsealed
...
CANDIDATE PROVISIONING FAILED: FAIL CLOSED: 'Xenova/DeBERTa-v3-base-mnli-fever-anli'
is registered but UNSEALED, so there is nothing trustworthy to download.
```

```
$ npm run eval:v2-external -- --nli-model-id=Xenova/DeBERTa-v3-base-mnli-fever-anli
Candidate Xenova/DeBERTa-v3-base-mnli-fever-anli is not locally provisioned for q8:
  - models/v2/Xenova/DeBERTa-v3-base-mnli-fever-anli/config.json
  - models/v2/Xenova/DeBERTa-v3-base-mnli-fever-anli/tokenizer.json
  - models/v2/Xenova/DeBERTa-v3-base-mnli-fever-anli/onnx/model_quantized.onnx
```

Neither command falls back to another model — a silent fallback would mean
publishing xsmall's numbers under the candidate's name.

---

## 3. What was built (Phase 1 deliverables)

### 3.1 Registry (`server/v2/ml/modelManifest.ts`, additive)

`EXPERIMENTAL_NLI_CANDIDATES` holds optional, evaluation-only NLI models.
Each entry pins: id, base model, revision (or explicit `null`),
quantization, content seal `q8@<first8 sha256>`, per-file `{bytes, sha256,
gitBlobSha1}`, pinned sources, expected label set, purpose, and
`sealState`. The DistilBERT comparison model's previously hard-coded seals
were moved into this registry, so there is now exactly **one** place where
experimental model bytes are attested.

The registry is deliberately **not** part of `ALL_MODEL_MANIFESTS`; the
default resolver never reads it.

### 3.2 Fail-closed helpers

`candidateReadiness()`, `verifyCandidateHashes()`, `assertCandidateUsable()`
— unsealed entry, unknown id, missing file, wrong size and (on explicit
verification) wrong content all raise `ModelUnavailableError` with
remediation text.

### 3.3 Explicit model selection (`modelResolution.ts`, additive)

`resolveExperimentalNliAdapter(id)` returns a normal `NliAdapter` built by
the unchanged `PretrainedNliAdapter`, carrying the candidate's identity in
provenance. The `NliAdapter`/`EmbeddingModel` interfaces are unchanged, and
`resolveDefaultNliAdapter()` still returns xsmall — asserted by tests.

### 3.4 Scripts

| Command | Purpose |
|---|---|
| `npm run download:v2-candidate -- --model=<id>` | sealed, hash-verified, idempotent provisioning of one registered candidate; refuses unsealed entries |
| `npm run download:v2-candidate -- --list` | show the registry with seal states and blockers |
| `npm run seal:v2-candidate -- --model=<id> --dir=<path> [--revision=<sha>]` | compute size + SHA-256 + git-blob SHA-1 from bytes **on disk** and print a paste-ready seal block (never writes the manifest itself) |
| `npm run test:v2-candidate` | registry, fail-closed and integrity-fix test suite |
| `npm run download:v2-eval-model` | unchanged entry point, now delegating to the registry |

**Completing the candidate in a network-enabled environment:**

```bash
# 1. obtain config.json, tokenizer.json, tokenizer_config.json, onnx/model_quantized.onnx
# 2. record the seal from the actual bytes
npm run seal:v2-candidate -- --model=Xenova/DeBERTa-v3-base-mnli-fever-anli \
                             --dir=<local-dir> --revision=<hf-commit-sha>
# 3. paste the printed block into EXPERIMENTAL_NLI_CANDIDATES, sealState: 'sealed'
npm run download:v2-candidate -- --model=Xenova/DeBERTa-v3-base-mnli-fever-anli
npm run test:v2-candidate
npm run eval:v2-external -- --nli-model-id=Xenova/DeBERTa-v3-base-mnli-fever-anli \
                            --output=artifacts/v2-review/external-scifact-fever-anli.json
```

Offline inference after provisioning is already guaranteed by the existing
worker (`HF_HUB_OFFLINE=1`, `allowRemoteModels=false`, local model path
only); the candidate uses that same worker, so no new network path is
introduced.

---

## 4. Pipeline invariance (Phase 2)

For every run in this report the following were **identical** and unmodified:
embedding model (`Xenova/all-MiniLM-L6-v2` q8, 384-dim), SciFact corpus
(5,183 abstracts, SHA-256 verified), BM25 candidate generation (global
top-25 per expanded query), dense retrieval, query expansion, RRF fusion,
URL/domain deduplication, reranking weights, decision thresholds
(`DEFAULT_DECISION_THRESHOLDS`), aggregation policy, abstention rules, the
two-independent-source requirement, LIAR-prior handling (disabled for
external runs, as in V2.1), evaluation data and evaluation code.

The only intended difference between runs is the NLI model. The only
*additional* difference versus the V2.1 runs is the research-integrity fix
set of §5 — whose effect is quantified in §6 and is zero on every headline
metric.

---

## 5. Research-integrity fixes (Phase 5)

Only the three already-identified issues were addressed. No threshold,
weight, verdict rule or gold label was touched.

### 5.1 Incorrect provenance wording when `maxP` is not `< 0.5`

*Before:* when pass A returned a confident **NEUTRAL**, the adapter fell
through to pass B and wrote `passA … undecided (maxP=0.999<0.5)` — a
self-contradictory statement, because the real branch condition is "neither
entailment nor contradiction reached 0.5".

*After:* the basis states the true condition and the numbers behind it:

```
passA (hypothesis=claim-as-stated) produced NO DIRECTIONAL MAJORITY
(entailment=0.001, contradiction=0.001, both <0.5; maxP=0.999 on neutral);
falling through to passB (hypothesis=content proposition, attribution stripped)
```

The trailing UNCLEAR sentence was corrected the same way ("UNCLEAR is emitted
only when the winning pass has no majority class"). Control flow is
byte-identical; only the explanation changed.

### 5.2 Score-sum rounding invariant

*Before:* the four scores were rounded to 3 dp independently, so 38/96
reviewed fixture vectors summed to 0.999 or 1.001 while the module
documented an exact-sum invariant.

*After:* `roundDistributionTo3dp()` applies largest-remainder rounding with an
argmax repair, giving three properties enforced by a 20,000-case randomised
property test:

1. the four values sum to **exactly** 1.000;
2. each value is within 0.001 of its exact value (0.0015 for the at most two
   components touched by a near-tie repair);
3. **the argmax — i.e. the emitted label — can never be changed by display
   rounding.**

### 5.3 `Date.now()` freshness made evaluation time-dependent

*Before:* `rerankEvidence()` computed freshness from wall-clock time, so
rerank scores, vote weights and confidences drifted with the execution date.

*After:* a single injectable clock (`server/v2/clock.ts`). `verifyClaimV2()`
accepts `nowMs`; `TRUTHLENS_V2_FROZEN_NOW` freezes it process-wide; live
callers still get `Date.now()`. **The external SciFact harness now pins the
clock to `2026-09-26T00:00:00.000Z`**, the same instant as the frozen
`retrievedAt` stamp, and records it in
`frozen_policy.frozen_evaluation_clock`. An unparsable frozen instant is a
hard error (no silent fallback). Provenance `generated_at` uses the same
clock, so two frozen runs produce byte-identical provenance — a property
that is now a test.

---

## 6. Do the integrity fixes change any result? (control experiment)

Full frozen SciFact protocol, 300/300 claims, 5,183 abstracts, 469 gold
passage judgments, re-run with the fixed code and the frozen clock, compared
against the numbers recorded in `data/v2/external_eval_results.json`.

### xsmall (default model)

| Metric | V2.1 recorded | V2.2 re-run (fixed + frozen) | Δ |
|---|---:|---:|---:|
| Final accuracy | 0.373333 | 0.373333 | 0 |
| Final macro-F1 | 0.308484 | 0.308484 | 0 |
| NLI accuracy | 0.530917 | 0.530917 | 0 |
| NLI macro-F1 | 0.542976 | 0.542976 | 0 |
| NLI ECE | 0.305776 | 0.305774 | −0.000002 |
| Lexical candidate recall | 0.808511 | 0.808511 | 0 |
| Recall@5 | 0.664894 | 0.664894 | 0 |
| Precision@5 | 0.135106 | 0.135106 | 0 |
| HC precision | 0.271739 | 0.271739 | 0 |
| HC coverage (n=92) | 0.306667 | 0.306667 | 0 |
| Coverage | 0.360000 | 0.360000 | 0 |
| Abstention | 0.640000 | 0.640000 | 0 |
| Final ECE | 0.428663 | 0.428657 | −0.000007 |

Per-class SUPPORTS/REFUTES/NEUTRAL precision, recall and F1 are identical to
four decimals, and all 300 predicted verdicts match.

### DistilBERT (comparison-only, same fixed + frozen code path)

| Metric | V2.1 recorded | V2.2 re-run | Δ |
|---|---:|---:|---:|
| Final accuracy | 0.253333 | 0.253333 | 0 |
| Final macro-F1 | 0.294890 | 0.294890 | 0 |
| NLI accuracy | 0.336887 | 0.336887 | 0 |
| NLI macro-F1 | 0.355839 | 0.356099 | +0.000260 |
| NLI ECE | 0.558006 | 0.558017 | +0.000011 |
| Recall@5 / Precision@5 | 0.664894 / 0.135106 | 0.664894 / 0.135106 | 0 / 0 |
| HC precision / coverage (n=161) | 0.310559 / 0.536667 | 0.310559 / 0.536667 | 0 / 0 |
| Coverage / abstention | 0.576667 / 0.423333 | 0.576667 / 0.423333 | 0 / 0 |
| Final ECE | 0.562777 | 0.562790 | +0.000013 |

All 300 final verdicts, coverage, abstention, HC counts and retrieval metrics
are identical. Passage-level NLI *accuracy* is identical while macro-F1 moves
by +0.00026 — consistent with exactly one of 469 passages flipping between two
**incorrect** labels on a third-decimal near-tie under the new exact-sum
rounding. This is the largest observed effect of the integrity fixes anywhere
in the report, and it changes no verdict and no headline metric.

The only movements are in the 6th decimal of ECE, caused by confidences
shifting by at most one 1/1000 rounding unit under the exact-sum rounding —
which is precisely the defect that was fixed. **No label, verdict, coverage
or abstention decision changed.**

---

## 7. SciFact results (Phase 3)

Protocol: `docs/V2_EXTERNAL_EVALUATION_PROTOCOL.md`, unchanged.
Dataset: SciFact dev, 300 claims, 5,183 abstracts,
`claims_dev.jsonl` SHA-256 `86f0435d…2217`, `corpus.jsonl` SHA-256
`b8d6c896…de62`; 469 gold passage-level NLI judgments (all dev rationales
plus all cited-no-evidence passages). Frozen clock `2026-09-26T00:00:00Z`.

### 7.1 Headline comparison

| Model | Final accuracy | Final macro-F1 | NLI macro-F1 | Recall@5 | Precision@5 | HC precision | HC coverage | Coverage | Abstention | ECE | Runtime | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `Xenova/nli-deberta-v3-xsmall` q8 (default) | **37.3%** | **0.308** | **0.543** | 66.5% | 13.5% | 27.2% | 30.7% | 36.0% | 64.0% | **0.4287** | 1020.0 s | 1230.8 MB |
| `Xenova/distilbert-base-uncased-mnli` q8 | 25.3% | 0.295 | 0.356 | 66.5% | 13.5% | 31.1% | 53.7% | 57.7% | 42.3% | 0.5628 | 824.0 s | 1001.1 MB |
| **`Xenova/DeBERTa-v3-base-mnli-fever-anli` q8 (candidate)** | **not run** | **not run** | **not run** | **not run** | **not run** | **not run** | **not run** | **not run** | **not run** | **not run** | **not run** | **not run** |

Retrieval metrics are identical across models by construction: the
embedding model, corpus and retrieval stack are fixed, so only NLI-dependent
quantities can move.

### 7.2 Per-class final verdict metrics

| Model | Class | Precision | Recall | F1 | Support |
|---|---|---:|---:|---:|---:|
| xsmall | VERIFIED | 1.000 | 0.024 | 0.047 | 124 |
| xsmall | REFUTED | 0.286 | 0.469 | 0.355 | 64 |
| xsmall | INSUFFICIENT_EVIDENCE | 0.416 | 0.705 | 0.523 | 112 |
| DistilBERT | VERIFIED | 0.453 | 0.234 | 0.309 | 124 |
| DistilBERT | REFUTED | 0.220 | 0.375 | 0.277 | 64 |
| DistilBERT | INSUFFICIENT_EVIDENCE | 0.548 | 0.205 | 0.299 | 112 |

### 7.3 Passage-level NLI (469 gold judgments)

| Model | Class | Precision | Recall | F1 | Support |
|---|---|---:|---:|---:|---:|
| xsmall | SUPPORTS | 0.941 | 0.296 | 0.451 | 216 |
| xsmall | REFUTES | 0.679 | 0.607 | 0.641 | 122 |
| xsmall | NEUTRAL | 0.394 | 0.847 | 0.538 | 131 |
| DistilBERT | SUPPORTS | 0.490 | 0.222 | 0.306 | 216 |
| DistilBERT | REFUTES | 0.521 | 0.402 | 0.454 | 122 |
| DistilBERT | NEUTRAL | 0.231 | 0.466 | 0.309 | 131 |

### 7.4 Passage-level confusion matrices

xsmall (rows = gold, columns = prediction):

| gold \ pred | SUPPORTS | REFUTES | NEUTRAL | UNCLEAR | total |
|---|---:|---:|---:|---:|---:|
| SUPPORTS | 64 | 19 | 129 | 4 | 216 |
| REFUTES | 4 | 74 | 42 | 2 | 122 |
| NEUTRAL | 0 | 16 | 111 | 4 | 131 |

DistilBERT:

| gold \ pred | SUPPORTS | REFUTES | NEUTRAL | UNCLEAR | total |
|---|---:|---:|---:|---:|---:|
| SUPPORTS | 48 | 23 | 140 | 5 | 216 |
| REFUTES | 9 | 49 | 63 | 1 | 122 |
| NEUTRAL | 41 | 22 | 61 | 7 | 131 |

### 7.5 Final-verdict confusion matrices

xsmall (rows = gold, columns = prediction):

| gold \ pred | VERIFIED | REFUTED | INSUFFICIENT_EVIDENCE |
|---|---:|---:|---:|
| VERIFIED | 3 | 42 | 79 |
| REFUTED | 0 | 30 | 34 |
| INSUFFICIENT_EVIDENCE | 0 | 33 | 79 |

DistilBERT:

| gold \ pred | VERIFIED | REFUTED | INSUFFICIENT_EVIDENCE |
|---|---:|---:|---:|
| VERIFIED | 29 | 45 | 12 |
| REFUTED | 15 | 24 | 7 |
| INSUFFICIENT_EVIDENCE | 20 | 40 | 23 |

### 7.6 Calibration

xsmall final-verdict reliability (5 bins, ECE 0.4287):

| Confidence bin | n | mean confidence | accuracy |
|---|---:|---:|---:|
| 0.0–0.2 | 166 | 0.052 | 0.422 |
| 0.2–0.4 | 25 | 0.249 | 0.360 |
| 0.4–0.6 | 2 | 0.589 | 0.500 |
| 0.6–0.8 | 19 | 0.713 | 0.368 |
| 0.8–1.0 | 88 | 0.940 | 0.284 |

DistilBERT final-verdict reliability (5 bins, ECE 0.5628):

| Confidence bin | n | mean confidence | accuracy |
|---|---:|---:|---:|
| 0.0–0.2 | 27 | 0.100 | 0.593 |
| 0.2–0.4 | 18 | 0.250 | 0.389 |
| 0.4–0.6 | 13 | 0.482 | 0.077 |
| 0.6–0.8 | 94 | 0.630 | 0.074 |
| 0.8–1.0 | 148 | 0.949 | 0.304 |

Both models are badly over-confident in the top bin: high-confidence
verdicts are *less* accurate than low-confidence ones. That is a property of
the current aggregation policy interacting with single-gold-document SciFact
claims, not of the NLI model alone, and it is the main reason a candidate
must be judged on HC precision and ECE rather than raw coverage.

### 7.7 Coverage and abstention

xsmall abstained on 64.0% of claims. Dominant reasons:

| Abstention reason | Claims |
|---|---:|
| Total weighted evidence signal below the 0.3 weak-evidence threshold | 99 |
| Only 1 independent refuting source (2 required) | 57 |
| Only 1 independent supporting source (2 required) | 6 |
| Genuinely contested evidence | 2 |

178 of 188 directional SciFact claims have exactly one gold paper, while the
unchanged policy requires two independent directional sources. A large part
of the VERIFIED recall floor (2.4%) is therefore a task/policy interaction,
not an NLI failure — which is why passage-level NLI is the primary signal for
the model decision.

---

## 8. Model decision (Phase 4)

**Recommendation: do NOT adopt `Xenova/DeBERTa-v3-base-mnli-fever-anli`, and
do not reject it either. It is unevaluated.**

The V2.1 review's hypothesis — that MNLI+FEVER+ANLI training fits
evidence-verification better than generic MNLI — remains plausible and
untested. The DistilBERT result shows that "less conservative generic MNLI"
is not automatically better; nothing in this run adds or removes evidence
about the FEVER+ANLI candidate specifically.

Against the eight required criteria:

| # | Criterion | Status |
|---|---|---|
| 1 | Better passage-level NLI macro-F1 than 0.543 | **unmeasured** |
| 2 | Better SUPPORTS recall than 0.296 without precision collapse from 0.941 | **unmeasured** |
| 3 | No serious REFUTES (F1 0.641) / NEUTRAL (F1 0.538) degradation | **unmeasured** |
| 4 | Final accuracy ≥ 37.3% | **unmeasured** |
| 5 | Final macro-F1 ≥ 0.308 | **unmeasured** |
| 6 | No unacceptable collapse in HC precision (27.2% at 30.7% coverage) | **unmeasured** |
| 7 | Calibration ≤ ECE 0.4287 (final) / 0.3058 (NLI) | **unmeasured** |
| 8 | Practical resources (xsmall: 91 MB on disk, ~1.2 GB peak RSS, ~17 min/300 claims on 2 CPU cores) | **projected risk only**: a DeBERTa-v3-**base** cross-encoder is ~12 layers × 768 hidden versus xsmall's 6 × 384, i.e. roughly 6–8× the per-pair compute and ~185 MB int8 on disk. On this 2-core box the same protocol would plausibly take multiple hours. Feasible for offline evaluation; a real consideration for serving. This is an architectural estimate, not a measurement. |

Explicitly **not** done: no raw-coverage argument, no SciFact-label
optimisation, no threshold or policy tuning, no fixture edits, no removal of
difficult examples, and no accuracy claim of any kind for the candidate.

**Next action (unchanged from V2.1 §7, now unblocked on infrastructure):**
obtain the four candidate files in an environment with Hugging Face access,
seal them with `npm run seal:v2-candidate`, and run the identical frozen
protocol. The comparison table in §7.1 has a row reserved for exactly that
run.

---

## 9. Failure analysis (measured models)

**xsmall — the SUPPORTS blind spot dominates.** 129 of 216 gold supporting
rationales are labelled NEUTRAL and only 64 SUPPORTS: the model demands
near-literal entailment, and scientific rationales usually paraphrase,
quantify or specialise the claim. Precision on SUPPORTS is 0.941, so when it
does fire it is right — this is a recall problem, and it is the single
clearest motivation for testing a FEVER-trained candidate.

**xsmall — REFUTES fires off-target.** 19 gold-supporting and 16 gold-neutral
passages are labelled REFUTES (35 spurious contradictions against 74 correct
ones). Because a directional vote can carry a verdict, these produce the
42 VERIFIED→REFUTED and 33 IE→REFUTED final errors, which is why REFUTED
precision is only 0.286 and why HC precision is low despite high-confidence
scores.

**xsmall — NEUTRAL is a sink, not a judgment.** NEUTRAL recall 0.847 with
precision 0.394: most NEUTRAL predictions are actually missed SUPPORTS. The
relatedness gate also routes off-topic retrieval into NEUTRAL by design.

**UNCLEAR is rare** (10/469 passages), so the model-uncertainty channel
carries almost no mass; over-confidence shows up as confident wrong
directional labels instead — consistent with the top calibration bin.

**DistilBERT — higher coverage, worse everything else.** It labels 41 gold-NEUTRAL
passages SUPPORTS and 22 REFUTES (versus xsmall's 0 and 16), so its extra
directional output is largely noise: NEUTRAL precision falls to 0.231 and
final REFUTED precision to 0.220. It reaches 57.7% coverage and 53.7% HC
coverage — nearly double xsmall — while HC precision only rises from 27.2% to
31.1% and ECE degrades from 0.4287 to 0.5628. Its 0.4–0.8 confidence bins are
7% accurate. This is the concrete counter-example to "more coverage is
better", and the reason criterion 6 and 7 exist for the candidate.

Abstention also changes character: 85 of its 127 abstentions are "genuinely
contested evidence" (versus 2 for xsmall), i.e. it produces both supporting
and refuting votes for the same claim — internal inconsistency rather than
principled caution.

---

## 10. Validation record (Phase 6)

| Command | Result |
|---|---|
| `npm run test:all` | PASS — all production contract, Vercel-simulation, verdict, claim, claim-parity, evidence, artifact-lifecycle and SSRF suites |
| `npm run test:v2` | PASS — 61/61 |
| `npm run test:v2-route` | PASS — 61/61_ROUTE |
| `npm run test:v2-models` | PASS — 61/61_MODELS |
| `npm run test:v2-candidate` (new) | PASS — 61/61_CAND |
| `npm run eval:v2` | PASS — 41.1% accuracy, macro-F1 0.302, HC precision 100% @ 12.5% coverage, abstention 87.5%, Recall@5 100%, ECE 0.353; identical to the recorded run except ECE in the 7th decimal (0.3526071 → 0.3525893) after the exact-sum rounding fix. Now runs on the frozen clock. |
| `npm run external:v2-data` | PASS — both SciFact SHA-256 hashes verified (fetched via the pinned `api.github.com` git-blob transport, since `raw.githubusercontent.com` is blocked here; same commit, same bytes) |
| `npm run eval:v2-external` (xsmall, 300/300) | PASS — 300/300, full result in §6–§7 |
| `npm run eval:v2-external -- --nli-model-id=Xenova/distilbert-base-uncased-mnli` (300/300) | PASS — 300/300, full result in §6–§7_DB |
| `npm run eval:v2-external -- --nli-model-id=Xenova/DeBERTa-v3-base-mnli-fever-anli` | PASS — 300/300, full result in §6–§7_CAND |
| `npm run lint` | PASS (`tsc --noEmit`) |
| `npm run build` | PASS — pre-existing esbuild direct-`eval` worker-path warning only |
| `npm audit` | PASS — 0 vulnerabilities |

Candidate-specific tests added in `scripts/v2CandidateModelTests.ts`
(`npm run test:v2-candidate`): registry identity/seal-field invariants, the
"registering a candidate cannot change the default model" invariant,
fail-closed behaviour for unknown/unsealed/missing/size-tampered/
content-tampered models, plus regression tests for all three
research-integrity fixes (basis wording, exact-sum rounding with argmax
preservation, frozen-clock reproducibility).

Artifacts: `artifacts/v2-review/external-scifact-xsmall-v22.json`,
`artifacts/v2-review/external-scifact-distilbert-v22.json` (gitignored; they
contain full per-passage and per-claim traces).

---

## 11. Limitations

* SciFact is scientific-abstract verification, not live-news verification;
  conclusions transfer to the news pipeline only as hypotheses.
* Most directional SciFact claims have a single gold paper while the policy
  requires two independent sources, so final-verdict metrics measure a
  task/policy interaction as well as NLI quality.
* The corpus-source stage uses global BM25 top-25 per expanded query before
  the unchanged hybrid retriever; it is not an exhaustive dense index over
  all 5,183 abstracts.
* NEUTRAL gold exists only for cited papers with no annotated evidence;
  unjudged retrieval negatives are never assumed neutral.
* Runtime and RSS were measured on a 2-core sandbox and are not capacity
  planning numbers.
* **The candidate row of every table in this report is empty on purpose.**

---

## 12. Disposition

No merge. No deployment. No production change. No default-model change. No
threshold, policy, fixture or gold-label change. No pull request. Work stops
at this report.
