#!/usr/bin/env node

import fs from "node:fs/promises";

const file = "research/v3-phase-state.json";
const state = JSON.parse(await fs.readFile(file, "utf8"));

if (state.schema_version !== 1) {
  throw new Error("Unsupported V3 phase-state schema.");
}

const current = Number(state.current_phase);
const completed = new Set((state.completed_phases || []).map(Number));

if (!completed.has(current - 1) && current !== 0) {
  throw new Error("Phase sequencing violation: previous phase is not complete.");
}

if (current === 1 && state.phase2_unlocked) {
  throw new Error("Phase 2 cannot be unlocked while Phase 1 is current.");
}

if (current < 7 && state.sota_claim_allowed) {
  throw new Error("SOTA/world-leading claim flag cannot be enabled before Phase 7.");
}

if (state.current_phase_status === "COMPLETE" && !state.phase2_unlocked && current === 1) {
  throw new Error("Phase 1 marked complete without unlocking Phase 2 state.");
}

console.log(JSON.stringify({
  current_phase: current,
  status: state.current_phase_status,
  completed_phases: [...completed].sort((a,b) => a-b),
  phase2_unlocked: Boolean(state.phase2_unlocked),
  sota_claim_allowed: Boolean(state.sota_claim_allowed)
}, null, 2));
