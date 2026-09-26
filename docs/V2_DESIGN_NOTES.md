# TruthLens V2 — Implementation / Design Notes

Working notes for reviewers, covering the "why" behind the more surprising
decisions in `server/v2/**`. See `docs/V2_ARCHITECTURE.md` for the pipeline
overview and `docs/V2_KNOWN_LIMITATIONS.md` for honest gaps.

## Why a new `server/v2/**` tree instead of editing `server/verification/**`?

The task's safety rules require: don't destabilise existing production
functionality, preserve all existing tests, no giant rewrite. The production
evidence engine (`server/verification/evidenceEngine.ts`) has its own
contract (`SUPPORTED`/`CONTRADICTED`/`MIXED`/`INSUFFICIENT_EVIDENCE`/
`NEEDS_MORE_CONTEXT`/`SEARCH_UNAVAILABLE`) and 53 passing contract tests
(`scripts/evidenceTests.ts`) plus dependents (`/api/analyze`,
`/api/evidence/verify`) that other tests assert against. Changing that
contract to the new V2 verdict space (`VERIFIED`/`REFUTED`/
`INSUFFICIENT_EVIDENCE`/`CONFLICTED`) in place would be exactly the kind of
"change existing production verdict semantics without a separate validated
migration" the task explicitly forbids. An isolated, additive module tree
with its own new endpoint (`POST /api/v2/evidence/verify`) lets the new
architecture be built and evaluated for real without any risk to the frozen
baseline — the entire `npm run test:all` suite still passes unmodified.

## Why hybrid retrieval fuses with reciprocal rank fusion (RRF)

RRF (`score = Σ 1/(k + rank)`) needs no score normalisation across
lexical/dense channels (BM25 and cosine similarity are not on comparable
scales), is parameter-light (one constant, `k=60`, a standard default from
the retrieval literature), and is deterministic. This avoided introducing a
second, ad-hoc weighting scheme on top of the one already used for
reranking.

## Why deduplication is by canonical URL via the existing `normalizeUrl`

The production code already has a URL canonicalisation function used for
history/provenance deduplication. Reusing it (rather than writing a second
one) means V2 and the production system treat `https://x.com/a?utm_source=y`
and `https://x.com/a` as the same document identically.

## Why the decision policy requires 2+ independent sources for VERIFIED/REFUTED

This mirrors ordinary fact-checking practice (a single source is a lead, not
a confirmation) and is the direct mechanism implementing the task's
requirement that abstention is preferred over forcing a verdict from weak
evidence. It is a configurable constant
(`DEFAULT_DECISION_THRESHOLDS.minIndependentSourcesForVerdict`), not a
hardcoded magic number buried in logic, specifically so a future milestone
can evaluate the accuracy/coverage trade-off of relaxing it.

## Why the LIAR prior can only nudge confidence, never the verdict category

Direct instruction from the task: "The existing LIAR classifier can
influence the prior/signal, but MUST NOT independently determine the final
verdict when evidence exists." The implementation goes further than "don't
let it flip a verdict when evidence is strong" — it also never lets the
prior turn an *abstention* into a directional verdict when evidence is weak.
Every prior lookup, agreement/disagreement, and the exact confidence
adjustment applied is written into `provenance.prior_signal` and
`provenance.decision_rule_trace`, so a reviewer can audit it rather than
trust it.

## Why two rule-based adapters (embedding + NLI) instead of downloading real models

The task requires "reproducible offline fixtures for CI" and forbids
depending on a paid API for local/CI testing. A pretrained sentence-embedding
or NLI model would need either a paid inference API or a multi-hundred-MB
model download at build/test time, which is not reproducible in a
network-restricted CI runner and would make `npm run test:v2` /
`npm run eval:v2` flaky or impossible offline. Both `EmbeddingModel` and
`NliAdapter` are narrow interfaces specifically so this is a contained,
future swap (see `docs/V2_KNOWN_LIMITATIONS.md`), not an architectural
dead end.

## Why provenance sanitises title/publisher, not just the passage

