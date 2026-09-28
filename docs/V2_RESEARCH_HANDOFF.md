# TruthLens V2 Research Handoff

**Status:** Research/evaluation complete for the token-free path. Production remains frozen.

## Current production boundary

- Production `main`: `32db8230547658b7d5d2a615599526d88c22fce9`
- V2 research branch: `d319c03690edfa2e4a70b61080f8b2b7256dbc53`
- PR #26 remains open and research-only.
- PR #27 remains open/draft and research-only.
- No research branch has been merged or deployed to production.

## V2 validation

- Latest CI run #92: SUCCESS.
- Type-check and production build: PASS.
- Production contract suite: 90/90.
- V2 pipeline tests: PASS.
- V2 route tests: PASS.
- V2 model-quality tests: PASS.
- Token-free external harness smoke: PASS.
- Frozen SciFact inputs verified by exact SHA-256 and expected counts: 300 claims / 5,183 corpus documents.
- Remote pretrained-model evaluation: not executed because repository `HF_TOKEN` is not configured.
- No pretrained-model metrics are claimed without the required credential.

## Token-free harness scope

The external harness smoke test validates the frozen evaluation inputs and exercises the NLI/embedding adapter request-response contracts through mocked transport. It is a harness-integrity check only; it is not a pretrained-model benchmark.

## V2.5 external evaluation disposition

The frozen external V2.5 evaluation completed successfully but remains research-only. The measured run showed higher final accuracy but lower macro-F1, NLI quality, coverage, and directional recall, with increased abstention. It is therefore preserved as an experiment rather than promoted into production.

## Hosted-provider comparison

The original hosted Hugging Face comparison remains optional and requires a GitHub Actions repository secret named `HF_TOKEN`. It is not needed for the primary pretrained-model evaluation anymore.

A token-free local evaluation path now uses the already sealed pretrained research models:

- `Xenova/nli-deberta-v3-xsmall` q8@3fac2500
- `Xenova/all-MiniLM-L6-v2` q8@afdb6f1a

The workflow provisions those exact model bytes from pinned GitHub mirrors, verifies their SHA-256 seals, and evaluates all 300 SciFact dev claims locally. This removes the previously identified HF-token blocker for the primary pretrained-model evaluation.

## Production safety conclusion

The research stack remains additive. The existing production article/claim/evidence systems, production thresholds, source policy, abstention behavior, and deployed model artifacts are unchanged by this research branch.
