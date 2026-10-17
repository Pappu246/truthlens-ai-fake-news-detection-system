#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const manifestPath = path.resolve("research/multibenchmark-manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

const failures = [];
const checks = [];

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function sha256(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function checkArtifact(label, file, expectedBenchmarkId, expectedEvaluationCount = null) {
  const ok = await exists(file);
  checks.push({ label, file, exists: ok });
  if (!ok) {
    failures.push(label + ": missing artifact");
    return;
  }
  try {
    const artifact = await readJson(file);
    if (artifact.benchmark_id !== expectedBenchmarkId) {
      failures.push(label + ": benchmark_id mismatch (" + artifact.benchmark_id + ")");
    }
    if (expectedEvaluationCount !== null && artifact.evaluation_count !== expectedEvaluationCount) {
      failures.push(label + ": evaluation_count mismatch (" + artifact.evaluation_count + ", expected " + expectedEvaluationCount + ")");
    }
    if (!artifact.metrics || typeof artifact.metrics !== "object") {
      failures.push(label + ": metrics payload missing");
    } else if (expectedBenchmarkId === "fever" || expectedBenchmarkId === "feverous") {
      for (const key of ["strict_score", "label_accuracy", "evidence_precision", "evidence_recall", "evidence_f1"]) {
        if (typeof artifact.metrics[key] !== "number" || !Number.isFinite(artifact.metrics[key])) {
          failures.push(label + ": metric " + key + " missing or non-numeric");
        }
      }
    } else if (expectedBenchmarkId === "averitec") {
      const groups = ["veracity_f1", "averitec_veracity", "averitec_justification"];
      for (const group of groups) {
        if (!artifact.metrics[group] || typeof artifact.metrics[group] !== "object" || Object.keys(artifact.metrics[group]).length === 0) {
          failures.push(label + ": metric group " + group + " missing or empty");
        }
      }
    }
    checks[checks.length - 1].sha256 = await sha256(file);
  } catch (error) {
    failures.push(label + ": invalid JSON (" + String(error) + ")");
  }
}

if (manifest.phase !== 2) failures.push("manifest phase is not 2");
if (manifest.production_accuracy_claim !== false) failures.push("production accuracy claim flag must remain false");
if (manifest.rules?.complete_artifact_required_before_publishing_metrics !== true) {
  failures.push("complete artifact rule missing");
}
if (manifest.rules?.production_artifact_must_remain_unchanged !== true) {
  failures.push("production immutability rule missing");
}

const scifactBaseline = "docs/V3_PHASE2_BENCHMARK_PROTOCOL.md";
checks.push({ label: "SciFact baseline protocol record", file: scifactBaseline, exists: await exists(scifactBaseline) });
if (!(await exists(scifactBaseline))) failures.push("SciFact protocol record missing");

await checkArtifact(
  "FEVER official score",
  "artifacts/v3/fever/official-scorer-run.json",
  "fever",
  manifest.benchmarks.find((item) => item.id === "fever_v1")?.expected_evaluation_claims ?? null
);

await checkArtifact(
  "FEVEROUS official score",
  "artifacts/v3/feverous/official-scorer-run.json",
  "feverous",
  manifest.benchmarks.find((item) => item.id === "feverous")?.expected_evaluation_claims ?? null
);

await checkArtifact(
  "AVeriTeC official score",
  "artifacts/v2-averitec-e2e/official-evaluation.json",
  "averitec",
  manifest.benchmarks.find((item) => item.id === "averitec")?.expected_evaluation_claims ?? null
);

const openWebHoldout = "research/open-web-v1-holdout.jsonl";
const openWebManifest = "artifacts/v3/open-web-v1/holdout-release-manifest.json";
const holdoutExists = await exists(openWebHoldout);
const openManifestExists = await exists(openWebManifest);
checks.push({ label: "Open-Web sealed holdout", holdoutExists, manifestExists: openManifestExists });
if (!holdoutExists || !openManifestExists) {
  failures.push("Open-Web human-labelled blind holdout is not sealed");
} else {
  const release = await readJson(openWebManifest);
  if (release.benchmark_id !== "truthlens_open_web_v1" || release.release_state !== "SEALED") {
    failures.push("Open-Web release manifest is not SEALED");
  }
  const actual = await sha256(openWebHoldout);
  if (actual !== release.sha256) failures.push("Open-Web holdout hash does not match release manifest");
}

const gate = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  phase: 2,
  status: failures.length ? "BLOCKED" : "READY_FOR_HUMAN_REVIEW",
  complete: failures.length === 0,
  checks,
  failures,
  production_promotion_allowed: false,
  notes: [
    "Benchmark scores remain benchmark-specific.",
    "A complete artifact and provenance are required before publishing metrics.",
    "Production promotion remains separately gated."
  ]
};

const out = path.resolve("artifacts/v3/phase2-exit-gate.json");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify(gate, null, 2) + "\n");
console.log(JSON.stringify(gate, null, 2));

if (failures.length) process.exit(1);
