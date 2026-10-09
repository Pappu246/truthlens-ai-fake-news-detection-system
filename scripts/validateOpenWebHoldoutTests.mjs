#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATOR = path.join(ROOT, "scripts/validateOpenWebHoldout.mjs");
const SCHEMA = path.join(ROOT, "research/open-web-v1-holdout-schema.json");

function makeRow(index, now) {
  const claimDate = new Date(now - 60_000).toISOString();
  const sourcePublishedAt = new Date(now - 120_000).toISOString();
  const reviewed = new Date(now - 30_000).toISOString();
  const sourceType = index < 50 ? "PRIMARY" : "MAJOR_NEWS";
  const label = ["SUPPORTED", "REFUTED", "INSUFFICIENT_EVIDENCE", "CONFLICTED"][index % 4];
  return {
    claim_id: "test-claim-" + index,
    claim: "Test proposition " + index + " with a source-grounded claim.",
    claim_date: claimDate,
    claim_source_url: "https://example.com/claims/" + index,
    claim_source_type: sourceType,
    claim_source_published_at: sourcePublishedAt,
    human_label: label,
    human_reviewed_at: reviewed,
    duplicate_cluster_id: "cluster-" + index,
    evidence_items: [{
      url: "https://example.com/evidence/" + index,
      publisher: "Example Publisher",
      published_at: new Date(now - 90_000).toISOString(),
      source_class: sourceType,
      evidence_text: "Pre-claim-date evidence text for test claim " + index + "."
    }]
  };
}

async function runFixture(records, expectSuccess) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "truthlens-openweb-test-"));
  try {
    const input = path.join(temp, "holdout.jsonl");
    const output = path.join(temp, "out");
    await fs.writeFile(input, records.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const result = spawnSync(process.execPath, [
      VALIDATOR,
      "--input=" + input,
      "--schema=" + SCHEMA,
      "--output-dir=" + output
    ], { encoding: "utf8", timeout: 20_000 });
    if (expectSuccess) {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const manifest = JSON.parse(await fs.readFile(path.join(output, "holdout-release-manifest.json"), "utf8"));
      assert.equal(manifest.release_state, "SEALED");
      assert.equal(manifest.evaluation_count, 100);
      assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
    } else {
      assert.notEqual(result.status, 0, "invalid holdout must fail closed");
      await assert.rejects(fs.access(path.join(output, "holdout-release-manifest.json")));
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function main() {
  const now = Date.now();
  const valid = Array.from({ length: 100 }, (_, index) => makeRow(index, now));
  await runFixture(valid, true);

  const missingHumanLabel = valid.map((row) => ({ ...row }));
  missingHumanLabel[4].human_label = "";
  await runFixture(missingHumanLabel, false);

  const postClaimEvidence = valid.map((row) => ({ ...row, evidence_items: row.evidence_items.map((item) => ({ ...item })) }));
  postClaimEvidence[8].evidence_items[0].published_at = new Date(now + 120_000).toISOString();
  await runFixture(postClaimEvidence, false);

  const unbalancedSources = valid.map((row) => ({ ...row, claim_source_type: "PRIMARY", evidence_items: row.evidence_items.map((item) => ({ ...item })) }));
  await runFixture(unbalancedSources, false);

  await runFixture(valid.slice(0, 99), false);
  console.log("Open-Web holdout validator tests: PASS (valid seal + missing labels + temporal leak + unbalanced sources + row count)");
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
