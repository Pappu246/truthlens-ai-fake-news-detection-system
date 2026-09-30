# Gate 14 Evidence Verification Release Record

## Scope

This document records the production-safe evidence verification hardening on branch
\`gate14-evidence-source-verification\` and PR #31. It is an extension of the existing
TruthLens architecture, not a production-model replacement.

## Production / research boundary

The legacy production article/claim model and \`data/saved_model_artifacts.json\` remain
outside the Gate-14 evidence changes. Semantic NLI is optional and disabled unless the
runtime explicitly enables \`TRUTHLENS_ENABLE_REMOTE_NLI=true\` with \`HF_TOKEN\`.
No new model weights are added to the production repository.

V2 SciFact and pretrained-model evaluations remain research/evaluation paths. Their
metrics must not be reported as production article-model accuracy.

## Evidence pipeline controls

1. Search candidates are not admitted as directional evidence until the publisher page
   is fetched through the SSRF-safe fetcher.
2. Redirects are revalidated at every hop, with DNS preflight and private/reserved IP
   blocking.
3. Publisher provenance is checked against the originally discovered publisher and
   explicit publisher aliases; unrelated cross-domain redirects are rejected.
4. Failed publisher fetches and failed provenance are never positive evidence.
5. Evidence text is treated as untrusted data and sanitised before semantic NLI.
6. Semantic NLI is an opt-in refinement for ambiguous relations; confidence/margin
   gates prevent low-confidence directional upgrades.
7. Source independence is clustered by content fingerprint so syndication/copying
   across domains is not automatically counted as independent corroboration.
8. Article-level support/contradiction requires evidence confidence to clear the
   calibration floor; otherwise the system abstains.
9. Retrieval diagnostics distinguish search failure, no evidence, publisher-fetch
   failure, and provenance rejection.

## Evaluation separation

The Gate-14 evidence benchmark reports SUPPORT / CONTRADICT / UNCLEAR precision,
recall, F1, confusion, coverage and abstention. It is a deterministic evidence-relation
benchmark and is not a production fake/real accuracy claim.

The existing external SciFact harness remains separately labeled as:
- token-free harness validation, or
- component-level pretrained-model evaluation,
- and full SciFact end-to-end research benchmarking.

None of those outputs alter the production model or are merged into the production
article/claim accuracy metric.

## Observability

Evidence verification emits aggregate telemetry only:
status, evidence outcome, evidence counts, provider failure counts, publisher fetch
failure counts, provenance rejections, semantic-NLI enablement, and duration.

It does not log raw claim text, article content, URLs, prompt payloads, headers, secrets,
tokens, or environment values.

## Release gates

A Gate-14 release candidate is not mergeable until all of these are green for the final
head:
- GitHub CI type-check/build and every production regression suite
- Gate-14 semantic/security/calibration tests
- evidence benchmark job
- external harness smoke job
- Vercel deployment for the final head reaches READY
- Vercel runtime error review for the final deployment is clean
- production regression confirms the existing model artifact remains unchanged
- security/SSRF/prompt-injection tests are green
- release audit reports no unexplained production/research boundary violation

A draft PR may be marked ready for review only after these gates are independently
verified. This record never asserts "world-level" performance.
