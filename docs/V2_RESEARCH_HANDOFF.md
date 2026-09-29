# TruthLens V2 Research Handoff

**Status:** V2 research pipeline is merged into production. Future work must continue in the staged V3 research roadmap; do not restart V2 or rework completed production contracts.

## Verified production state

- Production `main`: `1c2eb483d186b9569d1ff944689fb6fbc94d36b0`
- PR #26: merged.
- Post-merge CI: SUCCESS.
- Post-merge Production Smoke Test: SUCCESS.
- Live Render smoke: **55/55 checks passed**.
- Committed dependency audit at the merge gate: **0 vulnerabilities**.

## V2 scientific state

The V2 runtime is now part of `main`. Its benchmark claims remain task- and dataset-specific.

Latest completed runtime-equivalent SciFact benchmark artifact:

- Claims: 300
- Corpus documents: 5,183
- Open candidate recall: **60.33%**
- Gold evidence Recall@5: **73.40%**
- Directional accuracy: **34.33%**
- Directional macro-F1: **0.320335**
- Production-policy abstention: **75%**
- Calibration diagnostic: ECE improved from **0.333920** to **0.236281** with temperature 4 on the diagnostic holdout.

These are research benchmark measurements, not universal real-world truth-detection accuracy.

## Production boundary

The V2 route is additive. Existing article, claim, URL extraction, live-news, evidence, security, and model-artifact contracts were preserved and re-verified after merge.

Future changes must preserve:
1. production/research metric separation;
2. explicit abstention and provenance semantics;
3. security and dependency gates;
4. benchmark reproducibility and frozen-input hashes;
5. no blind automatic promotion of candidate models.

## Next research program

The next stage is **TruthLens V3: Continuous Research & Verification Quality**. The master sequencing contract is:
`docs/V3_RESEARCH_MASTER_PLAN.md`

The phases are strictly sequential. A later phase may not be declared complete until its predecessor's exit gates are documented and green.

No claim of "world-leading accuracy" is currently made. Such a claim requires reproducible, apples-to-apples, independently verifiable benchmark evidence against the relevant current state of the field.
