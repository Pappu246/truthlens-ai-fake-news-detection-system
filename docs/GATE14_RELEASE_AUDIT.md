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

## Current verification record (2026-10-01)

PR #31 was merged into `main` after the final research head passed the required gates.

- Final research head: `a6563c17e6897c91a1fd8a8c483df2ff5e07c824`
- Merge commit: `b1ac8df667b6a28d7e57d3c54dd25d1e9c90aace`
- Production artifact SHA: `2fc56cb65b66f842cb6ef80104ec074c47173f7c`
- Vercel production deployment: `dpl_JB8jFxR4gVbdk3mWy8nDQxZjhG3v`, target `production`, state **READY**

Final Gate-14 verification runs for the research head:

| Workflow | Run | State |
|---|---:|---|
| CI | 36751159592 | completed / success |
| Phase 2 ISOT Pipeline Tests | 36751159383 | completed / success |
| Phase 2 Real ISOT Data Validation | 36751159406 | completed / success |
| Phase 7 Real ISOT Benchmark | 36751159434 | completed / success |
| V2 Model Quality External Evaluation | 36751159391 | completed / success |
| V2 SciFact End-to-End Benchmark | 36751159351 | completed / success |
| TruthLens Research Intelligence | 36751159663 | completed / success |

The successful SciFact artifact records 300 evaluated claims over 5,183 corpus documents, with open candidate recall **60.33%**, gold-evidence Recall@5 **73.40%**, directional accuracy **34.33%**, directional macro-F1 **0.318131**, and a production-policy abstention rate of **75%**. The benchmark is research-only and does not change production thresholds, source rules, abstention policy, or model weights.

The Phase 7 ISOT artifact confirms the benchmark did not modify the production artifact. The calibrated Linear SVM raw temporal test F1 is **0.998107**; the standard test F1 is **0.994048**. These measurements retain the documented ISOT dataset-construction limitations, including fully disjoint subject values and strong Reuters-dateline asymmetry.

The Research Intelligence artifact is discovery-only, contains no paper/model errors, verifies the declared FEVER/SciFact/FEVEROUS benchmark sources as reachable, and explicitly disables automatic production modification, merge, and deployment.

External runtime probing of protected API routes still returns Vercel Authentication redirects in the connected environment; therefore no application-level API response is claimed from that probe. The public deployment itself is READY and the project currently has no grouped Vercel runtime errors in the last-hour check.

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
