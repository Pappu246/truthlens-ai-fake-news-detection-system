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
    await run("git", ["clone", "--depth", "50", "https://github.com/Raldir/FEVEROUS.git", "repo"], tmp);
    await run("git", ["checkout", "32b68ce4e33c53f34ae2e6d88b51cd073ab85ab6"], path.join(tmp, "repo"));
    const evaluator = path.join(tmp, "repo", "src", "feverous", "evaluation", "evaluate.py");
    const scorerInput = path.join(tmp, "predictions.jsonl");
    const predictedLines = (await fs.readFile(input, "utf8")).split(/\r?\n/).filter(Boolean);
    await fs.writeFile(scorerInput, JSON.stringify({ id: "header" }) + "\n" + predictedLines.join("\n") + "\n");
    const scorerRun = await new Promise((resolve, reject) => {
      const child = spawn("python3", [evaluator, "--input_path", scorerInput], {
        cwd: tmp,
        env: { ...process.env, PYTHONPATH: path.join(tmp, "repo", "src") },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error("FEVEROUS evaluator exited " + code + "\n" + stderr)));
    });
    const out = path.resolve(arg("output") || "artifacts/v3/feverous/official-scorer-run.json");
    await fs.mkdir(path.dirname(out), { recursive: true });
    const metricNumber = (pattern) => {
      const match = scorerRun.stdout.match(pattern);
      return match ? Number(match[1]) : null;
    };
    const metrics = {
      strict_score: metricNumber(/Strict score:\s*([0-9.eE+-]+)/),
      label_accuracy: metricNumber(/Label Accuracy:\s*([0-9.eE+-]+)/),
      evidence_precision: metricNumber(/Retrieval Precision:\s*([0-9.eE+-]+)/),
      evidence_recall: metricNumber(/Retrieval Recall:\s*([0-9.eE+-]+)/),
      evidence_f1: metricNumber(/Retrieval F1:\s*([0-9.eE+-]+)/)
    };
    await fs.writeFile(out, JSON.stringify({
      benchmark_id: "feverous",
      protocol_version: "truthlens-v3-benchmark-protocol-v1",
      evaluator_source: "https://github.com/Raldir/FEVEROUS/blob/32b68ce4e33c53f34ae2e6d88b51cd073ab85ab6/src/feverous/evaluation/evaluate.py",
      input,
      metrics,
      scorer_stdout: scorerRun.stdout,
      scorer_stderr: scorerRun.stderr,
      generated_at: new Date().toISOString()
    }, null, 2) + "\n");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error?.stack || error); process.exit(1); });