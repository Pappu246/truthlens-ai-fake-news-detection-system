# TruthLens Open-Web V1 Annotation Guide

## Goal and roles

Create a blind, human-labelled holdout of exactly 100 real, verifiable open-web claims. Two human annotators independently label every claim. A third person, independent of both annotators, adjudicates disagreements. The annotators must not see TruthLens predictions or each other's labels before both submissions are locked.

Use separate private workbooks/files for Annotator A and Annotator B. Give both the same claim text and claim-source metadata, but do not share either person's labels or evidence notes with the other until both have submitted. A reviewer should receive both locked submissions only after that point.

## Selecting the 100 claims

- Use 100 distinct, factual, checkable propositions from real sources. Avoid opinions, satire, predictions, vague wording, and claims that bundle several unrelated propositions together.
- Make the source mix easy to audit: target 50 claims whose claim source is PRIMARY and 50 whose claim source is MAJOR_NEWS. The hard minimum is 20 of each type.
- PRIMARY means the original/first-party source making the assertion (for example an official agency notice, court record, company filing, research paper, or direct institutional announcement). MAJOR_NEWS means the claim appears in a major news publisher's report. Classify the **claim source**, not the evidence source, in `claim_source_type`.
- Do not deliberately choose claims based on TruthLens outputs. Do not show model scores, verdicts, explanations, or predictions to annotators or the adjudicator before the labels are locked.
- Keep a source URL, publisher name, and verifiable publication timestamp for every claim. If the publication timestamp cannot be established reliably, replace the candidate rather than guessing.

## Four allowed labels

| Label | Use when |
|---|---|
| SUPPORTED | Admissible evidence published by the cutoff supports the claim as stated, with enough specificity to establish the proposition. |
| REFUTED | Admissible evidence published by the cutoff establishes that the proposition is false or materially contradicts it. |
| INSUFFICIENT_EVIDENCE | The available admissible evidence does not establish either support or refutation to a reasonable standard. Use this when reliable evidence is missing or too weak—not merely because searching was inconvenient. |
| CONFLICTED | Multiple credible, admissible sources materially disagree, or selective source choice is required to make the claim appear established. |

Do not choose a label based only on a headline, search snippet, social post, or the apparent reputation of the person making the claim. Read the linked evidence and record the passage relevant to the proposition.

## Exact timestamp / temporal rule

All timestamps must be ISO 8601 with an explicit timezone, preferably UTC, for example `2026-10-07T09:30:00Z`.

- Set `claim_date` to the exact publication/cutoff timestamp of the claim being evaluated. Set `claim_source_published_at` to the source's verified publication timestamp; it must be equal to or earlier than `claim_date`. When the source is the claim itself, these timestamps will normally be the same.
- Every `evidence_items[].published_at` timestamp must be at or before `claim_date`. Evidence published later is not admissible, even if it helps establish what happened afterward.
- Do not guess timestamps, silently change timezones, or use a date-only value for `claim_date`. If only a date is known and the exact cutoff cannot be established, choose a different claim for this timestamp-sensitive holdout.
- Record the actual annotation/finalization time in `human_reviewed_at`, also with a timezone. Do not backdate it.

## Evidence and provenance

For every claim, record one or more evidence items. Prefer multiple independently published sources where available; copies of the same syndicated report are not independent confirmation.

Each evidence item must contain:

- `url`: direct HTTP(S) URL to the page/document used.
- `publisher`: organization or publisher name, not just a search engine.
- `published_at`: verified ISO 8601 timestamp with timezone.
- `source_class`: one of `PRIMARY`, `MAJOR_NEWS`, or `OTHER`.
- `evidence_text`: a concise, faithful excerpt or summary of the specific passage relevant to the claim, with enough context to audit the decision.

Use `OTHER` for relevant evidence that is neither a primary source nor a major news publisher. Do not invent quotes, source names, URLs, dates, or evidence. When the label is INSUFFICIENT_EVIDENCE, record the relevant admissible sources actually examined and what they do or do not establish; do not create fictitious evidence just to fill the field.

## Independence and duplicate clusters

Assign a `duplicate_cluster_id` to each claim. Use different IDs for unrelated claims. Reuse the same ID only when claims are duplicates or substantially the same proposition carried by syndicated/near-identical reports. Repeated copies in one cluster must not be counted as independent confirmation.

## Required record fields

Each final row needs: `claim_id`, `claim`, `claim_date`, `claim_source_url`, `claim_source_type`, `claim_source_published_at`, `human_label`, `human_reviewed_at`, `duplicate_cluster_id`, and a non-empty `evidence_items` array. The exact field names and allowed values are defined in `research/open-web-v1-holdout-schema.json`.

## Review and adjudication

1. Annotator A completes all 100 claims independently and locks/submits the file.
2. Annotator B completes the same 100 claims independently and locks/submits their separate file.
3. Only after both are locked, compare labels. The independent reviewer examines disagreements and the underlying evidence, records a brief decision reason, and resolves each disagreement. Never silently overwrite a label.
4. Preserve both original annotation files and the review/adjudication notes. The final `human_label` must reflect the agreed/adjudicated result, and `human_reviewed_at` must be the real finalization timestamp.
5. Check that at least 20 claims use each claim-source type. Aim for 50 PRIMARY and 50 MAJOR_NEWS.

## Release attestation

Only after the work above is genuinely complete, create `research/open-web-v1-annotation-attestation.json` from `research/open-web-v1-annotation-attestation.template.json`. Set `annotation_status` to `COMPLETE`; record two distinct annotator IDs and a third, independent adjudicator ID; set `blind_to_model_outputs`, `labels_locked_before_model_evaluation`, `temporal_cutoff_verified`, and `disputes_adjudicated` to `true` only if each statement is true; and fill `attested_at` with the actual UTC completion time. Never claim that AI-generated or unperformed human review happened.

The validator seals the holdout only if all 100 rows, timestamps, source balance, provenance, review fields, and attestation pass. Until then the gate remains blocked/deferred and production evaluation is not permitted.
