# TruthLens V2 — Known Limitations & Model Quality Notes

This document separates completed engineering work from unresolved scientific limitations. Production remains frozen.

## 1. Deterministic CI embeddings are not semantic embeddings

`server/v2/retrieval/embeddings.ts` retains a deterministic hashing-ngram implementation for offline CI. It is useful for reproducibility but cannot capture synonym-level semantics reliably.

The research branch also supports pretrained dense embeddings through the sealed Transformers.js/ONNX path and the optional hosted Hugging Face adapter. The full-corpus SciFact pipeline uses the sealed local pretrained embedding model.

## 2. Pretrained NLI is available and benchmarked, but end-to-end quality is still the gate

The research branch has a real pretrained pairwise NLI path using `Xenova/nli-deberta-v3-xsmall`. A completed component evaluation over SciFact reported:

- NLI accuracy: **0.524520** vs **0.307036** heuristic
- NLI macro-F1: **0.536936** vs **0.205958** heuristic
- ECE-10: pretrained **0.309079** vs heuristic **0.141591**

So pretrained NLI materially improves component classification quality, but its calibration is worse in this comparison. Component scores must not be substituted for end-to-end verification quality.

## 3. End-to-end retrieval remains the dominant disclosed bottleneck

The latest completed full-corpus end-to-end benchmark (Run #19) measured:

- Open candidate recall: **53.67%**
- Gold-evidence Recall@5: **68.09%**
- Directional accuracy: **37.00%**
- Directional macro-F1: **0.341899**

The current branch adds dense retrieval, preserves diversified extractor queries, and improves source-independence handling, but a complete current-head 300-claim rerun has not yet produced an artifact. Therefore no improvement is claimed.

## 4. Source independence is still policy-sensitive

Real web domains continue to be clustered by registrable domain to avoid counting the same publisher as independent evidence. Synthetic `.local/document/<id>` benchmark URLs are treated per document so the benchmark does not collapse the entire corpus into one source cluster.

This is a benchmark-specific accommodation; production source independence remains unchanged.

## 5. Conflict resolution remains rule-based

The decision policy uses independent material evidence from both sides and records a deterministic conflict trace. It is not a learned discourse-reasoning model.

Temporal disagreement, source hierarchy, claim scope, and multi-hop dependencies can still create difficult cases.

## 6. Confidence calibration is diagnostic, not productionized

The research benchmark now records raw ECE/Brier and a held-out temperature-scaling diagnostic. Runtime production confidence is deliberately not changed.

Before any production confidence update, a versioned calibration artifact must be fitted on an independently labelled calibration set and evaluated on a separate holdout.

## 7. Evidence completeness is limited

The production evidence engine still relies on provider retrieval and short evidence excerpts. Full-text enrichment exists but remains opt-in in V2 to keep the first research slice deterministic and reduce network/SSRF exposure.

## 8. External benchmark scope remains narrow

SciFact is a scientific evidence benchmark, not a current-news or political-fact-checking benchmark. The LIAR and ISOT measurements are separate tasks and must never be combined with SciFact or each other.

## 9. Research workflow reliability is separate from model quality

Long-running 300-claim GitHub Actions jobs have experienced cancellations before artifact publication. This is treated as an evaluation-infrastructure issue, not as a successful/failed model result. The heavy workflows now:

- avoid duplicate push+PR execution;
- ignore docs-only changes;
- do not auto-cancel active runs;
- use extended timeouts;
- rerun canceled jobs without changing research code.

## What remains before any production proposal

1. Complete current-head SciFact Run #57 and compare it against the frozen Run #19 baseline.
2. Complete current-head Phase 7 ISOT Run #130 and keep its dataset/model task separate from SciFact.
3. If end-to-end quality remains weak, improve retrieval recall/reranking before changing decision policy.
4. Establish an independently labelled calibration split and versioned calibrator.
5. Evaluate broader external datasets appropriate to TruthLens' actual production use case.
6. Preserve the two-independent-source production rule unless independently justified by new evidence.
7. Do not merge or deploy PR #26 solely from component-level model improvements or a single benchmark.