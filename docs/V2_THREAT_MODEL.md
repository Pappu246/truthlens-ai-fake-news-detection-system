# TruthLens V2 Threat Model

## Assets

- User claims and article text
- Retrieved evidence
- Source URLs and provenance
- Verification verdicts
- Model artifacts
- Benchmark datasets and results
- Production policy boundaries

## Threats

### Retrieval threats
- Search misses the decisive source.
- Duplicate or near-duplicate sources create false independence.
- Low-quality pages outrank stronger evidence.
- Adversarial wording reduces retrieval recall.

### Reasoning threats
- NLI model mistakes entailment for contradiction or vice versa.
- Long-context evidence is truncated.
- A weakly related passage receives disproportionate influence.
- Contradictory evidence is collapsed into an unjustified single verdict.

### Data threats
- Train/evaluation leakage.
- Dataset version drift.
- Synthetic or fixture sources masquerading as independent external sources.
- Benchmark-specific artifacts mistaken for broad real-world performance.

### System threats
- SSRF or unsafe URL fetching.
- Unbounded source expansion.
- Malicious payloads in fetched content.
- Dependency vulnerabilities.
- Configuration changes that silently alter production behavior.

### Governance threats
- Unsupported accuracy claims.
- Hidden benchmark exclusions.
- Missing provenance.
- Human operators treating confidence as certainty.
- Research changes being deployed without production review.

## Mitigations

- Provenance is preserved with verification results.
- Evidence source independence is explicitly tested.
- Frozen datasets are hash-verified.
- Regression tests cover query diversity, retrieval contribution, and source clustering.
- CI includes dependency auditing and production/runtime regression tests.
- Research work is isolated on `research/truthlens-v2-model-quality`.
- Production main remains frozen during research evaluation.
- Abstention/conflict states prevent forced binary decisions when evidence is inadequate or inconsistent.

## Residual risk

No mitigation removes all model or retrieval error. The system should expose uncertainty and evidence rather than imply certainty beyond the benchmarked protocol.

### Temporal integrity
- Evidence published after a supplied claim date is excluded from directional reasoning when the temporal gate is enabled.
- Temporal exclusions are recorded in provenance rather than silently disappearing.
- Missing/invalid publication dates remain explicit residual risk and do not become fabricated timestamps.
