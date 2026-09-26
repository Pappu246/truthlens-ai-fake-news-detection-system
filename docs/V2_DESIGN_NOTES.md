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
