# SciFact NLI Error Review — 27 November 2026

## Scope and provenance

This is a research-only interpretation of the completed SciFact 300-claim run attached to PR #169.

- Workflow: V2 SciFact End-to-End Benchmark, run **#515** (completed successfully).
- Evaluated source commit: `57cc812367ff685aeeb93e53401fc9574f1d6753`.
- Artifact: `truthlens-v2-scifact-end-to-end`, artifact ID `13631044290`, SHA-256 `4c44153561ac40f22d030e1ae4c2b88578f9f3ac5e1c3ad1f3111810c1775cbd`.
- Dataset: frozen SciFact dev, 300 claims / 5,183 corpus documents.
- NLI: `Xenova/nli-deberta-v3-xsmall`, seal `q8@3fac2500`.
- Embedding: `Xenova/all-MiniLM-L6-v2`, seal `q8@afdb6f1a`.
- Passage cap: 1,600 source characters (the general V2 default remains 800).
- Config SHA-256: `b6cbaf74fb196d69d8c2589db1286c144e94957f41add33597fd9fc9c993e5a7`.
- Model manifest SHA-256: `f545488704f895af94b781601c3a746b2e371e30bc8cdec7431f44917d9a1832`.

The run's CI and SciFact workflow both completed successfully on the PR head. This validates execution and artifact generation, not model quality.

## Results

| Measure | 1,600-char run |
|---|---:|
| Open candidate recall | 187 / 188 = 99.47% |
| Gold evidence Hit@5 (claim-level) | 164 / 188 = 87.23% |
| Directional accuracy | 39.33% |
| Directional macro-F1 | 0.3764 |
| SUPPORT recall | 14.52% (18 / 124) |
| CONTRADICT recall | 71.88% (46 / 64) |
| NOT_ENOUGH_INFO recall | 48.21% (54 / 112) |
| Predicted CONTRADICT | 170 / 300 |
| NLI REFUTES passage labels | 350 / 2,400 |
| NLI SUPPORTS passage labels | 30 / 2,400 |
| REFUTES : SUPPORTS weighted-vote ratio | 11.97 : 1 |

The production-policy view is different and is reported separately: mapped accuracy 37.33%, abstention 74.33%, and non-abstain coverage 25.67%. Neither view should be conflated with the other.

## What the passage diagnostics show

The analyzer found:

- 66/124 SciFact SUPPORT claims were predicted CONTRADICT; all 66 had at least one retrieved passage labelled REFUTES.
- 58/112 NOT_ENOUGH_INFO claims were predicted CONTRADICT; all 58 had at least one retrieved REFUTES passage.
- 106/124 SUPPORT claims were not predicted SUPPORT.
- 18/64 CONTRADICT claims were missed.

Representative high-weight disagreements include:

- Claim 208, “CHEK2 is not associated with breast cancer,” where retrieved abstracts discuss CHEK2 and breast-cancer risk but the NLI outputs REFUTES.
- Claim 100, “All hematopoietic stem cells segregate their chromosomes randomly,” where retrieved papers discuss asymmetric segregation and stem cells, but the retrieved passage-level votes are strongly REFUTES.
- Claim 501, “Headaches are not correlated with cognitive impairment,” where retrieved studies discuss headaches and cognition, but their REFUTES outputs dominate.
- NEI examples such as the ClpC/sporulation and HNF4A/diabetes claims also receive strong REFUTES votes from topically related abstracts.

These are benchmark-label disagreements and diagnostic examples, not automatic proof that each retrieved paper is invalid or that SciFact's NOT_ENOUGH_INFO label means the opposite claim is true. The examples require claim-passage adjudication.

## Interpretation: what is and is not established

1. **Retrieval is not the dominant measured bottleneck on this split.** Candidate recall is 99.47%, while directional accuracy is 39.33%. Better retrieval alone is unlikely to repair this gap.
2. **The error is strongly directional.** REFUTES passage labels outnumber SUPPORTS by 11.67 to 1 (350 vs 30); weighted refute/support vote mass is 11.97 to 1.
3. **Increasing passage visibility did not solve the directionality problem.** The earlier 800-character baseline reported 407 REFUTES vs 25 SUPPORTS and a 16.05:1 weighted ratio. The 1,600-character run reports 350 vs 30 and 11.97:1. This is directionally better, but it is not a clean causal attribution to passage length unless all non-cap code/config differences are verified identical.
4. **The 800-character cap was a real visibility limitation.** The earlier rationale audit found only 120/366 annotated rationale sentences fully visible (32.79%). At 1,600 characters, 264/366 (72.13%) are visible. Visibility is not the same as correct entailment.
5. **The current relatedness gate is not sufficient to distinguish topical overlap from evidential relevance.** The false-refute examples contain shared entities and topic vocabulary, but that does not establish that the passage supports or contradicts the precise predicate, population, intervention, outcome, or quantifier in the claim.
6. **No threshold adjustment is justified by this report.** The evidence points to a model/representation and claim-passage alignment problem, not a safely tunable global decision threshold.

## Next research actions

1. Preserve the 800- and 1,600-character artifacts as fixed baselines; do not silently change the default passage cap.
2. Use the opt-in per-evidence trace work from PR #164 to inspect relatedness cosine, selected hypothesis pass, raw NLI probabilities, token counts, and final vote contribution for the same error cases.
3. Build a blinded, human-adjudicated error slice stratified across SUPPORT false-refutes, NEI false-refutes, true CONTRADICT, and correctly handled cases. Keep benchmark labels and retrieved evidence adjudication distinct.
4. Compare sealed NLI candidates on the same fixed claim-passage pairs first, then run end-to-end only for candidates that improve SUPPORT recall without collapsing CONTRADICT precision. Do not choose a candidate from SciFact dev alone.
5. Add tests for predicate/negation, population, intervention, outcome, temporal scope, and quantifier mismatch. Tests should assert safe abstention when a passage is merely topical, not manufacture lexical rules that decide the label.
6. Require a second untouched benchmark and the separately specified human-labelled Open-Web holdout before any production proposal.

## Safety boundary

Analysis and benchmark diagnostics only. No production model, model weights, thresholds, retrieval configuration, source-independence rule, abstention policy, or deployment behavior is changed by this document. No SciFact-dev-derived setting is approved for production.
