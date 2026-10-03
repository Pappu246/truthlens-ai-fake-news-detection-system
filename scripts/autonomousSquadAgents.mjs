#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const CONFIG = path.join(ROOT, "research", "autonomous-squad-config.json");
const MANIFEST = path.join(ROOT, "research", "multibenchmark-manifest.json");
const OUT = process.env.AUTONOMOUS_SQUAD_OUT || path.join(ROOT, "autonomous-squad-output");

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const sha256 = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");

function requireTrue(value, message) {
  if (value !== true) throw new Error("Agent gate failed: " + message);
}

function executeRole(id, fn) {
  try {
    return { agent: id, status: "PASS", ...fn() };
  } catch (error) {
    return { agent: id, status: "FAIL", error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const [config, manifest] = await Promise.all([readJson(CONFIG), readJson(MANIFEST)]);
  requireTrue(config.production_mutation_allowed === false, "production mutation must be disabled");
  requireTrue(config.auto_merge === false, "auto merge must be disabled");
  requireTrue(config.auto_deploy === false, "auto deploy must be disabled");
  requireTrue(manifest.phase === 2, "current phase must be Phase 2");
  requireTrue(manifest.production_accuracy_claim === false, "universal production accuracy claim must remain false");

  const inputHashes = {
    config_sha256: await sha256(CONFIG),
    manifest_sha256: await sha256(MANIFEST)
  };
  const checkpointId = createHash("sha256").update(JSON.stringify(inputHashes)).digest("hex").slice(0, 16);

  const benchmarks = manifest.benchmarks || [];
  const byStatus = (status) => benchmarks.filter((b) => b.status === status).map((b) => b.id);

  const agents = [];
  agents.push(executeRole("supervisor", () => ({
    action: "enforce-phase-order",
    phase: manifest.phase,
    next_phase_authorized: false,
    reason: "Phase 2 exit conditions are not globally satisfied."
  })));

  agents.push(executeRole("research-scout", () => {
    const registryPath = path.join(ROOT, "research", "research-intelligence-registry.json");
    return fs.access(registryPath).then(() => ({
      action: "consume-discovery-contract",
      registry_present: true,
      source_path: path.relative(ROOT, registryPath),
      execution_mode: "discovery-only"
    }));
  }));

  agents.push(executeRole("model-scout", async () => {
    const registry = await readJson(path.join(ROOT, "research", "research-intelligence-registry.json"));
    const queries = (registry.model_search || []).map((x) => x.query).filter(Boolean);
    if (!queries.length) throw new Error("model discovery contract contains no search queries");
    return {
      action: "identify-candidates",
      query_count: queries.length,
      automatic_model_promotion: false
    };
  }));

  agents.push(executeRole("benchmark-agent", () => {
    const ready = byStatus("FROZEN_AND_MATERIALIZED");
    const baseline = byStatus("FROZEN_AND_BASELINED");
    const human = byStatus("PLANNED_EXTERNAL_COLLECTION");
    return {
      action: "schedule-frozen-benchmarks",
      verified_baselines: baseline,
      ready_for_scoring: ready,
      human_required: human,
      production_write: false
    };
  }));

  agents.push(executeRole("evaluator", () => {
    const readyBenchmarks = benchmarks.filter((b) => b.status === "FROZEN_AND_MATERIALIZED");
    const missingContracts = readyBenchmarks
      .filter((b) => !b.evaluation && !(Array.isArray(b.metrics) && b.metrics.length))
      .map((b) => b.id);
    if (missingContracts.length) throw new Error("evaluation contract missing for: " + missingContracts.join(", "));
    return {
      action: "verify-evaluation-contracts",
      score_artifacts_required_for: readyBenchmarks.map((b) => b.id),
      metric_separation: true
    };
  }));

  agents.push(executeRole("red-team", () => ({
    action: "hold-until-phase-5",
    executed: false,
    reason: "Phase ordering blocks reliability/adversarial execution during Phase 2."
  })));

  agents.push(executeRole("gatekeeper", () => {
    requireTrue(config.human_approval_required_for_promotion === true, "promotion must remain human-gated");
    requireTrue(config.promotion_rules.automatic_pr_creation === false, "automatic PR creation must remain disabled");
    requireTrue(config.promotion_rules.automatic_merge === false, "automatic merge must remain disabled");
    requireTrue(config.promotion_rules.automatic_deploy === false, "automatic deploy must remain disabled");
    return {
      action: "enforce-governance",
      promotion_allowed: false,
      production_mutation: false
    };
  }));

  const hardFailures = agents.filter((a) => a.status === "FAIL");
  agents.push({
    agent: "reporter",
    status: hardFailures.length ? "FAIL" : "PASS",
    action: "assemble-auditable-report",
    report_ready: hardFailures.length === 0,
    upstream_failures: hardFailures.map((a) => a.agent)
  });

  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    checkpoint_id: checkpointId,
    mode: "research-control-plane-agent-execution",
    phase: 2,
    overall_status: agents.every((a) => a.status === "PASS") ? "PASS" : "FAIL",
    agents,
    inputs: inputHashes,
    production_boundary: {
      model_write: false,
      threshold_write: false,
      source_policy_write: false,
      auto_merge: false,
      auto_deploy: false,
      human_review_before_promotion: true
    },
    resume_policy: "Resume from checkpoint_id and rerun only agents whose state or upstream inputs changed."
  };

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, "agent-report.json"), JSON.stringify(report, null, 2) + "\n");
  const md = [
    "# Autonomous Squad Agent Report",
    "",
    \`Checkpoint: \${checkpointId}\`,
    \`Overall: **\${report.overall_status}**\`,
    \`Mode: \${report.mode}\`,
    "",
    "| Agent | Status | Action |",
    "|---|---|---|",
    ...agents.map((a) => \`|\${a.agent}|\${a.status}|\${a.action}|\`),
    "",
    "Production writes: **disabled**",
    "Automatic merge/deploy: **disabled**",
    "Human review before promotion: **required**",
    ""
  ].join("\n");
  await fs.writeFile(path.join(OUT, "agent-report.md"), md);
  console.log(JSON.stringify({
    ok: report.overall_status === "PASS",
    checkpoint_id: checkpointId,
    overall_status: report.overall_status,
    agents: agents.map((a) => ({ agent: a.agent, status: a.status }))
  }, null, 2));
  if (report.overall_status !== "PASS") process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
