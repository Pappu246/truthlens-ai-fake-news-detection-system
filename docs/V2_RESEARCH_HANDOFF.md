# TruthLens V2 Research Handoff

**Status:** Research/evaluation complete for the token-free pretrained path. Production remains frozen.

## Current production boundary

- Production `main`: `32db8230547658b7d5d2a615599526d88c22fce9`
- Current V2 research branch: `3a92b32c6640c733723352fd0bb84b72baa2ca22`
- PR #26 remains open and research-only.
- PR #27 remains open/draft and research-only.
- No research branch has been merged or deployed to production.

## Final validation

- CI #109 on the current head: **SUCCESS**.
- Phase 2 Real ISOT Data Validation #76: **SUCCESS**.
- Phase 2 ISOT Pipeline Tests #80: **SUCCESS**.
- Phase 7 Real ISOT Benchmark #65: **SUCCESS**.
- V2 Model Quality External Evaluation #54: **SUCCESS**.
- Token-free harness smoke: **PASS**.
- Frozen SciFact inputs: **300 claims / 5,183 corpus documents**; exact SHA-256 verified.
- No repository `HF_TOKEN` secret is configured; hosted Hugging Face inference remains optional.

## Completed local pretrained evaluation

The primary pretrained-model comparison no longer requires a hosted-provider token.

Sealed models used:

- `Xenova/nli-deberta-v3-xsmall` — `q8@3fac2500`
- `Xenova/all-MiniLM-L6-v2` — `q8@afdb6f1a`

The evaluation covered all 300 SciFact dev claims and 469 evaluator-compatible NLI passages.

Measured component-level results:

| Metric | Heuristic | Local pretrained | Delta |
|---|---:|---:|---:|
| NLI accuracy | 0.307036 | 0.524520 | +0.217484 |
| NLI macro-F1 | 0.205958 | 0.536936 | +0.330978 |
| NLI ECE-10 | 0.141591 | 0.309079 | +0.167488 |
| Mean embedding margin | 0.039649 | 0.551816 | +0.512167 |
| Positive embedding-margin rate | 0.654255 | 1.000000 | +0.345745 |

The NLI gains are component-level model-quality evidence. The ECE result is worse for the pretrained path on this evaluation, so no calibration-improvement claim is made. The embedding result is a semantic-separation diagnostic, not exhaustive retrieval Recall@K. Final TruthLens verdict accuracy is intentionally not reported from this SciFact protocol because of the mismatch between SciFact's one-gold-paper structure and the V2 two-independent-source decision policy.

Machine-readable result: `data/v2/local_model_quality_results.json`.

## V2.5 disposition

The separately frozen V2.5 contradiction-aware evaluation remains research-only. Its experiment did not demonstrate the intended contradiction-recovery objective and is not promoted into production.

## Production safety conclusion

The research stack is additive. The existing production article/claim/evidence systems, production thresholds, source policy, abstention behavior, and deployed model artifacts are unchanged by this research branch.
