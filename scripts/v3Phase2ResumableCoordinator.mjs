#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const OUT = path.resolve(process.env.PHASE2_COORDINATOR_OUT || "artifacts/v3/phase2-coordinator");
const MANIFEST = path.join(ROOT, "research", "multibenchmark-manifest.json");

function arg(name, fallback) {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(await fsp.readFile(file));
  return hash.digest("hex");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(command + " exited with code " + code + (stderr ? "\n" + stderr : "")));
    });
  });
}

function assertPhase2(manifest) {
  if (manifest.phase !== 2) throw new Error("Phase 2 coordinator blocked: manifest phase is " + manifest.phase);
  if (manifest.production_accuracy_claim !== false) {
    throw new Error("Phase 2 coordinator blocked: production accuracy claim flag must remain false");
  }
  if (manifest.rules?.production_artifact_must_remain_unchanged !== true) {
    throw new Error("Phase 2 coordinator blocked: production artifact immutability rule is missing");
  }
}

function findBenchmark(manifest, id) {
  const benchmark = (manifest.benchmarks || []).find((item) => item.id === id);
  if (!benchmark) throw new Error("Unknown benchmark: " + id);
  return benchmark;
}

function expectedEvaluationCount(benchmark) {
  return Number.isInteger(benchmark.expected_evaluation_claims)
    ? benchmark.expected_evaluation_claims
    : null;
}

async function checkpoint(state) {
  await fsp.mkdir(OUT, { recursive: true });
  state.updated_at = new Date().toISOString();
  state.git_sha = process.env.GITHUB_SHA || null;
  state.workflow_run_id = process.env.GITHUB_RUN_ID || null;
  state.config_sha256 = await sha256File(MANIFEST);
  await fsp.writeFile(path.join(OUT, "checkpoint.json"), JSON.stringify(state, null, 2) + "\n");
}

async function runFever(benchmark, maxClaims) {
  const root = path.resolve("artifacts/v3/fever");
  const assetRoot = path.resolve("artifacts/v3/benchmark-assets/fever");
  await run("node", ["scripts/benchmarks/v3MaterializeScoringAssets.mjs", "--benchmark=fever"]);
  await run("unzip", ["-q", path.join(assetRoot, "wiki-pages.zip"), "-d", path.join(root, "wiki-pages")]);

  const shard = (await run("bash", ["-lc", "find " + JSON.stringify(root + "/wiki-pages") + " -name 'wiki-*.jsonl' -print -quit"], { capture: true })).stdout.trim();
  if (!shard) throw new Error("FEVER wiki shard not found");
  const wikiDir = path.dirname(shard);

  await run("python3", [
    "scripts/benchmarks/v3FeverPrepareCandidates.py",
    "--wiki-dir=" + wikiDir,
    "--claims=" + path.join(assetRoot, "shared_task_dev.jsonl"),
    "--db=" + path.join(root, "fever-sentences.sqlite"),
    "--output=" + path.join(root, "candidates.jsonl"),
    "--build-index",
    "--top-k=100"
  ]);

  const configSha = await sha256File(MANIFEST);
  const claimsSha = (await readJson(path.join(assetRoot, "asset-manifest.json"))).files.find((f) => f.name === "shared_task_dev.jsonl")?.sha256;
  const corpusSha = (await readJson(path.join(assetRoot, "asset-manifest.json"))).files.find((f) => f.name === "wiki-pages.zip")?.sha256;

  await run("npx", [
    "tsx", "scripts/benchmarks/v3FeverEvaluate.ts",
    "--input=" + path.join(root, "candidates.jsonl"),
    "--max-claims=" + maxClaims,
    "--output=" + path.join(root, "truthlens-adapter-report.json"),
    "--predictions-output=" + path.join(root, "truthlens-predictions.json"),
    "--claims-sha256=" + claimsSha,
    "--corpus-sha256=" + corpusSha,
    "--commit-sha=" + (process.env.GITHUB_SHA || "local"),
    "--config-sha256=" + configSha
  ]);

  await run("python3", ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "six"]);
  await run("node", [
    "scripts/benchmarks/v3FeverOfficialEvaluate.mjs",
    "--predictions=" + path.join(root, "truthlens-predictions.json"),
    "--actual=" + path.join(root, "shared_task_dev.jsonl"),
    "--output=" + path.join(root, "official-scorer-run.json")
  ]);

  return path.join(root, "official-scorer-run.json");
}

async function runFeverous(benchmark, maxClaims) {
  const root = path.resolve("artifacts/v3/feverous");
  const assetRoot = path.resolve("artifacts/v3/benchmark-assets/feverous");
  await run("node", ["scripts/benchmarks/v3MaterializeScoringAssets.mjs", "--benchmark=feverous"]);
  await run("unzip", ["-q", path.join(assetRoot, "feverous-wiki-pages-db.zip"), "-d", path.join(root, "wiki-db")]);

  const dbPath = (await run("bash", ["-lc", "find " + JSON.stringify(root + "/wiki-db") + " -name '*.db' -print -quit"], { capture: true })).stdout.trim();
  if (!dbPath) throw new Error("FEVEROUS SQLite database not found");

  await run("python3", [
    "scripts/benchmarks/v3FeverousPrepareCandidates.py",
    "--db=" + dbPath,
    "--claims=" + path.join(assetRoot, "dev.jsonl"),
    "--output=" + path.join(root, "candidates.jsonl"),
    "--max-claims=" + maxClaims
  ]);

  await run("npx", [
    "tsx", "scripts/benchmarks/v3FeverousEvaluate.ts",
    "--input=" + path.join(root, "candidates.jsonl"),
    "--max-claims=" + maxClaims,
    "--output=" + path.join(root, "truthlens-predictions.jsonl"),
    "--report=" + path.join(root, "truthlens-adapter-report.json")
  ]);

  await run("node", [
    "scripts/benchmarks/v3FeverousOfficialEvaluate.mjs",
    "--input=" + path.join(root, "truthlens-predictions.jsonl"),
    "--output=" + path.join(root, "official-scorer-run.json")
  ]);

  return path.join(root, "official-scorer-run.json");
}

