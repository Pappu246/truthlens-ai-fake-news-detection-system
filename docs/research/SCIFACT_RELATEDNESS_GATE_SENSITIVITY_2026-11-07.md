# SciFact Relatedness-Gate Sensitivity Audit

**Date:** 2026-11-07  
**Scope:** Research-only post-hoc diagnostic; no production changes  
**Source run:** GitHub Actions run [41884274439](https://github.com/Pappu246/truthlens-ai-fake-news-detection-system/actions/runs/41884274439)  
**Source branch commit:** `e52915ffd674c8757a8141c73c49ff366193bdcd` (workflow evaluated PR merge snapshot `4da43d127f45a405c32aa220a7d591cbcae3bbdc`)

## Dataset and trace integrity

- SciFact dev: 300 claims, 5,183 corpus documents.
- Gold evidence-bearing claims: 188.
- Annotated gold evidence IDs: 209 (138 SUPPORT, 71 CONTRADICT).
- Open candidate recall: 187/188 (99.47%).
- Gold evidence Recall@5: 164/188 (87.23%).
- Per-evidence trace entries: 2,400.
- Trace contract and denominator/provenance validator: PASS.

## Baseline end-to-end benchmark

- Directional accuracy: **36.67%**.
- Macro-F1: **35.42%**.
- SUPPORT recall: 15.32%.
- CONTRADICT precision: 26.63%.
- NOT_ENOUGH_INFO recall: 41.07%.
- Predictions: SUPPORT 19, CONTRADICT 169, NOT_ENOUGH_INFO 112.
- Gold NOT_ENOUGH_INFO claims misclassified as CONTRADICT: 66/112.

This is not a production-article accuracy score. The benchmark uses a single-direction evidence tally for SciFact's single-paper evidence setup; production's two-independent-source rule is reported separately.

## Counterfactual relatedness-floor sensitivity

The following recomputes the benchmark's single-direction evidence tally from the persisted traces, excluding a passage when its recorded claim/passage cosine is below the listed floor. It does not rerun retrieval or NLI.

| Relatedness floor | Accuracy | Macro-F1 | SUPPORT recall | CONTRADICT precision | NEI recall | Predicted CONTRADICT |
|---:|---:|---:|---:|---:|---:|---:|
| 0.15 (baseline) | 36.67% | 35.42% | 15.32% | 26.63% | 41.07% | 169 |
| 0.25 | 38.00% | 36.57% | 15.32% | 27.44% | 44.64% | 164 |
| 0.35 | 40.33% | 38.63% | 16.13% | 28.67% | 51.79% | 150 |
| 0.45 | 44.33% | 41.75% | 16.94% | 32.77% | 65.18% | 119 |
| 0.50 | 45.67% | 42.02% | 15.32% | 35.71% | 74.11% | 98 |

### Gold-evidence retention and false-refutation trade-off

Of the 209 annotated gold evidence IDs, 182 were present in the top-eight evidence trace (127 SUPPORT, 55 CONTRADICT).

| Floor | SUPPORT gold evidence retained | CONTRADICT gold evidence retained | NEI REFUTES votes retained (of 149) |
|---:|---:|---:|---:|
| 0.15 | 127/127 | 55/55 | 149 |
| 0.35 | 125/127 | 55/55 | 112 |
| 0.45 | 118/127 | 53/55 | 78 |
| 0.50 | 112/127 | 50/55 | 55 |

At 0.50, 94/149 (63.1%) of NEI false-refutation evidence votes are filtered, while 88.2% of gold SUPPORT evidence already present in the top-eight trace and 90.9% of gold CONTRADICT evidence already present are retained. This does **not** mean the higher floor is validated: the retained evidence counts are conditional on retrieval and on the original 0.15 gate having run NLI.

## Interpretation

1. Candidate retrieval is not the only bottleneck. The top-five gold-evidence hit rate is 87.23%, but the final benchmark still overpredicts CONTRADICT.
2. The current 0.15 relatedness floor lets through many passages that the NLI model then labels REFUTES with high confidence, including on NOT_ENOUGH_INFO claims.
3. A stricter floor improves this particular dev-set counterfactual, but it also removes gold SUPPORT and CONTRADICT evidence. Choosing a floor from this same dev split would be test-set leakage / threshold tuning.
4. SUPPORT recall remains poor at every tested floor. Gate tightening alone cannot solve missed entailment.
5. The gold-rationale sentence diagnostic also improved over full abstracts (39.94% vs 21.60% accuracy), but rationale sentences are oracle inputs and cannot be treated as open-retrieval performance.

## Decision and next validation

- **Do not change the production or research default relatedness threshold from this result alone.**
- Keep the current DeBERTa model; the matched SciFact candidate comparison found the tested DistilBERT candidate materially worse.
- Next experiments should use non-oracle sentence/window retrieval and validate any gate policy on an untouched held-out dataset before adoption.
- No model weights, production thresholds, abstention rules, source policies, or deployment settings were changed by this audit.
