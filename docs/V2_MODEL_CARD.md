# TruthLens V2 Model Card

## Scope

TruthLens V2 is a research implementation of evidence-grounded claim verification. It is not the production decision policy and must not be interpreted as a production accuracy claim.

Pipeline:

claim extraction -> query expansion -> hybrid retrieval -> evidence reranking -> pretrained NLI -> aggregation/abstention -> provenance.

## Intended use

- Research on evidence-grounded fact verification.
- Reproducible benchmarking of retrieval, entailment, contradiction, abstention, and provenance.
- Demonstration of auditable verification decisions.

## Out of scope

- Autonomous publication moderation without human review.
- High-stakes decisions based only on a TruthLens verdict.
- Claims that benchmark performance transfers unchanged to arbitrary live news domains.

## Decision vocabulary

- VERIFIED
- REFUTED
- INSUFFICIENT_EVIDENCE
- CONFLICTED

The research pipeline preserves provenance for evidence used in a decision.

## Known evaluations

### SciFact

Frozen evaluation inputs:
- 300 development claims
- 5,183 corpus documents
- claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`

Last completed full-corpus baseline before the corrected workflow-head rerun:
- Candidate K=100
- Dense K=300
- Final evidence K=8
- Open candidate recall: 0.536667
- Gold-evidence Recall@5: 0.680851
- Directional accuracy: 0.370000
- Directional macro-F1: 0.341899

These figures are benchmark measurements only.

### Local pretrained component evaluation

On the frozen SciFact development inputs:
- pretrained NLI accuracy: 0.524520
- pretrained NLI macro-F1: 0.536936
- pretrained ECE-10: 0.309079
- heuristic accuracy: 0.307036
- heuristic macro-F1: 0.205958
- heuristic ECE-10: 0.141591

The pretrained component materially outperformed the heuristic on accuracy and macro-F1 in this component evaluation, while calibration was worse; no calibration-improvement claim is made.

## Limitations

- Evidence retrieval recall is not sufficient by itself to establish correct final verification.
- SciFact is scientific-claim focused and is not representative of all news domains.
- ISOT is a benchmark dataset and does not establish real-world misinformation detection performance.
- Hosted external model comparison is optional and may be unavailable without credentials.
- Confidence scores are not guarantees of truth.
- Conflicting or low-evidence claims should remain abstained or explicitly conflicted.

## Safety

TruthLens should surface evidence and uncertainty rather than manufacture certainty. Human review remains appropriate for consequential claims.

## Production boundary

This model card describes the research branch only. Production main retains its independent source rule, thresholds, deployment policy, and model artifacts unless explicitly reviewed and changed through the normal release process.

## Temporal evidence integrity

When a claim date is available, the V2 research pipeline can enforce a publication-time cutoff so evidence published after the claim cannot contribute to directional reasoning. The cutoff and number of excluded candidates are preserved in provenance. This is disabled only when no valid claim date is supplied or when explicitly overridden for a research ablation.