Early in testing (`scripts/v2PipelineTests.ts`, scenario 10/11), a hostile
document's title/publisher fields were found to pass through
`ProvenanceEvidenceRecord` unsanitised even though the passage itself was
correctly neutralised via the existing `sanitiseUntrustedEvidence()`. Fixed
by sanitising `title`/`publisher` at the same point in
`server/v2/pipeline.ts` before they enter `ClassifiedEvidence`. This is
called out here because it is exactly the kind of gap a security-focused
review should be looking for, and it was caught by the required test
scenario rather than assumed away.

---

# V2.1 notes — real pretrained adapters behind frozen interfaces

## How real async models fit the frozen SYNC adapter contracts

`EmbeddingModel.embed()` and `NliAdapter.classify()` are synchronous, and the
V2.1 contract explicitly forbids rewriting them. ONNX Runtime inference in
JavaScript is async, so V2.1 runs both models in a single dedicated
`worker_threads` worker (`server/v2/ml/mlWorker.cjs`, plain CommonJS so no
bundler/tsx hook is needed) and exposes a blocking call through
SharedArrayBuffer + `Atomics.wait` (`server/v2/ml/mlWorkerClient.ts`) —
legal on Node's main thread, bounded by an explicit timeout, fails closed
with `ModelUnavailableError` if the worker dies. Alternatives rejected:
rewriting the pipeline to async (forbidden), per-call process spawning
(~100ms+ overhead × thousands of calls), and `deasync`-style native event-loop
spinning (fragile across Node builds). A side benefit: an ONNX crash kills
an isolated worker, never the API process.

## Why pytest-style "fixture mode" instead of making every test download models

The contract requires lightweight deterministic CI AND real-model validation.
`TRUTHLENS_V2_MODEL_MODE=fixture` pins the V2 research adapters (they remain
honest, named code) for `test:v2`/`test:v2-route`; `test:v2-models` — the
real-adapter suite — fails loudly with remediation when sealed files are
absent. "Silent fallback to heuristic inference" would violate the milestone
requirements, so the resolver (`server/v2/ml/modelResolution.ts`) throws in
exactly that situation instead.

## Why the NLI adapter has policies at all (are they "rules"?)

The requirement bans *hardcoded lexical rules as the primary NLI decision*.
Both adapter policies are model-derived:
(1) two-pass hypothesis selection only CHOOSES which claim reading to score
(claim-as-stated vs attribution-stripped content proposition) — both scores
come from the cross-encoder; and (2) the relatedness gate uses the other
pretrained model (bi-encoder cosine) to keep the cross-encoder on its
trained distribution (MNLI has no "unrelated pair" semantics and
over-predicts contradiction off-distribution — measured, not hypothetical).
The threshold (0.15) was set from unrelated-vs-related cosine separation
(~ −0.04 vs ~0.5 in the instrumented runs), not from fixture outcomes.

## Why the fixture-era accuracy number was refused as a tuning target

The 56-fixture dev set's corpus language shares cue vocabulary with the
heuristic adapter. Tuning the pretrained adapter/thresholds toward that set
would be benchmark leakage. V2.1 therefore ships the adapter as designed and
reports the raw regression (accuracy −42.8 pt, abstention +41.1 pt,
ECE −0.041 better, verdict precision still 1.00) in
`docs/V2_BENCHMARK_PROTOCOL.md`, with per-fixture mechanisms. The correct
remedy — a fact-verification-trained cross-encoder (MNLI+FEVER family) —
is the proposed next milestone, queued behind the new sealed-provisioning
machinery (`docs/V2_MODELS.md`).

## Why model bytes come from pinned git-blob mirrors

This project's sandbox/CI cannot reach huggingface.co. Files are fetched by
exact git blob SHA-1 at pinned mirror commits (content-addressed), then
re-verified against sealed size + SHA-256 in
`server/v2/ml/modelManifest.ts`; the embedding ONNX blob is byte-identical
across two independent mirrors (cross-attestation). The download script
still tries the canonical Hugging Face repo first when reachable. The npm
tarball alternative (`@xcidos/genesis-memory-model`) was rejected as sole
source: only one unsigned publisher's copy, no independent attestation.
