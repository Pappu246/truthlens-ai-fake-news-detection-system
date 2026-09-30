#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function arg(name) {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const file = path.resolve(arg("file") || "data/v3/openweb-external/holdout.jsonl");
if (!fs.existsSync(file)) {
  console.error("Holdout file missing: " + file);
  process.exit(1);
}

const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const errors = [];
const ids = new Set();

if (rows.length < 300) errors.push("minimum sealed holdout size is 300 claims");

for (const row of rows) {
  if (!row.claim_id || ids.has(row.claim_id)) errors.push("missing or duplicate claim_id: " + row.claim_id);
  ids.add(row.claim_id);
  if (!row.claim || !row.label) errors.push("claim/label missing: " + row.claim_id);
  if (!Array.isArray(row.evidence) || row.evidence.length === 0) errors.push("evidence missing: " + row.claim_id);
  if (!row.annotation?.annotator_id || !row.annotation?.second_annotator_id) {
    errors.push("independent annotators missing: " + row.claim_id);
  }
  if (!["AGREE", "ADJUDICATED"].includes(row.annotation?.agreement)) {
    errors.push("annotation agreement invalid: " + row.claim_id);
  }
}

if (errors.length) {
  console.error("External holdout seal: FAIL");
  for (const e of errors.slice(0, 30)) console.error("- " + e);
  process.exit(1);
}

const manifest = {
  benchmark_id: "openweb-external",
  schema_version: 1,
  sealed_at: new Date().toISOString(),
  evaluation_count: rows.length,
  claims_sha256: sha256(file),
  file: path.relative(process.cwd(), file),
  tuning_policy: "No model, retrieval, threshold, prompt, or data-selection changes after seal may use these labels/evidence."
};

const out = path.resolve(arg("output") || "artifacts/v3/openweb-external/sealed-manifest.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
