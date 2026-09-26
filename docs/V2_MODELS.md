# TruthLens V2.1 — Pretrained Model Inventory, Provenance & Runbook

> **Scope: `server/v2/**` research stack ONLY. Nothing here changes the
> production models (`server/mlEngine.ts`, `server/claimModel.ts`,
> `server/verification/**`) or the production README.**

V2.1 replaces the V2 first-slice **research placeholders** (deterministic
hashing n-gram embeddings + rule-based heuristic NLI) with **real pretrained
models** running locally over ONNX. The pipeline architecture, interfaces,
retrieval fusion, reranking, decision policy and provenance schema are
unchanged — only the two intelligence adapters were upgraded, behind their
existing interfaces (`EmbeddingModel`, `NliAdapter`).

## Models used

| Role | Model id | Base model (upstream) | Weights | Output |
|---|---|---|---|---|
| Dense retrieval embeddings | `Xenova/all-MiniLM-L6-v2` | `sentence-transformers/all-MiniLM-L6-v2` | ONNX, int8 dynamic quant (q8) | 384-dim sentence embedding, mean-pooled, L2-normalised |
| Evidence entailment (NLI) | `Xenova/nli-deberta-v3-xsmall` | `cross-encoder/nli-deberta-v3-xsmall` (fine-tuned on MNLI) | ONNX, int8 dynamic quant (q8) | 3-way logits → softmax probabilities |

**Version reporting (content-sealed).** Adapter-reported versions are not
marketing strings: they are `q8@<first8(sha256(onnx weights))>`.

* embeddings: `Xenova/all-MiniLM-L6-v2` @ **`q8@afdb6f1a`**
* NLI: `Xenova/nli-deberta-v3-xsmall` @ **`q8@3fac2500`**

Every file (ONNX, tokenizer, configs) additionally carries a sealed byte size
+ full SHA-256 + the git blob SHA-1 of the verified mirror it was fetched
from — all recorded in `server/v2/ml/modelManifest.ts` and enforced by the
download script and by `npm run test:v2-models`.

## Normalization / inference method

* **Embeddings** — text → WordPiece tokenizer → ONNX session
  (`onnxruntime-node`, CPU) → **mean pooling over the attention mask → L2
  normalization** (plus a defensive re-normalization in the adapter so cosine
  similarity == dot product, as the retrieval layer assumes). Inference is
  deterministic: same weights + same runtime + same input ⇒ bit-identical
  vectors within a process (asserted by `test:v2-models`; across machines,
  tiny float drift inside ONNX Runtime/BLAS builds is the only expected
  residual).
* **NLI** — premise = evidence passage, hypothesis = claim (two-pass
  hypothesis selection, see below) → DebertaV2 tokenizer → ONNX session →
  softmax over the 3 MNLI logits. The `id2label` mapping is read from the
  model's own `config.json` at runtime — never hard-coded. Label mapping:
  `entailment→SUPPORTS`, `contradiction→REFUTES`, `neutral→NEUTRAL`, and
  `UNCLEAR` **only** when no class has majority support (maxP < 0.5) — a
  model-uncertainty label, not a lexical rule.

### Adapter policies (all model-derived, all documented — no lexical rules)

1. **Two-pass hypothesis selection** (`server/v2/nli/pretrainedNliAdapter.ts`).
   Real claims often embed the reporting event ("<Source> confirmed P").
   MNLI cross-encoders are strict and literal:
   *"officials denied the figure"* directly contradicts the claim-as-stated
   but not the bare proposition *P*, while corroborating passages entail *P*
   without restating the attribution. Pass A runs the claim **as stated** and
   decides only on a majority contradiction/entailment (the explicit
   refutation/confirmation pattern); when undecided and the claim carries
   attribution, pass B runs the **content proposition** (deterministic
   attribution stripping — hypothesis *construction*, not the decision).
2. **Relatedness gate.** MNLI models are only valid on topically related
   (premise, hypothesis) pairs; on retrieval-miss pairs they over-predict
   "contradiction" (a known off-distribution failure). The NLI adapter
   therefore gates with the *other* pretrained model: if the bi-encoder
   cosine(claim, passage) < **0.15** (for all-MiniLM-L6-v2, unrelated pairs
   cluster ≈ ≤0.0; related-but-not-entailing pairs sit ≈ 0.2–0.6 — measured
   in `scripts`), the passage is labelled NEUTRAL (off-topic) **without**
   consulting the cross-encoder. The gate is recorded in `basis`.

## Resource requirements

Measured in this development sandbox (Node 22, 2 CPU cores, Linux x64):

