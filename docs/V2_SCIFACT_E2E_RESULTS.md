# TruthLens V2 — SciFact End-to-End Benchmark Results

**Status:** Research/evaluation evidence for the V2 implementation. Production remains unchanged until PR #26 is merged.

## Latest completed runtime-equivalent result

The latest fully completed SciFact benchmark artifact is **Run #87**. Its evaluated commit predates the current documentation head, but the verified diff from Run #87's commit to the current runtime head contains only documentation files and `scripts/v2PipelineTests.ts`. No SciFact benchmark/runtime implementation file changed in that interval. Therefore Run #87 is the authoritative completed measurement for the current V2 runtime.

### Run identity

- Workflow: **V2 SciFact End-to-End Benchmark**
- Run: **#87**
- Run ID: `36597257830`
- Evaluated commit: `5275121a425a2b8a297c6a3dd375d98ac46fa2c7`
- Artifact ID: `11051501500`
- Artifact: `truthlens-v2-scifact-end-to-end`

### Frozen inputs

- Dataset: **SciFact dev**
- Claims: **300**
- Corpus documents: **5,183**
- Claims SHA-256: `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217`
- Corpus SHA-256: `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62`
- Candidate pool K: **100**
- Dense retrieval K: **300**
- Final evidence K: **8**

### Sealed research models

- NLI: `Xenova/nli-deberta-v3-xsmall`, q8@3fac2500
- Embedding: `Xenova/all-MiniLM-L6-v2`, q8@afdb6f1a

### End-to-end metrics

| Metric | Result |
|---|---:|
| Open candidate recall | **60.33%** |
| Gold evidence Recall@5 | **73.40%** |
| Directional accuracy | **34.33%** |
| Directional macro-F1 | **0.320335** |

Production-policy diagnostic view:

| Metric | Result |
|---|---:|
| Mapped accuracy | 35.33% |
| Mapped macro-F1 | 0.268870 |
| Abstention rate | 75.00% |
| Non-abstain coverage | 25.00% |
| Non-abstain accuracy | 28.00% |
| CONFLICTED rate | 4.00% |

The production-policy view is diagnostic because classic SciFact uses a one-gold-paper evidence convention while the TruthLens production policy requires two independent directional sources.

### Calibration diagnostic

Raw ECE-10: **0.368323**.  
Held-out temperature scaling reduced holdout ECE-10 from **0.333920** to **0.236281** on the benchmark diagnostic. This does not alter production confidence semantics.

### Why this is valid for the current runtime

The verified comparison from Run #87's commit `5275121a425a2b8a297c6a3dd375d98ac46fa2c7` to the previous runtime head `4c0581e199f86c278d7b8ce08d3639adeba41c2f` contains only:

- documentation changes; and
- `scripts/v2PipelineTests.ts` test changes.

No `server/v2/**`, `scripts/v2ScifactEndToEnd.ts`, model manifests, retrieval implementation, NLI implementation, embedding implementation, benchmark workflow logic, or package dependencies used by the benchmark changed in that interval.

The current research head `1835662df5ae6edb137a2c69e3a337e904ca1927` is documentation-only beyond `4c0581e`.

### Duplicate current-head workflow runs

SciFact runs #90, #91 and #92 were/are duplicate long-running validations created by PR-wide path matching after documentation commits. They are not used as independent evidence while incomplete. Their purpose is redundant confirmation; Run #87 already supplies a complete artifact for the unchanged benchmark runtime.

### Research safety

- Production `main`: `32db8230547658b7d5d2a615599526d88c22fce9`
- PR #26: research-only until this merge.
- No ISOT, LIAR, and SciFact metrics are combined.
- No universal real-world or world-leading accuracy claim is made.
