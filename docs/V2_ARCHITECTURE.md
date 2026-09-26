# TruthLens V2 — Evidence-Grounded Verification (Research Stack)

> **Status: RESEARCH — NOT PRODUCTION.** This document describes
> `server/v2/**`, an additive, isolated module tree. It does not change,
> replace, or deprecate anything in `server/verification/**` (the production
> evidence engine — see `docs/EVIDENCE_ENGINE.md`), `server/mlEngine.ts`
> (production ISOT article model), or `server/claimModel.ts` (production
> LIAR claim model). All three production systems are unchanged by this work.
>
> **Two research generations exist (this doc covers both):**
> * **V2 — first vertical slice** (`truthlens-v2-vertical-slice-0.1.0`):
>   heuristic research adapters (hashing n-gram embeddings + rule-based
>   lexical NLI). Preserved verbatim as the explicit **fixture mode** for
>   lightweight tests/CI and as the recorded baseline in
>   `data/v2/eval_results_v2_baseline.json`.
> * **V2.1 — pretrained adapter upgrade**
>   (`truthlens-v2.1-pretrained-adapters-0.2.0`): the SAME pipeline with the
>   two placeholder adapters swapped for real pretrained ONNX models
>   (`Xenova/all-MiniLM-L6-v2`, `Xenova/nli-deberta-v3-xsmall`), run locally
>   and offline. Interfaces, retrieval fusion, reranking, decision policy and
>   aggregation are UNCHANGED. See `docs/V2_MODELS.md` for the model
>   inventory, seals, and runbook, and `docs/V2_BENCHMARK_PROTOCOL.md` for
>   the exact old-vs-new metrics.

## CURRENT PRODUCTION SYSTEM vs TRUTHLENS V2 RESEARCH STACK

| | **Current production system** | **TruthLens V2 research stack** |
|---|---|---|
| Code | `server/verification/**`, `server/mlEngine.ts`, `server/claimModel.ts` | `server/v2/**` |
| Endpoint | `POST /api/evidence/verify`, `POST /api/analyze` | `POST /api/v2/evidence/verify` (additive, new) |
| Core question | "Does retrieved reporting corroborate/contradict this claim?" (SUPPORTED/CONTRADICTED/MIXED/INSUFFICIENT_EVIDENCE), plus a separate ISOT style-risk score and a separate LIAR claim-veracity prior | "What does the *balance of classified, reranked, deduplicated evidence* say, with explicit abstention?" (VERIFIED/REFUTED/INSUFFICIENT_EVIDENCE/CONFLICTED) |
| Retrieval | Single-query heuristic search (Google News RSS + Wikipedia) | Query expansion (original/support/contradiction) × hybrid retrieval (BM25 lexical + embedding dense; in V2.1 the dense channel is a real pretrained sentence encoder), fused with reciprocal-rank fusion, deduplicated by canonical URL |
| Evidence relation | Rule-based relevance score + relation classifier (`SUPPORTS`/`CONTRADICTS`/`MIXED`/`IRRELEVANT`/`INSUFFICIENT`) | Dedicated NLI adapter (`SUPPORTS`/`REFUTES`/`NEUTRAL`/`UNCLEAR`) behind a swappable `NliAdapter` interface; in V2.1 backed by a pretrained MNLI cross-encoder |
| Aggregation | Rule-based counts + source-diversity discount | Weighted independent-source aggregation with an explicit, logged rule trace |
| LIAR claim model role | Reported as a fully separate block (`claim_model`), never merged | Consulted only as a capped, transparent confidence nudge; cannot flip a verdict category (see Decision Policy below) |
| Status | Frozen production baseline (`32db8230...`), 0 known vulns, 55/55 smoke | Experimental; not deployed; not gating production |

Both systems are additive and coexist. `/api/health` reports both
(`components.evidence_engine` = production, `components.v2_research_stack` =
this stack) without changing the meaning of the production fields.

## Pipeline

```
CLAIM
  ↓  queryExpansion.ts         (reuses claimExtractor; derives 3 queries:
  |                             original / support-oriented / contradiction-oriented)
QUERY EXPANSION
  ↓  retrieval/hybridRetriever.ts
  |    ├─ retrieval/bm25.ts            (lexical: Okapi BM25, dependency-free)
  |    ├─ retrieval/embeddings.ts      (dense channel contract — unchanged)
  |    │    V2  : HashingNgramEmbeddingModel        (fixture research adapter)
  |    │    V2.1: TransformerEmbeddingModel          (Xenova/all-MiniLM-L6-v2,
  |    │                                             q8, local ONNX — DEFAULT)
  |    └─ retrieval/corpusSource.ts    (FixtureCorpusSource for CI/eval,
  |                                     LiveEvidenceProviderCorpusSource wraps
  |                                     the EXISTING production evidenceProvider)
  |    fusion: reciprocal rank fusion; dedup: canonical URL (reuses
  |    server/security/urlValidator.ts#normalizeUrl)
HYBRID RETRIEVAL (candidates, full provenance metadata attached)
  ↓  rerank/reranker.ts        (lexical + semantic + source-quality [reuses
  |                             evidenceAnalyzer#determineSourceType] +
  |                             freshness + independence/duplicate-detection)
RERANKING
  ↓  nli/nliAdapter.ts         (evidence classification contract — unchanged)
  |    V2  : HeuristicNliAdapter                   (fixture research adapter)
  |    V2.1: PretrainedNliAdapter                  (Xenova/nli-deberta-v3-xsmall,
  |                                               q8, local ONNX — DEFAULT)
EVIDENCE CLASSIFICATION (SUPPORTS / REFUTES / NEUTRAL / UNCLEAR, + model/version)
  ↓  decision/decisionPolicy.ts
AGGREGATION + ABSTENTION (VERIFIED / REFUTED / INSUFFICIENT_EVIDENCE / CONFLICTED)
  ↓  provenance.ts
PROVENANCE  (single serializable record; exposed via POST /api/v2/evidence/verify)
```