| Item | Value |
|---|---|
| Model files on disk (12 files, `models/v2/`) | ~115 MB (23 MB + 87 MB ONNX + tokenizers) |
| Runtime deps (`@huggingface/transformers@3.7.6`, `onnxruntime-node@1.21.0`; `sharp@0.35.4` pinned via npm `overrides` for a libvips CVE fix — the text-only path never calls sharp) | in `package.json` |
| Peak RSS with both models loaded (single shared worker) | ~722 MB (baseline 102 MB → +159 MB embeddings → +620 MB total) |
| Warm latency: one embedding | ~6 ms |
| Warm latency: one NLI pair | ~35 ms |
| 56-fixture eval end-to-end (incl. one-time model loads) | ~15 s |

Both models run in **one dedicated worker thread** (`server/v2/ml/mlWorker.cjs`)
because the V2 adapter interfaces are *synchronous* while ONNX inference in
JavaScript is async; the main thread blocks on `Atomics.wait` against a
SharedArrayBuffer request/response protocol (`mlWorkerClient.ts`). Models
load **once per process** (lazy on first use) — never per request — and the
worker is hard-offline: `HF_HUB_OFFLINE=1`, `allowRemoteModels=false`.

## Provisioning (reproducible, sealed)

```bash
npm run download:v2-models
```

