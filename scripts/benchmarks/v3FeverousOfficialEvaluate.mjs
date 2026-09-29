#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
function arg(name) { const hit = process.argv.find((v) => v.startsWith("--" + name + "=")); return hit ? hit.slice(name.length + 3) : undefined; }
function run(command, args, cwd, env = process.env) { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd, env, stdio: "inherit" }); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(command + " exited " + code))); }); }
async function main() {
  const input = path.resolve(arg("input") || "artifacts/v3/feverous/predictions.jsonl");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "truthlens-feverous-"));
  try {
    await run("git", ["clone", "--depth", "1", "https://github.com/Raldir/FEVEROUS.git#32b68ce4e33c53f34ae2e6d88b51cd073ab85ab6", "repo"], tmp);
    const evaluator = path.join(tmp, "repo", "src", "feverous", "evaluation", "evaluate.py");
    await run("python3", [evaluator, "--input_path", input], tmp, { ...process.env, PYTHONPATH: path.join(tmp, "repo", "src") });
    const out = path.resolve(arg("output") || "artifacts/v3/feverous/official-scorer-run.json");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify({ benchmark_id: "feverous", protocol_version: "truthlens-v3-benchmark-protocol-v1", evaluator_source: "https://github.com/Raldir/FEVEROUS/blob/main/src/feverous/evaluation/evaluate.py", input, generated_at: new Date().toISOString() }, null, 2) + "\n");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error?.stack || error); process.exit(1); });