# TruthLens V2 — Known Limitations & Model Quality Notes

This document separates completed engineering work from unresolved scientific limitations. Production remains frozen.

## 1. Deterministic CI embeddings are not semantic embeddings

`server/v2/retrieval/embeddings.ts` retains a deterministic hashing-ngram implementation for offline CI. It is useful for reproducibility but cannot capture synonym-level semantics reliably.

The research branch also supports pretrained dense embeddings through the sealed Transformers.js/ONNX path and the optional hosted Hugging Face adapter. The full-corpus SciFact pipeline uses the sealed local pretrained embedding model.

## 2. Pretrained NLI is available and benchmarked, but end-to-end quality is still the gate

The research branch has a real pretrained pairwise NLI path using `Xenova/nli-deberta-v3-xsmall`. A completed component evaluation over SciFact reported:

- NLI accuracy: **0.524520** vs **0.311301** heuristic
- NLI macro-F1: **0.536812** vs **0.211342** heuristic
- ECE-10: pretrained **0.306362** vs heuristic **0.137249**

So pretrained NLI materially improves component classification quality, but its calibration is worse in this comparison. Component scores must not be substituted for end-to-end verification quality.

## 3. End-to-end retrieval remains the dominant disclosed bottleneck

The final completed full-corpus Gate-14 benchmark is Run #220 and measured:

- Open candidate recall: **60.33%**
- Gold-evidence Recall@5: **73.40%**
- Directional accuracy: **34.33%**
- Directional macro-F1: **0.318131**
- Production-policy abstention: **75%**

Relative to the historical Run #19 baseline, retrieval recall improved while directional task quality did not. This makes retrieval/reasoning quality the next research bottleneck rather than a reason to change production policy.

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

1. Improve Phase-2 benchmark breadth beyond SciFact so results cover textual, structured, and open-web verification settings.
2. If end-to-end quality remains weak, improve retrieval recall/reranking before changing decision policy.
3. Establish an independently labelled calibration split and versioned calibrator.
4. Evaluate broader external datasets appropriate to TruthLens' actual production use case.
5. Preserve the two-independent-source production rule unless independently justified by new evidence.
6. Keep research metrics isolated from production article/claim accuracy and require reproducible artifacts for every reported result.