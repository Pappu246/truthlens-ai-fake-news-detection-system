#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const registry = JSON.parse(fs.readFileSync(path.join(process.cwd(), "research", "v3-benchmark-registry.json"), "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "research", "v3-benchmark-run-schema.json"), "utf8"));

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/v3BenchmarkRunValidator.mjs <report.json>");
  process.exit(2);
}

const report = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
const errors = [];

for (const field of schema.required_top_level) {
  if (!(field in report)) errors.push("missing top-level field: " + field);
}
for (const field of schema.required_dataset_fields) {
  if (!(report.dataset && field in report.dataset)) errors.push("missing dataset field: " + field);
}
for (const field of schema.required_provenance_fields) {
  if (!(report.provenance && field in report.provenance)) errors.push("missing provenance field: " + field);
}

const sha64 = /^[0-9a-f]{64}$/i;
if (report.dataset && !sha64.test(report.dataset.claims_sha256 || "")) {
  errors.push("dataset.claims_sha256 must be 64 hex characters");
}
if (report.dataset && !sha64.test(report.dataset.corpus_sha256 || "")) {
  errors.push("dataset.corpus_sha256 must be 64 hex characters");
}
if (report.provenance && !sha64.test(report.provenance.configuration_sha256 || "")) {
  errors.push("provenance.configuration_sha256 must be 64 hex characters");
}
if (report.provenance && !/^[0-9a-f]{40}$/i.test(report.provenance.commit_sha || "")) {
  errors.push("provenance.commit_sha must be a 40-character Git commit SHA");
}

const ids = new Set((registry.benchmarks || []).map(b => b.id));
if (!ids.has(report.benchmark_id)) errors.push("benchmark_id is not present in registry: " + report.benchmark_id);

const forbidden = ["world-leading", "world leading", "best in the world", "state of the art accuracy"];
const serialized = JSON.stringify(report).toLowerCase();
for (const phrase of forbidden) {
  if (serialized.includes(phrase)) errors.push("benchmark artifact contains forbidden global-ranking claim text: " + phrase);
}

if (report.metrics && typeof report.metrics === "object") {
  for (const [name, value] of Object.entries(report.metrics)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push("metric is not a finite number: " + name);
    }
  }
}

if (errors.length) {
  console.error("TruthLens V3 benchmark run validator: FAIL");
  for (const error of errors) console.error("- " + error);
  process.exit(1);
}

console.log("TruthLens V3 benchmark run validator: PASS");
console.log("benchmark_id=" + report.benchmark_id);
console.log("evaluation_count=" + report.dataset.evaluation_count);
console.log("metrics=" + Object.keys(report.metrics || {}).join(","));
