# TruthLens V2 Research Status — 2026-09-29

## Verified current state

- Production `main`: `32db8230547658b7d5d2a615599526d88c22fce9`
- Research head before this status update: `1835662df5ae6edb137a2c69e3a337e904ca1927`
- PR #26: open, unmerged, mergeable.
- CI #250: **SUCCESS**
- Phase 2 pipeline #163: **SUCCESS**
- Phase 2 validation #159: **SUCCESS**
- Phase 7 benchmark #148: **SUCCESS**
- V2 model quality #196: **SUCCESS**
- Completed SciFact runtime-equivalent benchmark: **Run #87 — SUCCESS**, artifact `11051501500`.

## SciFact release gate

Run #87 is the authoritative completed full-corpus V2 SciFact measurement. It evaluated 300 claims against 5,183 corpus documents using K=100 candidate retrieval, K=300 dense retrieval, K=8 final evidence, and sealed local NLI/embedding models.

Results:

- Open candidate recall: **60.33%**
- Gold evidence Recall@5: **73.40%**
- Directional accuracy: **34.33%**
- Directional macro-F1: **0.320335**
- Production-policy mapped accuracy: **35.33%**
- Production-policy abstention rate: **75%**

The benchmark is an external research measurement, not production accuracy.

## Verification of runtime equivalence

The completed Run #87 commit differs from the V2 runtime head only in documentation and `scripts/v2PipelineTests.ts`. The current later commit `1835662...` is also documentation-only relative to `4c0581e...`. Therefore the benchmarked SciFact runtime implementation is unchanged.

## Production boundary

The research branch changes `server/appFactory.ts` only by adding the experimental V2 route/health component. Production `main` still contains none of that change and remains at the frozen production SHA.

## Release disposition

All substantive engineering, regression, ISOT, model-quality, and end-to-end evidence gates now have completed artifacts. The remaining in-progress SciFact workflow duplicates are not new runtime evidence; they were spawned by PR-wide path matching after documentation commits.

No world-leading or universal real-world accuracy claim is supported.
