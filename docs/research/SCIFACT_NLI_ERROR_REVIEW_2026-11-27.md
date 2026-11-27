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


## Per-evidence trace audit — separate 800-character run

A second, distinct artifact from PR #164 supplies the missing per-passage model traces:

- Workflow run **#514**, artifact ID `13634084786`, artifact SHA-256 `466992d6ce3099a3b2791522b4eaad7abd5d2f19fd1d3a562b703a0adc486945`.
- Evaluated source commit: `72ef852e7e296bf39bf4534301af85ace0de1bdb`.
- Trace was explicitly enabled and the artifact records `research_trace_enabled=true`.
- 300 claims / 2,400 evidence passages; 2,270 passages reached NLI and 130 were stopped by the relatedness gate.
- Passage labels: 402 REFUTES, 29 SUPPORTS, 1,958 NEUTRAL, 11 UNCLEAR.
- None of the 2,270 NLI inputs reached the 384-token maximum; the largest post-tokenization sequence was 331 tokens.

For false-refutation passages in this trace, mean relatedness cosine was 0.490 on SUPPORT claims and 0.455 on NOT_ENOUGH_INFO claims, versus 0.505 on CONTRADICT claims. This is substantial overlap: the current bi-encoder similarity score does not reliably separate evidential relevance from topical similarity.

### Post-hoc relatedness-floor sensitivity (not a deployable result)

The saved traces permit a deterministic counterfactual re-tally without rerunning retrieval or NLI:

| Relatedness floor | Accuracy | Macro-F1 | SUPPORT recall | NOT_ENOUGH_INFO recall | Predicted CONTRADICT |
|---:|---:|---:|---:|---:|---:|
| 0.15 | 36.67% | 35.42% | 15.32% | 41.07% | 169 |
| 0.25 | 38.00% | 36.57% | 15.32% | 44.64% | 164 |
| 0.35 | 40.33% | 38.63% | 16.13% | 51.79% | 150 |
| 0.45 | 44.33% | 41.75% | 16.94% | 65.18% | 119 |
| 0.50 | 45.67% | 42.02% | 15.32% | 74.11% | 98 |
| 0.55 | 45.00% | 39.73% | 11.29% | 81.25% | 80 |
| 0.60 | 42.67% | 35.66% | 8.87% | 85.71% | 56 |

At 0.50, 94/149 (63.1%) of REFUTES passage votes on NOT_ENOUGH_INFO claims are filtered. However, only 112/127 (88.2%) of the retrieved gold SUPPORT evidence IDs and 50/55 (90.9%) of retrieved gold CONTRADICT evidence IDs remain. The metric peak at 0.50 is a same-dev-set counterfactual and is therefore vulnerable to selection bias. It is **not** a recommendation to change the 0.15 gate.

This trace also shows why the 384-token limit is not the leading explanation for this run: no input reached it. The separate character-window visibility issue is real, but it cannot explain the whole directionality failure.


### Critical check: how NLI labels the annotated gold evidence itself

I joined the 1,600-character run's retrieved evidence diagnostics against each claim's annotated gold evidence document IDs. This avoids confusing arbitrary retrieved passages with the evidence SciFact actually annotated.

- Among **127 retrieved gold SUPPORT documents**, NLI labelled only 14 SUPPORTS (11.0%), 16 REFUTES (12.6%), 94 NEUTRAL (74.0%), and 3 UNCLEAR.
- Among **55 retrieved gold CONTRADICT documents**, NLI labelled 22 REFUTES (40.0%), 32 NEUTRAL (58.2%), and 1 UNCLEAR.
- Most importantly, among **90 gold SUPPORT documents for which every annotated rationale sentence was visible inside the 1,600-character passage**, only 13 were labelled SUPPORTS; 66 were NEUTRAL and 9 REFUTES.

This rules out a simplistic explanation that the system only misses support because retrieval never finds the gold paper or because every rationale is truncated. Even when the annotated rationale is visible in a retrieved gold document, the current NLI model often fails to emit SUPPORTS. It does not prove that every such passage should be labelled SUPPORTS without reading the exact claim/rationale pair, but it makes NLI task-fit and biomedical entailment the primary next research target.


### Paired rationale-vs-abstract diagnostic

The trace-enabled PR #164 artifact also includes 338 paired claim/document rationale examples, using the same frozen model and claim:

- Full-abstract condition: 21.60% accuracy, macro-F1 0.2311.
- Gold-rationale-sentence condition: 39.94% accuracy, macro-F1 0.3740.
- Rationale condition correct while full abstract was wrong: 80 pairs; reverse transition: 18; both correct: 55; both wrong: 185.

This is consistent with the model benefiting from focused evidence, but the rationale condition is an oracle input and is not length-matched to the abstract condition. It therefore does **not** isolate context dilution, and it is not an attainable open-retrieval score. The next clean experiment should compare length-matched context windows around the annotated rationale against the rationale-only passage, while retaining a separate untouched evaluation set.


### Sealed DistilBERT candidate comparison — existing run #683