Orchestrated by `server/v2/pipeline.ts#verifyClaimV2()`.

## Adapter resolution (V2.1) — which adapters run, and when

`server/v2/ml/modelResolution.ts` is the single decision point:

* **Default: pretrained (V2.1).** The real ONNX adapters are resolved when
  no adapters are injected explicitly. Requires the sealed model files
  (`npm run download:v2-models`) and, when expected-but-absent or corrupt,
  fails CLOSED with a `ModelUnavailableError` containing remediation — never
  a silent swap to heuristics.
* **Fixture mode (V2 first-slice research adapters).** Only when
  `TRUTHLENS_V2_MODEL_MODE=fixture` is set explicitly. Used by
  `scripts/v2PipelineTests.ts` and `scripts/v2RouteTests.ts` (lightweight,
  deterministic, model-free CI) and reproduced as the recorded baseline.
  Fixture mode is always disclosed in provenance (`models.*` identity +
  limitations text).
* **Explicit injection.** `V2PipelineOptions.nliAdapter` /
  `HybridRetrievalOptions.embeddingModel` still take any implementation of
  the unchanged interfaces (swappability contract preserved).

The pretrained adapters run in a single dedicated worker thread
(`server/v2/ml/mlWorker.cjs`, CJS, hard-offline: `HF_HUB_OFFLINE=1`,
`allowRemoteModels=false`) behind a synchronous SharedArrayBuffer/Atomics
facade (`server/v2/ml/mlWorkerClient.ts`) — purpose-built so the ORIGINAL
synchronous `EmbeddingModel.embed()` / `NliAdapter.classify()` contracts did
not need to change. Models load once per process (lazy), never per request.
Every provenance record carries `models: {embedding:{name,version,dimensions},
nli:{name,version}}` with content-sealed version strings (`q8@<sha256-8>`) —
see `docs/V2_MODELS.md`.

## Reused abstractions (no duplicated functionality)

* `server/verification/claimExtractor.ts` — claim parsing, entity/number/date
  extraction, search-query generation (`buildClaim`/`generateSearchQueries`).
* `server/verification/evidenceAnalyzer.ts` — `determineSourceType`,
  `checkNumericalConsistency`, `checkTemporalConsistency`.
* `server/verification/evidenceEngine.ts` — `sanitiseUntrustedEvidence`
  (prompt-injection neutralisation) is called on every passage, title, and
  publisher string that V2 stores or returns.
* `server/security/urlValidator.ts` — `normalizeUrl` (canonical URL dedup),
  `validateUrlSecurity`/`safeFetchHtml` (SSRF-safe fetch, used by the
  optional full-text enrichment step).
* `server/extraction/articleExtractor.ts` — `extractArticleFromHtml`, reused
  by the optional full-text enrichment step.
* `server/verification/evidenceProvider.ts` — the existing, already-shipped
  Google News RSS + Wikipedia retrieval is wrapped as one `CorpusSource`
  (`LiveEvidenceProviderCorpusSource`), not reimplemented.
* `server/claimModel.ts` — the existing LIAR claim model supplies the
  optional prior signal.

No second SSRF guard, no second URL canonicaliser, no second claim parser, no
second HTML extractor was introduced.

## Decision policy summary

See `server/v2/decision/decisionPolicy.ts` for the full, commented rule set.
In short:

1. Evidence with label `SUPPORTS`/`REFUTES` votes with weight
   `nli.confidence × rerankScore × (0.35 if duplicate/syndicated cluster else 1.0)`.
   `NEUTRAL`/`UNCLEAR` evidence never votes.
2. If total voting weight is below a weak-evidence threshold →
   `INSUFFICIENT_EVIDENCE` (abstain).
3. If support and refute weight are both non-trivial and comparable (ratio
   ≥ 0.6) → `CONFLICTED` (abstain).
4. Otherwise the dominant side needs **at least 2 independent domains** and
   total weight above a strength threshold to produce `VERIFIED`/`REFUTED`;
   short of that, the system abstains (`INSUFFICIENT_EVIDENCE`) rather than
   forcing a directional verdict from thin evidence.
5. The LIAR prior is recorded and, if it agrees with an evidence-driven
   `VERIFIED`/`REFUTED` verdict, nudges confidence up by a small capped
   amount; if it disagrees, the disagreement is recorded explicitly
   (`priorAgreesWithEvidence: false`, plus a `prior_disagreement_recorded_not_applied`
   entry in `decision_rule_trace`) and confidence is nudged down slightly —
   **the verdict category itself never changes because of the prior.**
   When the decision abstains, the prior never converts that abstention into
   a directional verdict.

## API

`POST /api/v2/evidence/verify` — body `{ "claim": "..." }` — returns
`{ available, claim, provenance }` where `provenance` is the full
`ProvenanceRecord` (see `server/v2/types.ts`). This endpoint is additive; the
production `/api/evidence/verify` and `/api/analyze` endpoints, and their
response shapes, are unchanged.
