# TruthLens V2 — Phase 2 / Phase 7 Validation Record

## Current completed validation

Branch: `research/truthlens-v2-model-quality`

The research branch has separately completed current Phase 2 and Phase 7 validation workflows with success. These benchmarks evaluate the ISOT dataset and remain distinct from the SciFact/V2 evidence-grounding benchmark.

## Phase 2 — real ISOT data validation

Latest completed validation run: **#126** — SUCCESS.

The workflow verified the official Phase 2 dataset assets, executed the real-data preparation pipeline, and uploaded the measured preparation/split artifacts.

## Phase 7 — leakage-aware ISOT benchmark

Latest completed benchmark run: **#115** — SUCCESS.

The benchmark uses near-duplicate-aware grouping and a separate temporal test while leaving the production model artifact unchanged.

The latest measured ISOT results remain controlled dataset benchmarks, not claims of universal real-world fake-news detection accuracy. They must never be combined with SciFact, LIAR, or live-news measurements.

## Research disposition

- Production model artifacts remain unchanged.
- No Phase 2/Phase 7 benchmark result replaces the production release snapshot.
- The separate V2 SciFact benchmark is the gate for evidence-grounded research quality.
- A full current-head SciFact result must be published only from a completed artifact on the frozen 300-claim / 5,183-document setup.
