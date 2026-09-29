#!/usr/bin/env node

import fs from "node:fs";

const state = JSON.parse(fs.readFileSync("research/v3-phase-state.json", "utf8"));
const phases = Object.entries(state.phases)
  .map(([id, status]) => [Number(id), status])
  .sort((a, b) => a[0] - b[0]);

const valid = new Set(["planned", "in_progress", "complete", "blocked"]);
const errors = [];

for (const [id, status] of phases) {
  if (!valid.has(status)) errors.push("invalid status for phase " + id + ": " + status);
}
if (!Number.isInteger(state.current_phase)) errors.push("current_phase must be integer");
if (state.current_phase < 0 || state.current_phase > 8) errors.push("current_phase outside 0..8");

const active = phases.filter(([, status]) => status === "in_progress");
if (state.rules.exactly_one_active_phase !== false && active.length !== 1) {
  errors.push("expected exactly one in_progress phase, found " + active.length);
}

if (active.length === 1 && active[0][0] !== state.current_phase) {
  errors.push("current_phase does not match the active phase");
}

for (const [id, status] of phases) {
  if (id < state.current_phase && status !== "complete") {
    errors.push("earlier phase " + id + " is not complete");
  }
  if (id > state.current_phase && ["in_progress", "complete", "blocked"].includes(status)) {
    errors.push("later phase " + id + " is already " + status);
  }
}

if (state.phases[String(state.rules.sota_claim_phase)] !== "planned") {
  errors.push("SOTA claim phase must remain planned until explicitly entered");
}
if (state.phases[String(state.rules.production_promotion_phase)] === "complete" &&
    state.phases[String(state.rules.sota_claim_phase)] !== "complete") {
  errors.push("production promotion phase cannot complete before SOTA audit phase");
}

if (errors.length) {
  console.error("TruthLens V3 sequential phase gate: FAIL");
  for (const error of errors) console.error("- " + error);
  process.exit(1);
}

console.log("TruthLens V3 sequential phase gate: PASS");
console.log("current_phase=" + state.current_phase);
console.log("active_phase=" + active[0][0]);