async function main() {
  const manifest = await readJson(MANIFEST);
  assertPhase2(manifest);

  const requested = arg("benchmark", "fever_v1,feverous").split(",").map((x) => x.trim()).filter(Boolean);
  const benchmarkIds = requested.includes("all")
    ? ["scifact", "fever_v1", "feverous", "averitec", "truthlens_open_web_v1"]
    : requested;
  const maxClaims = Math.max(1, Number(arg("max-claims", "100")));

  const checkpointFile = path.join(OUT, "checkpoint.json");
  let state = {
    schema_version: 1,
    protocol: "truthlens-v3-phase2-resumable-coordinator-v1",
    started_at: new Date().toISOString(),
    phase: 2,
    production_mutation_allowed: false,
    checkpoints: {}
  };
  if (await fsp.stat(checkpointFile).then(() => true).catch(() => false) && arg("resume", "true") !== "false") {
    try {
      const previous = await readJson(checkpointFile);
      if (previous.protocol === state.protocol && previous.phase === 2) {
        state = {
          ...state,
          ...previous,
          resumed_at: new Date().toISOString(),
          checkpoints: previous.checkpoints || {}
        };
      }
    } catch {
      // Corrupt/incompatible checkpoints are ignored; the new run still stays fail-closed.
    }
  }

  await fsp.mkdir(OUT, { recursive: true });
  try {
    for (const id of benchmarkIds) {
      const prior = state.checkpoints[id];
      if (prior && ["SKIPPED_BASELINE", "HUMAN_REQUIRED", "BLOCKED"].includes(prior.status)) {
        continue;
      }
      if (prior?.status === "COMPLETE" && prior.evaluation_count && prior.expected_evaluation_claims && prior.evaluation_count >= prior.expected_evaluation_claims) {
        continue;
      }
      const benchmark = findBenchmark(manifest, id);
      if (id === "scifact") {
        state.checkpoints[id] = { status: "SKIPPED_BASELINE", reason: "Authoritative SciFact baseline already exists." };
        await checkpoint(state);
        continue;
      }
      if (id === "truthlens_open_web_v1") {
        state.checkpoints[id] = { status: "HUMAN_REQUIRED", reason: "Blind human-labelled holdout is not frozen." };
        await checkpoint(state);
        continue;
      }
      if (benchmark.status !== "FROZEN_AND_MATERIALIZED") {
        state.checkpoints[id] = { status: "BLOCKED", reason: "Benchmark is not materialized in the frozen protocol." };
        await checkpoint(state);
        continue;
      }

      state.checkpoints[id] = {
        status: "RUNNING",
        max_claims: maxClaims,
        expected_evaluation_claims: expectedEvaluationCount(benchmark)
      };
      await checkpoint(state);

      const artifact = id === "fever_v1"
        ? await runFever(benchmark, maxClaims)
        : id === "feverous"
          ? await runFeverous(benchmark, maxClaims)
          : null;

      if (!artifact) {
        state.checkpoints[id] = {
          status: "BLOCKED_MISSING_RUNNER",
          reason: "No executable adapter is present on this scoring-recovery branch.",
          expected_next_step: "Recover the AVeriTeC scorer/runner on a separate research branch."
        };
        await checkpoint(state);
        continue;
      }
      const report = await readJson(artifact);
      if (report.benchmark_id !== id) throw new Error(id + " scorer artifact benchmark_id mismatch");

      const evaluationCount =
        Number.isInteger(report.evaluation_count)
          ? report.evaluation_count
          : Number.isInteger(report.dataset?.evaluation_count)
            ? report.dataset.evaluation_count
            : maxClaims;
      const expectedCount = expectedEvaluationCount(benchmark);
      const fullEvaluation = expectedCount === null || evaluationCount >= expectedCount;
      state.checkpoints[id] = {
        status: fullEvaluation ? "COMPLETE" : "PILOT_COMPLETE",
        max_claims: maxClaims,
        evaluation_count: evaluationCount,
        expected_evaluation_claims: expectedCount,
        artifact,
        artifact_sha256: await sha256File(artifact),
        metrics: report.metrics || {},
        completed_at: new Date().toISOString()
      };
      await checkpoint(state);
    }

    const requiredFullBenchmarksComplete = ["fever_v1", "feverous", "averitec"].every((id) => {
      const checkpoint = state.checkpoints[id];
      return checkpoint?.status === "COMPLETE";
    });
    state.overall_status = requiredFullBenchmarksComplete
      ? "FULL_BENCHMARKS_COMPLETE_PENDING_OPEN_WEB"
      : "RECOVERY_PROGRESS_RECORDED";
    await checkpoint(state);

    console.log(JSON.stringify(state, null, 2));
  } catch (error) {
    state.overall_status = "FAILED";
    state.error = error instanceof Error ? error.message : String(error);
    await checkpoint(state);
    throw error;
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
