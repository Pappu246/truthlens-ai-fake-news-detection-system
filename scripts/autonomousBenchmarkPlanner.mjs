#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const OUT = process.env.AUTONOMOUS_SQUAD_OUT || path.join(ROOT, "autonomous-squad-output");

const RUNNER_CANDIDATES = {
  scifact: ["eval:v2-scifact-e2e"],
  fever_v1: ["scripts/benchmarks/v3FeverEvaluate.ts", "scripts/benchmarks/v3FeverOfficialEvaluate.mjs", "eval:v3-fever-e2e", "eval:fever-e2e"],
  feverous: ["scripts/benchmarks/v3FeverousEvaluate.ts", "scripts/benchmarks/v3FeverousOfficialEvaluate.mjs", "eval:v3-feverous-e2e", "eval:feverous-e2e"],
  averitec: ["scripts/benchmarks/v3AveritecTruthLensEvaluate.ts", "scripts/benchmarks/v3AveritecOfficialEvaluate.mjs", "eval:v2-averitec-e2e", "eval:v3-averitec-e2e"],
  truthlens_open_web_v1: []
};

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function fileExists(relativePath) {
  try {
    await fs.access(path.join(ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function planFor(benchmark, scripts) {
  const status = String(benchmark.status || "");
  if (status === "FROZEN_AND_BASELINED") {
    return { state: "VERIFIED_BASELINE", action: "retain-baseline", runners: [] };
  }
  if (status === "PLANNED_EXTERNAL_COLLECTION") {
    return { state: "HUMAN_REQUIRED", action: "freeze-human-holdout", runners: [] };
  }

  const candidates = RUNNER_CANDIDATES[benchmark.id] || [];
  const available = [];
  for (const name of candidates) {
    if (typeof scripts[name] === "string" || await fileExists(name)) available.push(name);
  }
  if (available.length) {
    return { state: "RUNNABLE", action: "execute-runner", runners: available };
  }

  return {
    state: "BLOCKED_MISSING_RUNNER",
    action: "implement-or-recover-runner",
    runners: candidates
  };
}

async function main() {
  const [manifest, pkg] = await Promise.all([
    readJson(path.join(ROOT, "research", "multibenchmark-manifest.json")),
    readJson(path.join(ROOT, "package.json"))
  ]);

  const benchmarks = [];
  for (const benchmark of manifest.benchmarks || []) {
    benchmarks.push({
      id: benchmark.id,
      status: benchmark.status,
      ...(await planFor(benchmark, pkg.scripts || {}))
    });
  }

  const plan = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    phase: manifest.phase,
    checkpoint_scope: "benchmark-runner-availability",
    benchmarks,
    fail_closed: true,
    production_mutation_allowed: false,
    resume_hint: "Re-run after a runner is added or recovered; verified baselines are never recomputed."
  };

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, "benchmark-runner-plan.json"), JSON.stringify(plan, null, 2) + "\n");

  const md = [
    "# Autonomous Benchmark Runner Plan",
    "",
    "| Benchmark | Status | State | Action | Candidate runners |",
    "|---|---|---|---|---|",
    ...benchmarks.map((x) => "|" + x.id + "|" + x.status + "|" + x.state + "|" + x.action + "|" + (x.runners.join(", ") || "—") + "|"),
    "",
    "Production mutation: **disabled**",
    "Fail-closed: **enabled**",
    ""
  ].join("\n");

  await fs.writeFile(path.join(OUT, "benchmark-runner-plan.md"), md, "utf8");
  console.log(JSON.stringify(plan, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
