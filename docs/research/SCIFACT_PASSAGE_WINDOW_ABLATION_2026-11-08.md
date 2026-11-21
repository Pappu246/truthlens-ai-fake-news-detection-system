# SciFact Passage-Window Ablation — 8 November 2026

## Motivation

The exact-head passage diagnostics in PR #169's run 485 (commit `92de28ed61288c9850e234d8c4503f0b0a3728e3`) reported:

- 366 gold rationale sentences across 209 gold evidence documents.
- Only 120/366 rationale sentences (32.79%) ended within the V2 pipeline's 800-character sanitized passage limit.
- 246/366 (67.21%) were beyond the limit and therefore not visible to the NLI adapter in that benchmark run.

This is a diagnostic computed from frozen gold rationale indices. Gold indices are never passed into retrieval, NLI, or verdict decisions. It is evidence of a serious measurement confound, not proof that truncation caused the false contradictions.

The earlier paired diagnostic compared full-abstract predictions (subject to the 800-character pipeline cap) with gold-rationale sentence passages (not subject to the same cap). That comparison is not context-length matched and must not be interpreted as isolating context dilution alone.

## Experiment

This branch adds a bounded, opt-in `passageMaxChars` option to the V2 research pipeline:

- Default remains 800 characters for every existing caller.
- Valid source-text cap is 1–8,000 characters; invalid values fail closed. When sanitization truncates, its existing three-character `...` marker is appended, so the final NLI passage can be up to cap + 3 characters.
- The exact sanitized passage supplied to NLI is the passage recorded in provenance; truncation-marker length is accounted for separately.
- The SciFact benchmark includes `passage_max_chars` in the sealed run config and in its config SHA-256.
- The 800-character baseline is PR #169's exact-head artifact; this branch runs the same frozen SciFact dev inputs, sealed model manifest, retrieval settings, NLI model, and decision thresholds with a 1,600-character passage window.

The 1,600-character source-text cap is an experimental condition, not a recommended production setting or a tuned threshold. The final passage may include the sanitizer's three-character truncation marker.

## Required interpretation

Compare the new 1,600-character run with PR #169's 800-character run on:

1. End-to-end directional accuracy and macro-F1.
2. Per-class precision/recall, especially SUPPORT recall and false CONTRADICT counts on SUPPORT / NOT_ENOUGH_INFO.
3. Candidate recall and gold evidence Hit@5 (these should remain invariant if passage length is the only changed variable).
4. Gold rationale visibility at the configured character limit.
5. NLI label distribution, mean confidence, and refute/support vote-weight ratio.
6. Runtime and exact provenance/config/model hashes.

If retrieval metrics differ, the runs are not a clean passage-window comparison and must be investigated. If directional metrics improve, that still does not authorize production use; a second untouched dataset and a separately specified human holdout remain required.

## Safety boundary

This is research-only. It does not change the default 800-character behavior, production runtime, model weights, thresholds, abstention policy, source-independence policy, or deployment configuration. No SciFact-dev-derived setting may be promoted as a production threshold.
