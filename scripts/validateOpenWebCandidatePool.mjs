#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = path.join(ROOT, "research/open-web-v1-candidate-pool.json");

function fail(message) { throw new Error(message); }
function timestamp(value) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}T.*(?:Z|[+-]\\d{2}:\\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main() {
  const input = path.resolve(process.argv.find((v) => v.startsWith("--input="))?.slice(8) ?? DEFAULT_INPUT);
  const raw = await fs.readFile(input);
  const document = JSON.parse(raw.toString("utf8"));
  const rows = document.records;

  if (document.schema_version !== 1 || document.benchmark_id !== "truthlens_open_web_v1") fail("unsupported candidate-pool schema/benchmark");
  if (document.asset_type !== "UNLABELED_CANDIDATE_POOL" || document.status !== "UNLABELED_CANDIDATE_POOL") fail("pool must remain explicitly unlabeled");
  if (!Array.isArray(rows) || rows.length !== 100 || document.record_count !== 100) fail("expected exactly 100 candidate records");
  if (document.eligible_for_scoring !== false || document.satisfies_human_holdout_gate !== false) fail("candidate pool must not be marked eligible for scoring or as satisfying the human gate");
  if (document.human_label_field_present !== false || document.independent_human_annotations_present !== false || document.adjudication_attestation_present !== false) fail("manifest must truthfully identify missing human annotations/attestation");

  const ids = new Set(), urls = new Set(), claims = new Set();
  const mix = { PRIMARY: 0, MAJOR_NEWS: 0 };
  const forbiddenFields = ["human_label", "verdict_label", "annotator_id", "human_reviewed_at", "evidence_items", "model_prediction", "prediction", "confidence_score"];

  for (const [index, row] of rows.entries()) {
    const where = "record " + (index + 1);
    if (!row || typeof row !== "object" || Array.isArray(row)) fail(where + ": must be an object");
    for (const key of ["claim_id", "claim", "claim_date", "claim_source_url", "claim_source_type", "claim_source_published_at", "publisher", "topic", "duplicate_cluster_id"]) {
      if (typeof row[key] !== "string" || !row[key].trim()) fail(where + ": missing " + key);
    }
    for (const key of forbiddenFields) if (Object.hasOwn(row, key)) fail(where + ": unlabeled pool must not contain " + key);
    if (ids.has(row.claim_id)) fail(where + ": duplicate claim_id " + row.claim_id);
    if (urls.has(row.claim_source_url)) fail(where + ": duplicate source URL");
    const normalizedClaim = row.claim.trim().toLocaleLowerCase("en-US");
    if (claims.has(normalizedClaim)) fail(where + ": duplicate claim text");
    ids.add(row.claim_id); urls.add(row.claim_source_url); claims.add(normalizedClaim);

    if (!/^https?:\\/\\/[^/]+/i.test(row.claim_source_url)) fail(where + ": invalid HTTP(S) source URL");
    if (!Object.hasOwn(mix, row.claim_source_type)) fail(where + ": invalid claim_source_type");
    mix[row.claim_source_type]++;

    const claimDate = timestamp(row.claim_date);
    const sourceDate = timestamp(row.claim_source_published_at);
    if (claimDate === null || sourceDate === null) fail(where + ": timestamps must be ISO 8601 with an explicit timezone");
    if (sourceDate > claimDate) fail(where + ": claim source publication is after the claim cutoff");
  }

  if (mix.PRIMARY !== 50 || mix.MAJOR_NEWS !== 50) fail("source mix must be exactly 50 PRIMARY / 50 MAJOR_NEWS");
  if (document.source_counts?.PRIMARY !== mix.PRIMARY || document.source_counts?.MAJOR_NEWS !== mix.MAJOR_NEWS) fail("manifest source_counts mismatch");
  if (document.unique_claim_ids !== ids.size || document.unique_claim_source_urls !== urls.size || document.unique_claim_texts !== claims.size) fail("manifest uniqueness counts mismatch");

  console.log(JSON.stringify({
    status: "PASS_CANDIDATE_POOL_INTEGRITY_ONLY",
    records: rows.length,
    source_counts: mix,
    candidate_pool_sha256: crypto.createHash("sha256").update(raw).digest("hex"),
    human_labelled: false,
    eligible_for_scoring: false,
    human_holdout_gate: "NOT_SATISFIED"
  }, null, 2));
}

main().catch((error) => { console.error(error?.stack || String(error)); process.exitCode = 1; });