I retrieved and inspected the full local-pretrained evaluation artifact from V2 Model Quality External Evaluation run **#683** (run ID `46014924334`, artifact ID `15218891711`, SHA-256 `b1f64be08dd5b988baf5eb45053398749a0ff52b42307d45af17e2af13a36f40`). The artifact is tied to merge commit `913499bb89609cf23f71b07bc1e4c75ae809d778` (`refs/pull/176/merge`), not the PR head; preserve that provenance distinction.

On the same 469 frozen SciFact gold evidence/cited-neutral passages, with the same MiniLM relatedness gate and 384-token limit:

| Metric | DeBERTa-v3-xsmall baseline | DistilBERT-MNLI candidate |
|---|---:|---:|
| Accuracy | 52.67% | 34.12% |
| Macro-F1 | 53.86% | 35.95% |
| SUPPORT recall | 28.70% | 22.22% |
| REFUTE recall | 59.84% | 40.98% |
| NEUTRAL recall | 85.50% | 47.33% |
| Coverage (not UNCLEAR) | 97.65% | 97.44% |
| Selective accuracy | 53.93% | 35.01% |

The candidate is **18.55 percentage points worse** in accuracy and 17.91 points worse in macro-F1. It is not a viable replacement based on this diagnostic. Its mean reported confidence is higher (0.894 vs 0.831) despite substantially lower accuracy. A ten-bin top-label confidence calibration audit computed from the per-row artifact gives ECE 0.552 for DistilBERT versus 0.304 for DeBERTa; this is an auxiliary diagnostic, not a substitute for a held-out calibration study. Of the candidate's 309 incorrect predictions, 228 carry reported confidence >=0.90. These are strong warning signs against interpreting its raw confidence as trustworthy.

The main candidate failure pattern is an overuse of NEUTRAL: it predicts NEUTRAL 265 times, including 139/216 gold SUPPORT and 64/122 gold REFUTE passages. This is not merely a SUPPORT-vs-REFUTE direction swap. On this exact SciFact component test, keep DeBERTa-v3-xsmall as the research baseline and do not promote DistilBERT. This conclusion is limited to the same 469 dev passages; it does not prove superiority on live news, FEVER, AVeriTeC, or unseen domains.

The separately registered DeBERTa-v3-base MNLI+FEVER+ANLI candidate remains **unsealed** in the manifest. Do not fabricate hashes or treat it as evaluated. Its provisioning requires access to the actual ONNX bytes and independent SHA-256 seals.

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


### Independent exact-head rerun: sealed DistilBERT comparison — run #690

A second completed local-pretrained evaluation is available from V2 Model Quality External Evaluation run **#690** (run ID `46046378971`, artifact ID `15223227924`, artifact SHA-256 `2eeba061079e486412edaa7ab3e3ce788889358c7a8cedcdb94f70a6737813b0`). Its candidate comparison file records source commit `f733b248934dac39d16f7d8824cd6dec67daac86` on `refs/pull/176/merge`; it is not PR #176's head commit. The dataset and 469 matched evidence/cited-neutral pairs are the same frozen SciFact dev inputs. This is an independent rerun, not a replacement of run #683's recorded result.

| Metric | DeBERTa-v3-xsmall baseline | DistilBERT-MNLI candidate |
|---|---:|---:|
| Accuracy | 51.81% | 34.33% |
| Macro-F1 | 53.05% | 36.10% |
| SUPPORT recall | 29.17% | 22.69% |
| REFUTE recall | 59.84% | 40.98% |
| NEUTRAL recall | 81.68% | 47.33% |
| Coverage | 98.08% | 98.08% |
| Selective accuracy | 52.83% | 35.00% |

DistilBERT is 17.48 percentage points lower in accuracy and 16.95 points lower in macro-F1. On this second run, a ten-bin top-label ECE calculation from the per-row artifact is 0.550 for DistilBERT and 0.314 for DeBERTa; mean reported confidence is 0.894 vs 0.832. Of 308 candidate errors, 226 have confidence >=0.90. DistilBERT predicts NEUTRAL 265 times, including 139/216 gold SUPPORT and 64/122 gold REFUTE passages. This independently reinforces the decision not to promote DistilBERT on this component diagnostic.

The exact numbers differ modestly from run #683 (for example, DeBERTa accuracy 51.81% here vs 52.67% there). Preserve both artifacts and their distinct source commits/config provenance; do not average or silently overwrite them. Both runs reject this DistilBERT candidate. These are dev-set component diagnostics, not production or world-level accuracy.

The same run #690's separate heuristic-vs-pretrained component report gives 469 passages: heuristic NLI accuracy 30.92% / macro-F1 20.60%, versus sealed DeBERTa-v3-xsmall 52.45% / 53.68%. The pretrained embedding diagnostic has 188 comparisons and mean gold-vs-negative cosine margin 0.552 versus 0.040 for the hashing-ngram heuristic. These support using the sealed pretrained components as research baselines, but do not establish end-to-end retrieval or verdict performance.
