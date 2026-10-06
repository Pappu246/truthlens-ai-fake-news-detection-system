# TruthLens Open-Web V1 Annotation Guide

## Goal
Create a blind, human-labelled 100-claim holdout for fresh open-web verification.

## Labels
| Label | Use when |
|---|---|
| SUPPORTED | Pre-claim-date evidence supports the claim as stated, with enough specificity to establish the proposition. |
| REFUTED | Pre-claim-date evidence establishes that the proposition is false or materially contradicted. |
| INSUFFICIENT_EVIDENCE | Available admissible evidence does not establish support or refutation at the required standard. |
| CONFLICTED | Multiple credible admissible sources materially disagree, or the claim can only be made to appear supported by selective source choice. |

## Temporal rule
Do not admit evidence published after the claim date. Record the publication timestamp used for the decision.

## Source rule
Record whether the claim source is PRIMARY or MAJOR_NEWS. Preserve source URLs and publisher identity.

## Independence / duplication
Assign a duplicate_cluster_id to syndicated or substantially identical reports so repeated copies are not counted as independent confirmation.

## Blind evaluation rule
Human labels must be completed and timestamped before the holdout is released to the TruthLens evaluation runner.

## Dispute handling
Do not silently change labels. Record a reviewer note and a new review timestamp for any adjudicated change.

## Release condition
The holdout is eligible for RELEASED_FOR_EVALUATION only after all 100 rows satisfy the schema, temporal constraints, provenance requirements, and human-review fields.
