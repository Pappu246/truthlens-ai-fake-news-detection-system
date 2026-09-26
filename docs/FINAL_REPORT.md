# TruthLens AI — Final Release Audit

**Audit date:** 2026-09-26 UTC  
**Audited repository:** `Pappu246/truthlens-ai-fake-news-detection-system`  
**Source-of-truth branch:** `main`  
**Current main SHA:** `7e570a56288da85f2a90acb8d0c1dd051bd142ab`

This report records verified state only. Article and claim benchmarks are separate measurements and are not combined into one accuracy number. Neither benchmark accuracy is a guarantee of real-world fact-checking accuracy.

## Recovery and repository state

- GitHub authentication was already available to the agent and was verified with `gh auth status`.
- All remotes were fetched with `git fetch --all --prune`.
- The working tree was clean at recovery; no uncommitted local application work was reset, discarded, rewritten, or force-pushed.
- PR #19 was **not merged, not modified, and not manually resolved**. It is closed and remains outside the release path.
- A repository-wide recovery search found no tracked or untracked `docs/FINAL_REPORT.md` in the checkout at the start of this audit. No local file was deleted; this report restores the requested final-report deliverable.

## PR #23 promotion

- **PR:** [#23 — Label live-news items with `content_source` at the source](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/pull/23)
- **PR state:** Merged
- **PR head:** `3097504027f382ed65a1c194880ce561366c9d71`
- **Merge commit:** `7e570a56288da85f2a90acb8d0c1dd051bd142ab`
- **Resulting `main`:** `7e570a56288da85f2a90acb8d0c1dd051bd142ab`

The complete PR diff was inspected. It changed the RSS/Atom provider, frontend live-news fallback logic, shared news types, the contract suite, and evidence documentation. The server-side fix addresses the real defect: `/api/news/latest` now labels each feed item before it leaves the provider.

### Verified content-source semantics

- `RSS_SUMMARY_ONLY` means the feed supplied a substantive description/summary of **at least 40 words**.
- `HEADLINE_ONLY` means the feed description is empty or below 40 words.
- The provider propagates `content_source`, `is_headline_only`, and the actual feed-body `word_count` for both RSS `<item>` and Atom `<entry>` paths.
- A feed item is never assigned `FULL_ARTICLE_EXTRACTED`, even when its RSS/Atom description contains prose.
- The frontend prefers the server-provided `content_source` and retains the same 40-word rule only as a compatibility fallback for older payloads.
- `FULL_ARTICLE_EXTRACTED` belongs to the URL/article extraction path after non-empty article content has been extracted; failed extraction is rejected, and live-news partial/headline fallback paths use `RSS_SUMMARY_ONLY`, `HEADLINE_ONLY`, or `EXTRACTION_BLOCKED` as appropriate.

Local contract verification covered empty input, a sub-threshold description, the 39-word boundary, a substantive description, both parser paths, server-label preference, and the prohibition on `FULL_ARTICLE_EXTRACTED` in the RSS provider.

## Models and verified benchmarks

### Article model — ISOT benchmark

The production article model is the calibrated Linear SVM artifact `v3.0.0-isot`, trained and evaluated on the ISOT Fake News Dataset. The benchmark is a genuine held-out split, not a claim-model result.

- Dataset after cleaning: **38,656** samples
- Held-out test split: **7,732** samples
- TF-IDF vocabulary: **8,000** features, 1–2 grams, sublinear TF
- Selected model: **Linear SVM (Calibrated)** with Platt sigmoid calibration
- Held-out accuracy: **0.9959**
- Held-out precision for `FAKE (1)`: **0.9943**
- Held-out recall for `FAKE (1)`: **0.9966**
- Held-out F1 for `FAKE (1)`: **0.9954**
- Confusion matrix `[[TN, FP], [FN, TP]]`: `[[4219, 20], [12, 3481]]`

The cross-validation mean F1 is **0.9955** with standard deviation **0.0008** for the selected model. These are ISOT-distribution benchmark numbers. External validation against eligible binary LIAR claims is a domain-shift measurement, not a second article benchmark: accuracy **0.4329**, macro-F1 **0.3265**, eligible `n=790` after excluding 477 ambiguous labels. This result is why article-model accuracy must not be generalized to short political claims or current real-world news.

### Claim model — LIAR benchmark

The dedicated claim model is `1.1.0-liar-claim`, a separate calibrated Linear SVM trained for binary claim veracity. The LIAR mapping is `TRUE`/`mostly-true` to `TRUE` and `FALSE`/`pants-fire` to `FALSE`; `half-true` and `barely-true` are excluded rather than forced into a pole.

Split sizes are **6,471 train**, **799 validation**, and **802 test**. The decision threshold is fixed at **0.50** and the test split was read only after selection and calibration were frozen.

| Served variant | Test accuracy | Test macro-F1 | Test ROC-AUC | Test Brier | Test n |
|---|---:|---:|---:|---:|---:|
| `text_only` | 0.6271820449 | 0.6152909487 | 0.6797482838 | 0.2233191107 | 802 |
| `text_meta` | 0.6583541147 | 0.6469730171 | 0.7184401220 | 0.2087078341 | 802 |

`text_only` is served when usable speaker metadata is absent. `text_meta` is served only when complete metadata is supplied. The Python/Node implementation agrees on all **802/802** test rows for both variants, with maximum probability drift `2.220e-16` and zero label flips at 0.50.

### Metadata leakage finding

LIAR's five speaker credit-history columns include the accompanying statement's own verdict contribution. Leaving those counts raw produces a misleading diagnostic: the raw-credit diagnostic records **0.8004987531** test accuracy and **0.7968141369** macro-F1. The shipped `text_meta` variant subtracts the current statement's contribution before feature construction; the measured test-accuracy gap is **0.1421**. The raw-credit variant is diagnostic-only and is never served.

This is a disclosed limitation and an explicit reason not to call LIAR performance 95% or 100%.

## Evidence engine

The evidence engine is a separate retrieval-and-analysis component, not an accuracy benchmark and not a replacement for either model. It performs claim extraction, provider retrieval, relevance analysis, support/contradiction assessment, and aggregation.

Verified statuses are `SUPPORTED`, `CONTRADICTED`, `MIXED`, `INSUFFICIENT_EVIDENCE`, `NEEDS_MORE_CONTEXT`, and `SEARCH_UNAVAILABLE`. Retrieval failure or no hits never becomes a fabricated verdict. Citations are returned only for provider-supplied URLs and include source URL, domain, excerpt, stance, query, and retrieval timestamp. Retrieved text is treated as `UNTRUSTED_DATA`; instruction-shaped content is neutralised before it enters an evidence record.

The local evidence suite passed **53/53** assertions, including support, contradiction, mixed evidence, retrieval failure, no-hit handling, citation provenance, prompt-injection neutralisation, control-character/HTML sanitisation, and the guarantee that evidence does not alter the model contract.

## URL extraction and Live News

URL extraction is protected by URL validation, private/reserved-address and DNS checks, manual redirect validation, request rate limiting, timeouts, response-size limits, content-type handling, and precise HTTP semantics. Verified invalid, loopback, link-local, private-network, and `file://` requests are rejected with HTTP 400 in the contract/smoke checks. Publisher 403, 404, 429, timeout, and gateway cases retain documented status semantics.

The URL analysis flow validates, fetches, extracts, and then analyzes the freshly extracted body. It does not reuse stale prior text. Article extraction and live-news fallback responses preserve word count, extraction status, warnings, and content-source state.

The post-merge production smoke workflow verified `/api/news/latest` labels, including the invariant that headline-only items are not presented as full articles. RSS/Atom descriptions are not promoted to full article content merely because they contain `description`, `summary`, or `content` text.

## Security and test results

Local verification on the current main source passed:

- TypeScript type-check: pass
- Production build: pass
- Contract tests: **90 passed, 0 failed**
- Vercel/serverless simulation: pass
- Verdict regression suite: pass (**26** assertions)
- Claim model/integrity tests: **79 passed, 0 failed**
- Claim parity: **802/802** text-only and **802/802** text-metadata rows
- Evidence engine: **53 passed, 0 failed**
- Artifact lifecycle: **12 passed, 0 failed**
- SSRF tests: **8 passed, 0 failed**
- PR #23 required checks: green, including CI, ISOT pipeline/data validation, benchmark, and Vercel checks

`npm audit` reports **two moderate unresolved dependency advisories** in the `qs` dependency path used by Express. No audit fix was applied during this recovery task; application source and lockfile were not changed to manipulate that result.

## Production verification

The sandbox could not directly reach the Render deployment (`fetch failed`), so the POST/live checks were run by GitHub Actions as required.

- **Workflow:** [Production Smoke Test run 36241411149](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/36241411149)
- **Commit tested:** `7e570a56288da85f2a90acb8d0c1dd051bd142ab`
- **Deployment target:** `https://truthlens-ai-dvpf.onrender.com`
- **Workflow/job status:** successful
- **Smoke result:** **55 passed, 0 failed (55/55)**

The workflow covered health, article and claim metrics, claim prediction with and without metadata, evidence verification, URL extraction HTTP semantics and SSRF cases, fresh `analyze-url` content, and `/api/news/latest` content-source labels. The 55/55 result is reported only because the post-merge GitHub Actions smoke run completed successfully against the live deployment; it is not inferred from local unit tests.

## Known limitations and unresolved issues

1. The article benchmark is ISOT-distribution performance, not guaranteed current-news or real-world fact-checking accuracy.
2. The claim benchmark is a weak-signal LIAR task on short political statements. `text_meta` is metadata-conditioned and must not be read as text-only performance.
3. The five LIAR credit-history fields require careful de-leakage; the raw-credit result is diagnostic-only.
4. Evidence relation is inferred from retrieved headlines/snippets and is not proof of truth. Network restrictions can correctly produce `SEARCH_UNAVAILABLE`.
5. RSS summaries are not full article bodies. Headline-only input is withheld as `NEEDS_MORE_CONTEXT` rather than forced into a binary prediction.
6. Two moderate `qs`/Express dependency advisories remain open.
7. The current task created the requested clean README documentation separately from the merged PR #23 application fix. Historical progress notes outside the README may still describe earlier phases; they are not used as the current release metrics.

## Release decision

**Functional release status: ready for the verified scope.** PR #23 is merged, the current main checks are green, local contract/security/model-separation suites pass, and the post-merge production smoke is 55/55.

**Security caveat: not security-clean under a zero-known-advisory policy.** The two moderate dependency findings remain unresolved and should be triaged in a separate dependency-maintenance change. No experimental model-improvement phase was started, no labels or metrics were manipulated, and no article and claim benchmark numbers were combined.

## Documentation promotion

- **New README PR:** [#24](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/pull/24)
- **PR state at audit completion:** Open, documentation-only follow-up from the fixed Arena session branch; not merged in this audit.
- **PR head:** `6ebdddc` (the pushed docs commit; subsequent report update is pushed on the same docs-only PR branch).