* Writes to `models/v2/` (gitignored; override with `TRUTHLENS_V2_MODEL_DIR`).
* Sources are tried in order: canonical Hugging Face repo first
  (`huggingface.co/Xenova/...resolve/main/...`), then pinned GitHub git-blob
  mirrors (needed in environments where huggingface.co is unreachable — as in
  this project's sandbox). A file is **accepted only if it matches the sealed
  size + SHA-256** in `server/v2/ml/modelManifest.ts`; anything else is
  rejected loudly.
* GitHub mirrors are pinned to exact commits, and files are fetched by exact
  git blob SHA-1 (content-addressed at the source). The embedding model's
  main ONNX blob (`712e070a…`) is byte-identical across two independent
  mirror repositories — cross-attestation of upstream integrity.

**TLS-intercepted / proxied networks.** In environments whose egress proxy
re-encrypts TLS with a custom CA, Node's bundled CA store rejects hosts the
system store accepts. Point Node at the system bundle when downloading:

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm run download:v2-models
```

GitHub blob-API credentials are resolved as: `GITHUB_TOKEN`/`GH_TOKEN` env →
`gh auth token` (if the gh CLI is installed and logged in) → unauthenticated
(public repos, 60 req/hr — the script needs 12). If every source is
unreachable, host byte-identical copies anywhere reachable and add them as a
mirror entry in `server/v2/ml/modelManifest.ts`; verification will accept
only files matching the sealed SHA-256 anyway.

**Postinstall note.** `onnxruntime-node@1.21.0`'s optional postinstall calls
a binary CDN that is unreachable in some locked-down networks. It is a
no-op for the Linux x64 CPU path (the runtime `.so` ships inside the npm
tarball), so `npm install --ignore-scripts` yields a fully working stack in
those networks; normal networks can install scripts as usual.

## Modes: pretrained vs fixture (tests/CI)

`server/v2/ml/modelResolution.ts` is THE ONLY place mode is decided:

* **default = pretrained** — used by `/api/v2/evidence/verify` and
  `npm run eval:v2`.
* **fixture** — V2 first-slice research adapters, enabled *only* by
  explicitly setting `TRUTHLENS_V2_MODEL_MODE=fixture` (done at the top of
  `scripts/v2PipelineTests.ts` and `scripts/v2RouteTests.ts`). Fixture mode
  is for deterministic lightweight CI and the recorded V2 baseline; it is
  disclosed in provenance (`models.*` names + limitations text) so it can
  never masquerade as a real model.
* **fail-closed** — pretrained requested but sealed files missing/corrupt ⇒
  `ModelUnavailableError` with exact remediation. There is **no silent
  fallback** to heuristic inference, anywhere.

| Suite | Mode | Needs models? | Command |
|---|---|---|---|
| Lightweight pipeline tests (61) | fixture | no | `npm run test:v2` |
| Route tests (9) | fixture | no | `npm run test:v2-route` |
| Production suites | n/a | no | `npm run test:all` |
| **Pretrained adapter tests (90)** | pretrained | **yes** | `npm run test:v2-models` |
| V2 baseline eval | fixture | no | `npm run eval:v2 -- --mode=fixture` |
| **V2.1 eval** | pretrained | **yes** | `npm run eval:v2` |

Recommended CI: run the three no-model suites in the standard job; run
`download:v2-models && test:v2-models && eval:v2` in a separate full-model
job (or on release) — the two tracks are deliberately independent.

## Environment variables

| Var | Meaning |
|---|---|
| `TRUTHLENS_V2_MODEL_MODE` | `pretrained` (default) or `fixture` (explicit tests/CI) |
| `TRUTHLENS_V2_MODEL_DIR` | model root, default `<cwd>/models/v2` |
| `TRUTHLENS_V2_ML_CALL_TIMEOUT_MS` | per-call worker timeout (default 120000 ms) |
| `TRUTHLENS_V2_WORKER_PATH` | absolute worker script path override (deployment exotic layouts) |
| `GITHUB_TOKEN` / `GH_TOKEN` | optional, only for the download script's GitHub API calls |

## Known model-side limitations (written as measured findings, not excuses)

1. **Strict MNLI semantics vs. elliptical news snippets.** Second-source
   corroboration is often elliptical ("Independent reviewers verified and
   corroborated the 80% reduction") — it omits the subject, so strict MNLI
   entailment fails and the passage reads NEUTRAL. Real, intended behavior of
   the model — but on the 56-fixture dev set it halves VERIFIED recall (see
   `docs/V2_BENCHMARK_PROTOCOL.md` for the honest numbers; pipeline
   abstains rather than guessing, by design).
2. **Meta-linguistic denials.** "The bank denied the claim as false" is a
   *refutation event*, not a contradiction of the proposition — MNLI returns
   neutral; FEVER-style fact-verification training data would handle this
   better (see next milestone).
3. **Model size.** `nli-deberta-v3-xsmall` was chosen for CI-friendly
   CPU-only inference (87 MB int8). `-base` and FEVER-NLI–trained variants
   are drop-in candidates behind the same manifest-driven provisioning.
4. **Blocking facade.** The sync adapter contract means the request thread
   blocks (~35 ms per NLI pair) while the worker computes. Throughput-bound
   deployments should batch or parallelize workers in a future milestone.

## Recommended next milestone (single, scoped increment)

Upgrade the NLI cross-encoder to a fact-verification–trained variant
(e.g. `MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli` or
`cross-encoder/nli-deberta-v3-base`, q8 ONNX) via a new sealed manifest
entry + mirror pins, re-run the unchanged 56-fixture harness in both modes,
and report the delta against `data/v2/eval_results.json` (V2.1) and
`data/v2/eval_results_v2_baseline.json` (V2 heuristic) — with per-passage
gold NLI labels added to the fixture generator so NLI quality is measured
directly rather than only through verdicts.

---

## V2.2 — optional experimental NLI candidates (evaluation only)

`server/v2/ml/modelManifest.ts` now also carries
`EXPERIMENTAL_NLI_CANDIDATES`: an **additive, evaluation-only** registry of
NLI models that may be swapped in behind the unchanged `NliAdapter`
interface for benchmark runs. It is deliberately *not* part of
`ALL_MODEL_MANIFESTS`, and `resolveDefaultNliAdapter()` continues to return
the sealed `Xenova/nli-deberta-v3-xsmall` adapter — registering a candidate
can never change the default model (asserted by `npm run test:v2-candidate`).

Each entry pins id, base model, upstream revision (or explicit `null`),
quantization, the content seal `q8@<first8 sha256>`, per-file
`{bytes, sha256, gitBlobSha1}`, pinned mirror sources, and a `sealState`
of `sealed` or `unsealed`.

**Fail-closed contract.** An unsealed entry, an unknown id, a missing file,
a wrong-sized file, or (on explicit verification) a wrong-content file all
raise `ModelUnavailableError`. Nothing unverified is downloaded, loaded or
evaluated, and there is never a silent fallback to the default model.

| Command | Purpose |
|---|---|
| `npm run download:v2-candidate -- --list` | show the registry, seal states and blockers |
| `npm run download:v2-candidate -- --model=<id>` | sealed, hash-verified, idempotent provisioning |
| `npm run seal:v2-candidate -- --model=<id> --dir=<path> [--revision=<sha>]` | compute the seal block from bytes on disk (never writes the manifest) |
| `npm run test:v2-candidate` | registry, fail-closed and research-integrity regression tests |
| `npm run eval:v2-external -- --nli-model-id=<id>` | run the frozen SciFact protocol with that candidate |

Current entries:

* `Xenova/distilbert-base-uncased-mnli` — **sealed**, comparison-only MNLI
  baseline (seals migrated here from the old ad-hoc script).
* `Xenova/DeBERTa-v3-base-mnli-fever-anli` — **unsealed**: identity is pinned,
  bytes are not obtainable in the CI/sandbox environment, so it fails closed.
  See `docs/V2_2_MODEL_COMPARISON.md` for the provisioning attempt log and the
  exact steps to complete the seal.

### Frozen evaluation clock

`server/v2/clock.ts` provides the single injectable clock used by the
freshness rerank signal and provenance timestamps. `verifyClaimV2()` accepts
`nowMs`; `TRUTHLENS_V2_FROZEN_NOW` (ISO-8601 or epoch ms) freezes it
process-wide; live callers still get `Date.now()`. Both evaluation harnesses
pin it to `2026-09-26T00:00:00.000Z`, so benchmark runs no longer drift with
the date on which they are executed.
