#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();

function arg(name) {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function findFirst(root, predicate) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findFirst(full, predicate);
      if (found) return found;
    } else if (predicate(entry.name, full)) {
      return full;
    }
  }
  return null;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log("$ " + [command, ...args].join(" "));
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(command + " exited with code " + code));
    });
  });
}

function assertPhase2() {
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, "research", "v3-phase-state.json"), "utf8"));
  if (state.current_phase !== 2 || state.phases["2"] !== "in_progress") {
    throw new Error("Phase 2 coordinator blocked: current phase is " + state.current_phase);
  }
  for (const [id, status] of Object.entries(state.phases)) {
    if (Number(id) > 2 && status !== "planned") {
      throw new Error("Phase 2 coordinator blocked: later phase " + id + " is " + status);
    }
  }
}

async function runScifact() {
  await run("npm", ["run", "eval:v2-scifact-e2e"]);
}

async function runFever() {
  const root = path.join(ROOT, "artifacts", "v3", "fever");
  await run("node", ["scripts/benchmarks/v3MaterializeAssets.mjs", "--benchmark=fever", "--with-corpus"]);
  await run("unzip", ["-q", path.join(root, "wiki-pages.zip"), "-d", path.join(root, "wiki-pages")]);
  const feverShard = await findFirst(path.join(root, "wiki-pages"), (name) => /^wiki-.*\\.jsonl$/.test(name));
  if (!feverShard) throw new Error("FEVER wiki shard not found after extraction");
  const feverWikiDir = path.dirname(feverShard);
  const feverManifest = JSON.parse(fs.readFileSync(path.join(root, "asset-manifest.json"), "utf8"));
  const feverClaimsSha = feverManifest.files.find((f) => f.name === "shared_task_dev.jsonl")?.sha256;
  const feverCorpusSha = feverManifest.files.find((f) => f.name === "wiki-pages.zip")?.sha256;
  const configSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "research", "v3-benchmark-registry.json"))).digest("hex");
  await run("python3", [
    "scripts/benchmarks/v3FeverPrepareCandidates.py",
    "--wiki-dir=" + feverWikiDir,
    "--claims=" + path.join(root, "shared_task_dev.jsonl"),
    "--db=" + path.join(root, "fever-sentences.sqlite"),
    "--output=" + path.join(root, "candidates.jsonl"),
    "--build-index"
  ]);
  await run("npx", [
    "tsx", "scripts/benchmarks/v3FeverEvaluate.ts",
    "--input=" + path.join(root, "candidates.jsonl"),
    "--output=" + path.join(root, "truthlens-adapter-report.json"),
    "--predictions-output=" + path.join(root, "truthlens-predictions.json"),
    "--claims-sha256=" + feverClaimsSha,
    "--corpus-sha256=" + feverCorpusSha,
    "--config-sha256=" + configSha
  ]);
  await run("node", [
    "scripts/benchmarks/v3FeverOfficialEvaluate.mjs",
    "--predictions=" + path.join(root, "truthlens-predictions.json"),
    "--actual=" + path.join(root, "shared_task_dev.jsonl"),
    "--output=" + path.join(root, "official-scorer-run.json")
  ]);
}

async function runAveritec() {
  const root = path.join(ROOT, "artifacts", "v3", "averitec");
  await run("node", ["scripts/benchmarks/v3MaterializeAssets.mjs", "--benchmark=averitec"]);
  await run("npx", [
    "tsx", "scripts/benchmarks/v3AveritecTruthLensEvaluate.ts",
    "--input=" + path.join(root, "dev.json"),
    "--output=" + path.join(root, "truthlens-predictions.json")
  ]);
  await run("node", [
    "scripts/benchmarks/v3AveritecOfficialEvaluate.mjs",
    "--predictions=" + path.join(root, "truthlens-predictions.json"),
    "--references=" + path.join(root, "dev.json"),
    "--output=" + path.join(root, "official-scorer-run.json")
  ]);
}

async function runFeverous() {
  const root = path.join(ROOT, "artifacts", "v3", "feverous");
  await run("node", ["scripts/benchmarks/v3MaterializeAssets.mjs", "--benchmark=feverous", "--with-corpus"]);
  await run("unzip", ["-q", path.join(root, "feverous-wiki-pages-db.zip"), "-d", path.join(root, "wiki-db")]);
  const dbPath = await findFirst(path.join(root, "wiki-db"), (name) => name.endsWith(".db"));
  if (!dbPath) throw new Error("FEVEROUS SQLite database not found after extraction");
  await run("python3", [
    "scripts/benchmarks/v3FeverousPrepareCandidates.py",
    "--db=" + dbPath,
    "--claims=" + path.join(root, "dev.jsonl"),
    "--output=" + path.join(root, "candidates.jsonl")
  ]);
  await run("npx", [
    "tsx", "scripts/benchmarks/v3FeverousEvaluate.ts",
    "--input=" + path.join(root, "candidates.jsonl"),
    "--output=" + path.join(root, "truthlens-predictions.jsonl"),
    "--report=" + path.join(root, "truthlens-adapter-report.json")
  ]);
  await run("node", [
    "scripts/benchmarks/v3FeverousOfficialEvaluate.mjs",
    "--input=" + path.join(root, "truthlens-predictions.jsonl"),
    "--output=" + path.join(root, "official-scorer-run.json")
  ]);
}

async function runOpenWeb() {
  throw new Error("External open-web benchmark blocked until the independently annotated holdout is sealed and hash-pinned.");
}

if (process.argv.includes("--check-only")) {
  assertPhase2();
  console.log("TruthLens V3 Phase 2 coordinator dry-check: PASS");
  process.exit(0);
}

async function main() {
  assertPhase2();
  const benchmark = arg("benchmark");
  if (!benchmark) {
    console.error("Usage: node scripts/v3BenchmarkCoordinator.mjs --benchmark=scifact|fever|averitec|feverous|openweb-external");
    process.exit(2);
  }

  switch (benchmark) {
    case "scifact":
      await runScifact();
      break;
    case "fever":
      await runFever();
      break;
    case "averitec":
      await runAveritec();
      break;
    case "feverous":
      await runFeverous();
      break;
    case "openweb-external":
      await runOpenWeb();
      break;
    default:
      throw new Error("Unknown benchmark: " + benchmark);
  }

  console.log("TruthLens V3 Phase 2 benchmark coordinator: PASS");
}

main().catch((error) => {
  console.error("TruthLens V3 Phase 2 benchmark coordinator: BLOCKED");
  console.error(error?.stack || error);
  process.exit(1);
});
