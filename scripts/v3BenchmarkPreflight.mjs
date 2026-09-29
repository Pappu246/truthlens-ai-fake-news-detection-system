#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const file = path.join(process.cwd(), "research", "v3-benchmark-registry.json");
const registry = JSON.parse(fs.readFileSync(file, "utf8"));
const errors = [];
const seenIds = new Set();

if (registry.schema_version !== 1) errors.push("unsupported schema_version");
if (registry.protocol_version !== "truthlens-v3-benchmark-protocol-v1") errors.push("unexpected protocol_version");

for (const b of registry.benchmarks || []) {
  if (!b.id) errors.push("benchmark missing id");
  if (seenIds.has(b.id)) errors.push("duplicate benchmark id: " + b.id);
  seenIds.add(b.id);

  for (const field of ["display_name", "status", "task", "split", "evidence_setting"]) {
    if (!b[field]) errors.push(b.id + ": missing " + field);
  }
  if (!Array.isArray(b.primary_metrics) || b.primary_metrics.length === 0) {
    errors.push(b.id + ": missing primary_metrics");
  }
  if (b.status !== "planned" && !b.dataset_source) {
    errors.push(b.id + ": non-planned benchmark must declare dataset_source");
  }

  const executable = ["verified-baseline", "ready"];
  if (executable.includes(b.status)) {
    if (!b.claims_sha256 || !b.corpus_sha256) {
      errors.push(b.id + ": executable benchmark must pin claims_sha256 and corpus_sha256");
    }
    if (!b.implementation) {
      errors.push(b.id + ": executable benchmark must declare implementation");
    }
  }
}

const required = ["scifact", "fever", "averitec", "feverous", "openweb-external"];
for (const id of required) {
  if (!seenIds.has(id)) errors.push("missing required benchmark: " + id);
}

if (registry.policy.test_set_tuning_forbidden !== true) errors.push("test-set tuning must remain forbidden");
if (registry.policy.same_metric_required !== true) errors.push("same-metric rule must remain enabled");
if (registry.policy.same_evidence_setting_required !== true) errors.push("same-evidence-setting rule must remain enabled");

if (errors.length) {
  console.error("TruthLens V3 benchmark preflight: FAIL");
  for (const error of errors) console.error("- " + error);
  process.exit(1);
}

console.log("TruthLens V3 benchmark preflight: PASS");
console.log("benchmarks=" + registry.benchmarks.length);
for (const b of registry.benchmarks) {
  console.log(b.id + ": status=" + b.status + ", metrics=" + b.primary_metrics.join(","));
}
console.log("policy: same-dataset-split + same-metric + same-evidence-setting + no-test-tuning");
