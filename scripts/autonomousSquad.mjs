#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "research", "autonomous-squad-config.json");
const MANIFEST_PATH = path.join(ROOT, "research", "multibenchmark-manifest.json");
const OUT_DIR = process.env.AUTONOMOUS_SQUAD_OUT || path.join(ROOT, "autonomous-squad-output");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function sha256File(file) {
  const bytes = await fs.readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error("Autonomous Squad invariant failed: " + message);
}

function benchmarkPlan(benchmark) {
  const status = String(benchmark.status || "");
  if (status === "FROZEN_AND_BASELINED") {
    return { state: "VERIFIED_BASELINE", action: "retain-baseline", reason: "Authoritative benchmark artifact already exists." };
  }
  if (status === "FROZEN_AND_MATERIALIZED") {
    return { state: "READY_FOR_SCORING", action: "run-benchmark", reason: "Frozen inputs exist; a reproducible score artifact is still required." };
  }
  if (status === "PROTOCOL_FROZEN_EVIDENCE_MATERIALIZATION_PENDING") {
    return { state: "BLOCKED", action: "materialize-evidence", reason: "Evidence materialization must finish before scoring." };
  }
  if (status === "PLANNED_EXTERNAL_COLLECTION") {
    return { state: "HUMAN_REQUIRED", action: "freeze-human-holdout", reason: "A blind human-labelled external holdout is required before evaluation." };
  }
  if (status.includes("SCOR") || status.includes("BASELIN")) {
    return { state: "REVIEW", action: "inspect-status", reason: "Benchmark state requires explicit artifact verification." };
  }
  return { state: "UNKNOWN", action: "inspect-status", reason: "Unrecognized benchmark status; autonomous execution must stop." };
}

async function main() {
  const [config, manifest] = await Promise.all([
    readJson(CONFIG_PATH),
    readJson(MANIFEST_PATH)
  ]);

  assert(config.schema_version === 1, "unsupported squad config schema");
  assert(config.production_mutation_allowed === false, "production mutation must remain disabled");
  assert(config.auto_merge === false, "auto merge must remain disabled");
  assert(config.auto_deploy === false, "auto deploy must remain disabled");
  assert(manifest.phase === 2, "squad currently operates inside Phase 2");
  assert(manifest.production_accuracy_claim === false, "production accuracy claim must remain false");

  const checkpointInputs = {
    config_sha256: await sha256File(CONFIG_PATH),
    manifest_sha256: await sha256File(MANIFEST_PATH)
  };
  const checkpointId = createHash("sha256")
    .update(JSON.stringify(checkpointInputs))
    .digest("hex")
    .slice(0, 16);

  const benchmarks = (manifest.benchmarks || []).map((benchmark) => ({
    id: benchmark.id,
    ...benchmarkPlan(benchmark)
  }));

  const ready = benchmarks.filter((x) => x.state === "READY_FOR_SCORING");
  const blocked = benchmarks.filter((x) => x.state === "BLOCKED");
  const human = benchmarks.filter((x) => x.state === "HUMAN_REQUIRED");
  const verified = benchmarks.filter((x) => x.state === "VERIFIED_BASELINE");

  const phase2Exit =
    ready.length === 0 &&
    blocked.length === 0 &&
    human.length === 0 &&
    benchmarks.every((x) => x.state === "VERIFIED_BASELINE");

  const plan = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    checkpoint_id: checkpointId,
    git_sha: process.env.GITHUB_SHA || null,
    workflow_run_id: process.env.GITHUB_RUN_ID || null,
    phase: 2,
    production_mutation_allowed: false,
    next_legal_actions: [
      ...ready.map((x) => ({ agent: "benchmark-agent", target: x.id, action: x.action })),
      ...blocked.map((x) => ({ agent: "benchmark-agent", target: x.id, action: x.action })),
      ...human.map((x) => ({ agent: "supervisor", target: x.id, action: x.action }))
    ],
    benchmarks,
    phase2_exit_ready: phase2Exit,
    governance: {
      metric_separation: true,
      no_benchmark_score_as_universal_accuracy: true,
      gold_evidence_never_injected_into_open_retrieval: true,
      production_model_write: false,
      auto_merge: false,
      auto_deploy: false,
      human_review_before_promotion: true
    },
    resume_hint: "Use checkpoint_id plus config_sha256 and manifest_sha256 to resume without repeating completed work.",
    interpretation: phase2Exit
      ? "Phase 2 exit conditions are satisfied by manifest state; verify completed benchmark artifacts before moving to Phase 3."
      : "Phase 2 remains active; the supervisor must not authorize Phase 3 or production promotion."
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "checkpoint.json"), JSON.stringify(plan, null, 2) + "\n", "utf8");

  const md = [
    "# TruthLens Autonomous Squad Checkpoint",
    "",
    `Checkpoint: ${checkpointId}`,
    `Generated: ${plan.generated_at}`,
    `Phase: ${plan.phase}`,
    "",
    "> Research-control-plane only. No production model, threshold, merge, or deployment is modified.",
    "",
    "## Next legal actions",
    ...plan.next_legal_actions.map((x) => `- ${x.agent}: ${x.action} → ${x.target}`),
    ...(plan.next_legal_actions.length ? [] : ["- none"]),
    "",
    "## Benchmark states",
    "| Benchmark | State | Action |",
    "|---|---|---|",
    ...benchmarks.map((x) => `|${x.id}|${x.state}|${x.action}|`),
    "",
    `Phase 2 exit ready: **${phase2Exit ? "YES" : "NO"}**`,
    "",
    "## Recovery",
    "The checkpoint is deterministic for the committed config and benchmark manifest. A new session can resume by reading this artifact and re-planning only the states that remain actionable.",
    ""
  ].join("\n");
  await fs.writeFile(path.join(OUT_DIR, "checkpoint.md"), md, "utf8");

  console.log(JSON.stringify({
    ok: true,
    checkpoint_id: checkpointId,
    ready_for_scoring: ready.map((x) => x.id),
    blocked: blocked.map((x) => x.id),
    human_required: human.map((x) => x.id),
    verified_baselines: verified.map((x) => x.id),
    phase2_exit_ready: phase2Exit
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
