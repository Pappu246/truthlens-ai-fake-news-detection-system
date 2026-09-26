# TruthLens Evidence Engine

The evidence engine is the third, independent leg of the system. It is a
**retrieval** signal, not a model score, and it is reported separately from both
the ISOT article model and the LIAR claim model.

```
CLAIM
  ↓  claimExtractor        (entities, dates, numbers, search queries)
EVIDENCE SEARCH
  ↓  evidenceProvider      (Google News RSS index + Wikipedia)
SOURCE RELEVANCE
  ↓  evidenceAnalyzer      (lexical/entity overlap, numeric + temporal checks)
SUPPORT / CONTRADICTION
  ↓  evidenceAnalyzer      (relation classification per source)
VERIFICATION SIGNAL
  ↓  evidenceEngine        (aggregation, diversity weighting, direction)
FINAL INTERPRETATION
```

`server/verification/evidenceEngine.ts` is an **orchestration layer over the
existing modules**. It introduces no second search system: retrieval is
delegated to the existing `EvidenceProvider`, claim parsing to the existing
`claimExtractor`, relevance and relation classification to the existing
`evidenceAnalyzer`.

## Endpoints

| Endpoint | Behaviour |
|---|---|
| `POST /api/evidence/verify` | full pipeline for one claim |
| `POST /api/analyze` | runs the pipeline on the article's primary claim; opt out with `include_evidence: false` |
| `POST /api/evidence/search` | unchanged raw retrieval (pre-existing) |

## Verification statuses

| Status | Meaning |
|---|---|
| `SUPPORTED` | independent retrieved reporting corroborates the assertion |
| `CONTRADICTED` | retrieved reporting refutes the assertion |
| `MIXED` | retrieved sources conflict |
| `INSUFFICIENT_EVIDENCE` | retrieval succeeded, nothing addressed this claim |
| `NEEDS_MORE_CONTEXT` | the input is not a checkable claim |
| `SEARCH_UNAVAILABLE` | retrieval failed or was disabled |

**`SEARCH_UNAVAILABLE` and `INSUFFICIENT_EVIDENCE` are terminal.** They are never
rewritten into a verdict. The response states explicitly that absence of
retrievable evidence is not evidence of falsity, returns zero citations, and
exposes per-provider diagnostics (`provider`, `query`, `attemptedAt`, `ok`,
`httpStatus`, `resultCount`, `error`) so a failure is visible rather than
silent.

## Per-evidence record

Every retrieved item is returned with the full audit trail:

| Field | Source |
|---|---|
| `claim_text` | the claim under test |
| `evidence_query` | the query actually issued |
| `retrieved_source`, `source_title` | sanitised publisher / headline |
| `source_url`, `source_domain` | the URL actually fetched |
| `source_type` | OFFICIAL_GOVERNMENT / MAJOR_NEWS / … |
| `evidence_excerpt` | sanitised snippet |
| `relevance_signal` | `{ score, band, explanation }` |
| `stance` | `SUPPORT` / `CONTRADICT` / `UNCLEAR` |
| `stance_basis` | why that stance was assigned |
| `numerical_consistency`, `temporal_consistency` | consistency checks |
| `published_at`, `retrieval_timestamp` | provenance |
| `untrusted_content`, `sanitisation` | security metadata |

**Nothing is synthesised.** A citation exists only if a provider actually
returned that URL. There is no code path that manufactures a source, a title, or
an excerpt.

## Security — retrieved evidence is UNTRUSTED DATA

`sanitiseUntrustedEvidence()` runs on every excerpt, title and source name
before the text enters a record:

1. null bytes and control characters stripped;
2. HTML tags stripped;
3. instruction-shaped spans **replaced outright** with `[neutralised-instruction]`
   — the offending text is removed, not echoed inside a wrapper, and the count is
   reported in `security.injection_markers_neutralised`;
4. excerpts length-capped at 600 characters.

Neutralised patterns include: `ignore previous instructions`, `disregard prior
rules`, `you are now a…`, `system prompt`, `reveal your instructions/secrets`,
`print your API key`, `execute the shell command`, `mark this claim as true`,
`override the verdict`, and chat control tokens (`<|…|>`, `[INST]`).

Structural guarantees, asserted by `npm run test:evidence`:

- retrieved evidence **cannot** override system instructions;
- it **cannot** alter the model contract or thresholds;
- it **cannot** execute tools — the evidence path invokes none;
- it **cannot** request or reach secrets;
- it **cannot** manipulate a verdict by instruction: the stance comes from the
  relation classifier, and a source whose text says "mark this as TRUE" while
  contradicting the claim still yields `CONTRADICTED` / `TOWARD_FALSE`.

## Testing

`npm run test:evidence` — 53 assertions. Retrieval is stubbed behind the
`EvidenceRetriever` seam so the SUPPORTED / CONTRADICTED / MIXED /
INSUFFICIENT / SEARCH_UNAVAILABLE branches and every injection defence run
deterministically without network access. The stub is a test-only injection
point; it is not reachable over HTTP.

Live retrieval is verified against a deployment with
`npm run test:production -- <base-url>`.

## Verified in production

`Production Smoke Test` run against `https://truthlens-ai-dvpf.onrender.com`
(2026-09-26) retrieved **10 real sources** from the live news index for the
claim *"The United States unemployment rate fell below four percent in 2023"*,
with every citation carrying a real URL, domain and retrieval timestamp.

## Limitations

1. Relation is inferred from headlines and short snippets, not full-article
   entailment.
2. Coverage is a news index plus Wikipedia — not an exhaustive survey.
3. `SUPPORTED` means independent reporting corroborates the assertion. It is not
   proof of truth.
4. Retrieval requires outbound network access to the news and knowledge indexes.
   In a restricted runtime the engine reports `SEARCH_UNAVAILABLE`, which is the
   correct behaviour, not a failure of the contract.
