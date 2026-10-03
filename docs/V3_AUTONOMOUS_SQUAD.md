# TruthLens V3 Autonomous Research Squad

## Purpose

The Autonomous Research Squad is a research-control plane above the existing TruthLens verification system. It coordinates discovery, benchmark evaluation, verification, reporting, and gated promotion without rewriting the production architecture.

## Current boundary

The squad is research-only.

- Production model mutation: disabled.
- Automatic PR creation: disabled.
- Automatic merge: disabled.
- Automatic deployment: disabled.
- Production promotion: requires human approval.
- Benchmark scores remain benchmark-specific and never become universal real-world accuracy claims.

## Specialist agents

| Agent | Responsibility |
|---|---|
| Supervisor | Selects the next legal action and enforces phase ordering. |
| Research Scout | Consumes research-intelligence discovery artifacts. |
| Benchmark Agent | Runs only frozen/reproducible benchmark lanes. |
| Model Scout | Identifies candidate retrieval/NLI/embedding models for later evaluation. |
| Evaluator | Produces metrics, artifacts, hashes, and limitations. |
| Reliability / Red-Team | Tests adversarial and reliability failure modes when the relevant phase is unlocked; reports DEFERRED before Phase 5 rather than PASS. |
| Gatekeeper | Enforces governance, metric separation, and promotion rules. |
| Evidence Reporter | Packages auditable reports and PR-ready evidence. |

## Lifecycle

DISCOVER → QUEUE → EVALUATE → VERIFY → REPORT → HUMAN_REVIEW → PROMOTE

The current orchestrator does not pretend to have completed evaluation when a benchmark artifact does not exist. It generates a deterministic checkpoint containing the next legal actions.

## Current Phase 2 queue

From the frozen benchmark manifest:

- SciFact: verified baseline retained.
- FEVER v1: ready for reproducible scoring.
- FEVEROUS: ready for reproducible scoring.
- AVeriTeC: ready for reproducible scoring.
- TruthLens Open-Web v1: human-labelled blind holdout still required.

Phase 2 must remain active until all required benchmark-result artifacts and provenance are complete.

## Recovery / backup strategy

Every squad checkpoint records:

- deterministic checkpoint ID;
- SHA-256 of the squad config;
- SHA-256 of the benchmark manifest;
- benchmark state for every lane;
- next legal actions;
- production mutation and promotion controls.

An interrupted chat/session therefore does not become the source of truth. The repository commit plus the latest CI checkpoint artifact do.

To resume, read the latest checkpoint and continue only the actionable states. Completed baseline work is retained rather than repeated.

## Phase ordering

The squad does not authorize Phase 3, 4, 5, 6, 7, or 8 while Phase 2 exit conditions remain unmet. Autonomous execution increases throughput; it does not bypass research gates.

## Foundation exit criteria

1. Specialist responsibilities are versioned.
2. Lifecycle states are explicit.
3. Deterministic checkpoint generation exists.
4. Governance invariants fail closed.
5. CI can generate and retain a resumable checkpoint.
6. CI executes each specialist role check and records an auditable agent report.
7. Production mutation and promotion remain human-gated.

The next implementation layer is actual benchmark execution through the Benchmark Agent and Evaluator contracts, beginning with FEVER v1, FEVEROUS, and AVeriTeC while preserving the frozen Phase 2 protocol.
