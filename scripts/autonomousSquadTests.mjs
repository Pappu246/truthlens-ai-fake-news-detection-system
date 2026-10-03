#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";

const config = JSON.parse(await fs.readFile("research/autonomous-squad-config.json", "utf8"));
const manifest = JSON.parse(await fs.readFile("research/multibenchmark-manifest.json", "utf8"));

assert.equal(config.schema_version, 1);
assert.equal(config.production_mutation_allowed, false);
assert.equal(config.auto_merge, false);
assert.equal(config.auto_deploy, false);
assert.equal(config.human_approval_required_for_promotion, true);
assert.deepEqual(config.lifecycle, ["DISCOVER", "QUEUE", "EVALUATE", "VERIFY", "REPORT", "HUMAN_REVIEW", "PROMOTE"]);

const ids = new Set((config.agents || []).map((agent) => agent.id));
for (const required of ["supervisor", "research-scout", "benchmark-agent", "model-scout", "evaluator", "red-team", "gatekeeper", "reporter"]) {
  assert.ok(ids.has(required), "missing agent: " + required);
}

assert.equal(manifest.phase, 2);
assert.equal(manifest.production_accuracy_claim, false);
const byId = Object.fromEntries((manifest.benchmarks || []).map((b) => [b.id, b]));
for (const id of ["scifact", "fever_v1", "feverous", "averitec", "truthlens_open_web_v1"]) {
  assert.ok(byId[id], "missing benchmark: " + id);
}
assert.equal(byId.scifact.status, "FROZEN_AND_BASELINED");
assert.equal(byId.fever_v1.status, "FROZEN_AND_MATERIALIZED");
assert.equal(byId.feverous.status, "FROZEN_AND_MATERIALIZED");
assert.equal(byId.averitec.status, "FROZEN_AND_MATERIALIZED");
assert.equal(byId.truthlens_open_web_v1.status, "PLANNED_EXTERNAL_COLLECTION");

assert.equal(config.promotion_rules.automatic_pr_creation, false);
assert.equal(config.promotion_rules.automatic_merge, false);
assert.equal(config.promotion_rules.automatic_deploy, false);
assert.equal(config.promotion_rules.production_model_write_requires_human_approval, true);

console.log(JSON.stringify({ ok: true, suite: "autonomous-squad-invariants", agents: config.agents.length, benchmarks: manifest.benchmarks.length, production_mutation_allowed: config.production_mutation_allowed }, null, 2));
