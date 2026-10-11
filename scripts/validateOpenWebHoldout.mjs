#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SCHEMA = path.join(ROOT, "research/open-web-v1-holdout-schema.json");
const DEFAULT_OUTPUT = path.resolve("artifacts/v3/open-web-v1");

function arg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseDate(value) {
  if (!nonEmpty(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value) {
  if (!nonEmpty(value) || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  return parseDate(value);
}

function parseUrl(value) {
  if (!nonEmpty(value)) return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname ? parsed : null;
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function main() {
  const input = path.resolve(arg("input", "research/open-web-v1-holdout.jsonl"));
  const schemaPath = path.resolve(arg("schema", DEFAULT_SCHEMA));
  const attestationPath = path.resolve(arg("attestation", "research/open-web-v1-annotation-attestation.json"));
  const outputDir = path.resolve(arg("output-dir", DEFAULT_OUTPUT));
  const gatePath = path.join(outputDir, "holdout-gate.json");
  const releasePath = path.join(outputDir, "holdout-release-manifest.json");
  const failures = [];
  const checks = [];
  let schema;
  let attestation = null;

  try {
    schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
  } catch (error) {
    throw new Error("Unable to read holdout schema: " + String(error));
  }

  try {
    attestation = JSON.parse(await fs.readFile(attestationPath, "utf8"));
  } catch (error) {
    failures.push("human annotation attestation is missing or unreadable: " + String(error));
  }

  if (schema.benchmark_id !== "truthlens_open_web_v1") failures.push("schema benchmark_id must be truthlens_open_web_v1");
  if (!Number.isInteger(schema.target_claims) || schema.target_claims !== 100) failures.push("schema target_claims must be exactly 100");

  let bytes;
  let raw;
  try {
    bytes = await fs.readFile(input);
    raw = bytes.toString("utf8");
  } catch (error) {
    throw new Error("Unable to read holdout JSONL: " + String(error));
  }

  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const physicalLines = raw.split(/\r?\n/);
  if (physicalLines.at(-1) === "") physicalLines.pop();
  const rows = [];

  for (let i = 0; i < physicalLines.length; i++) {
    const line = physicalLines[i];
    if (!line.trim()) {
      failures.push("line " + (i + 1) + ": blank JSONL records are not allowed");
      continue;
    }
    try {
      rows.push({ line: i + 1, row: JSON.parse(line) });
    } catch (error) {
      failures.push("line " + (i + 1) + ": invalid JSON (" + String(error) + ")");
    }
  }

  if (rows.length !== schema.target_claims) {
    failures.push("record count is " + rows.length + "; expected exactly " + schema.target_claims);
  }

  const required = Array.isArray(schema.required_fields) ? schema.required_fields : [];
  const evidenceRequired = Array.isArray(schema.evidence_item_required_fields) ? schema.evidence_item_required_fields : [];
  const claimTypes = new Set(schema.claim_source_types || []);
  const evidenceTypes = new Set(schema.source_classes || []);
  const labels = new Set(schema.label_set || []);
  const ids = new Set();
  const duplicateClusters = new Set();
  const sourceCounts = Object.fromEntries([...claimTypes].map((type) => [type, 0]));
  const labelCounts = Object.fromEntries([...labels].map((label) => [label, 0]));
  let evidenceItemCount = 0;

  for (const entry of rows) {
    const line = entry.line;
    const row = entry.row;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      failures.push("line " + line + ": record must be a JSON object");
      continue;
    }

    for (const field of required) {
      if (!(field in row) || row[field] === null || row[field] === undefined || row[field] === "") {
        failures.push("line " + line + ": required field '" + field + "' is missing");
      }
    }

    if (nonEmpty(row.claim_id)) {
      if (ids.has(row.claim_id)) failures.push("line " + line + ": duplicate claim_id '" + row.claim_id + "'");
      ids.add(row.claim_id);
    }

    if (!nonEmpty(row.claim)) failures.push("line " + line + ": claim must be non-empty");
    if (!nonEmpty(row.duplicate_cluster_id)) failures.push("line " + line + ": duplicate_cluster_id must be assigned");
    else duplicateClusters.add(row.duplicate_cluster_id);

    if (!claimTypes.has(row.claim_source_type)) {
      failures.push("line " + line + ": claim_source_type must be one of " + [...claimTypes].join(", "));
    } else {
      sourceCounts[row.claim_source_type] += 1;
    }

    if (!labels.has(row.human_label)) {
      failures.push("line " + line + ": human_label must be one of " + [...labels].join(", "));
    } else {
      labelCounts[row.human_label] += 1;
    }

    const claimDate = parseTimestamp(row.claim_date);
    if (claimDate === null) failures.push("line " + line + ": claim_date must be an ISO timestamp with timezone (for example 2026-10-07T09:30:00Z)");
    const claimSourceDate = parseTimestamp(row.claim_source_published_at);
    if (claimSourceDate === null) failures.push("line " + line + ": claim_source_published_at must be an ISO timestamp with timezone");
    else if (claimDate !== null && claimSourceDate > claimDate) {
      failures.push("line " + line + ": claim source was published after claim_date");
    }

    if (!parseUrl(row.claim_source_url)) failures.push("line " + line + ": claim_source_url must be an HTTP(S) URL");

    const humanReviewedAt = parseTimestamp(row.human_reviewed_at);
    if (humanReviewedAt === null) failures.push("line " + line + ": human_reviewed_at must be an ISO timestamp with timezone");
    else if (humanReviewedAt > Date.now()) failures.push("line " + line + ": human_reviewed_at cannot be in the future");

    if (!Array.isArray(row.evidence_items) || row.evidence_items.length === 0) {
      failures.push("line " + line + ": evidence_items must be a non-empty array");
      continue;
    }

    evidenceItemCount += row.evidence_items.length;
    for (let index = 0; index < row.evidence_items.length; index++) {
      const item = row.evidence_items[index];
      const location = "line " + line + " evidence_items[" + index + "]";
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        failures.push(location + ": evidence item must be an object");
        continue;
      }
      for (const field of evidenceRequired) {
        if (!(field in item) || item[field] === null || item[field] === undefined || item[field] === "") {
          failures.push(location + ": required field '" + field + "' is missing");
        }
      }
      if (!parseUrl(item.url)) failures.push(location + ": url must be an HTTP(S) URL");
      if (!nonEmpty(item.publisher)) failures.push(location + ": publisher must be non-empty");
      if (!evidenceTypes.has(item.source_class)) failures.push(location + ": invalid source_class");
      if (!nonEmpty(item.evidence_text)) failures.push(location + ": evidence_text must be non-empty");

      const publishedAt = parseTimestamp(item.published_at);
      if (publishedAt === null) {
        failures.push(location + ": published_at must be an ISO timestamp with timezone");
      } else if (claimDate !== null && publishedAt > claimDate) {
        failures.push(location + ": post-claim-date evidence is prohibited");
      }
    }
  }

  // "Balanced" is operationalized as at least 20 of each claim source type.
  for (const type of ["PRIMARY", "MAJOR_NEWS"]) {
    if (sourceCounts[type] === undefined || sourceCounts[type] < 20) {
      failures.push("balanced source mix requires at least 20 " + type + " claims");
    }
  }

  let attestationSha256 = null;
  let independentAnnotatorCount = 0;
  if (attestation && typeof attestation === "object" && !Array.isArray(attestation)) {
    const annotators = Array.isArray(attestation.annotators) ? attestation.annotators : [];
    const annotatorIds = annotators.map((entry) => entry?.reviewer_id).filter(nonEmpty);
    independentAnnotatorCount = new Set(annotatorIds).size;

    if (attestation.benchmark_id !== "truthlens_open_web_v1") failures.push("attestation benchmark_id must be truthlens_open_web_v1");
    if (attestation.annotation_status !== "COMPLETE") failures.push("attestation annotation_status must be COMPLETE");
    if (independentAnnotatorCount < 2) failures.push("attestation requires at least two distinct human annotators");
    if (!nonEmpty(attestation.adjudicator_id)) failures.push("attestation requires an independent adjudicator_id");
    if (annotatorIds.includes(attestation.adjudicator_id)) failures.push("adjudicator_id must be independent of the two primary annotators");
    if (attestation.blind_to_model_outputs !== true) failures.push("attestation must confirm annotators were blind to model outputs");
    if (attestation.labels_locked_before_model_evaluation !== true) failures.push("attestation must confirm labels were locked before model evaluation");
    if (attestation.temporal_cutoff_verified !== true) failures.push("attestation must confirm the claim-date temporal cutoff was reviewed");
    if (attestation.disputes_adjudicated !== true) failures.push("attestation must confirm annotation disputes were adjudicated");
    const attestedAt = parseTimestamp(attestation.attested_at);
    if (attestedAt === null) failures.push("attestation attested_at must be an ISO timestamp with timezone");
    else if (attestedAt > Date.now()) failures.push("attestation attested_at cannot be in the future");
    attestationSha256 = crypto.createHash("sha256").update(JSON.stringify(attestation)).digest("hex");
  } else {
    failures.push("human annotation attestation must be a JSON object");
  }

  checks.push(
    { label: "schema and exact claim count", pass: rows.length === 100 && !failures.some((f) => f.startsWith("record count")) },
    { label: "human labels and review timestamps", pass: rows.every((entry) => labels.has(entry.row?.human_label) && parseTimestamp(entry.row?.human_reviewed_at) !== null) },
    { label: "claim/evidence temporal boundary", pass: !failures.some((f) => f.includes("post-claim-date") || f.includes("published after claim_date")) },
    { label: "balanced source mix", pass: (sourceCounts.PRIMARY || 0) >= 20 && (sourceCounts.MAJOR_NEWS || 0) >= 20 },
    { label: "provenance and duplicate clusters", pass: !failures.some((f) => f.includes("URL") || f.includes("duplicate_cluster_id")) }
  );

  const summary = {
    schema_version: 1,
    benchmark_id: "truthlens_open_web_v1",
    status: failures.length ? "BLOCKED" : "SEALED",
    release_state: failures.length ? "DRAFT" : "SEALED",
    target_claims: schema.target_claims,
    record_count: rows.length,
    evidence_item_count: evidenceItemCount,
    label_counts: labelCounts,
    claim_source_counts: sourceCounts,
    distinct_duplicate_clusters: duplicateClusters.size,
    sha256: digest,
    input,
    schema: schemaPath,
    attestation: attestationPath,
    attestation_sha256: attestationSha256,
    independent_annotator_count: independentAnnotatorCount,
    generated_at: new Date().toISOString(),
    checks,
    failures,
    blind_holdout_required: true,
    human_review_required: true,
    production_evaluation_allowed: false
  };

  await fs.mkdir(outputDir, { recursive: true });
  await writeJson(gatePath, summary);
  if (failures.length === 0) {
    await writeJson(releasePath, {
      schema_version: 1,
      benchmark_id: "truthlens_open_web_v1",
      release_state: "SEALED",
      target_claims: schema.target_claims,
      evaluation_count: rows.length,
      sha256: digest,
      label_counts: labelCounts,
      claim_source_counts: sourceCounts,
      distinct_duplicate_clusters: duplicateClusters.size,
      source_file: path.basename(input),
      attestation_file: path.basename(attestationPath),
      attestation_sha256: attestationSha256,
      independent_annotator_count: independentAnnotatorCount,
      generated_at: new Date().toISOString(),
      human_review_attestation_required: true,
      production_evaluation_allowed: false
    });
  } else {
    await fs.rm(releasePath, { force: true });
  }

  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
