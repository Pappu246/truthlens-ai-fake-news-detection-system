# TruthLens V3 Phase 2 Gate Checklist

Current phase: **Phase 2 — Multi-benchmark evaluation harness**

## Gate status

| Gate | Required | Current state |
|---|---|---|
| Phase sequencing gate | Exactly one active phase | PASS by machine-readable phase state |
| Benchmark registry | Required benchmarks registered | PASS |
| Apples-to-apples protocol | Dataset/split/evidence/metric/tuning rules | PASS |
| Run artifact schema | Provenance + metrics validation | PASS |
| FEVER adapter | Retrieval + TruthLens evaluation + official scorer wrapper | IMPLEMENTED; full run pending |
| AVeriTeC adapter | Open-web TruthLens evaluation + official scorer wrapper | IMPLEMENTED; full dev run pending |
| FEVEROUS adapter | Structured sentence/table/list/cell retrieval + evaluator + scorer | IMPLEMENTED; full run pending |
| SciFact baseline | Runtime-equivalent verified baseline | PASS |
| External open-web holdout | Independent sealed annotation | NOT YET SEALED |
| Current CI | Full repository checks | REQUIRES CURRENT-HEAD GREEN |
| Adapter smoke | Official scorer smoke checks | REQUIRES CURRENT-HEAD GREEN |
| Phase 3 entry | Blocked until Phase 2 exits | BLOCKED |

## Rules

No Phase 3 retrieval/model optimization may be merged while any Phase 2 required implementation or current-head CI gate is unresolved.

No benchmark result from this phase is a universal real-world accuracy claim.

The external holdout may remain an explicit generalization gate after Phase 2 only if that status is preserved in the handoff and Phase 2 is otherwise fully reproducible.

## Exit evidence required before merge

- current branch commit SHA;
- green CI and adapter-smoke runs for that exact SHA;
- benchmark asset manifests with immutable source/checksum provenance;
- full-run artifacts where the benchmark compute footprint is practical;
- a documented list of any remaining external/generalization gates;
- updated phase state only after all Phase 2 exit conditions are satisfied.
