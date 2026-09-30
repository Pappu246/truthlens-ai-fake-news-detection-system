# TruthLens V3 External Open-Web Holdout Protocol

## Purpose

This protocol defines the independent human-annotation gate for the external open-web verification set. The set is deliberately outside model tuning and must not be fabricated from model outputs.

## Required construction

- Minimum: 300 claims.
- Claims must come from fresh, real-world topics not used to tune the current retrieval, verifier, thresholds, prompts, or model selection.
- Each claim receives independent annotation by two reviewers.
- Reviewers record the claim label, canonical evidence URLs, exact supporting/refuting passages, publisher, publication time when available, retrieval time, and relation.
- Disagreements are adjudicated by a third reviewer.
- The final sealed file is immutable after hashing.

## Blindness rules

Annotators must not see:
- TruthLens predictions or confidence;
- candidate-model benchmark scores;
- the current TruthLens error clusters;
- proposed threshold/model changes tied to a claim;
- any future benchmark result derived from the holdout.

## Sealing rule

Once the completed file passes scripts/v3SealOpenWebHoldout.mjs:
1. record its SHA-256;
2. freeze the evidence references;
3. disallow any use of labels/evidence for model, retrieval, threshold, prompt, or data-selection tuning;
4. evaluate TruthLens exactly as configured;
5. report results separately from FEVER/SciFact/AVeriTeC/FEVEROUS.

## What cannot be automated

The system can automate schema validation, duplicate detection, URL canonicalization checks, timestamps, hashing, and final sealing. It must not invent labels or pretend that model-generated labels are independent human annotations.

Until a genuinely independent annotated file is supplied, the holdout remains an explicit Phase 6 generalization gate rather than a fabricated benchmark result.
