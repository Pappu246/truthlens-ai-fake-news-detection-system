#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const input = path.resolve(process.argv.find(x => x.startsWith("--input="))?.slice(8) || "research/open-web-v1-holdout.jsonl");
const expectedLabels = new Set(["SUPPORTED", "REFUTED", "INSUFFICIENT_EVIDENCE", "CONFLICTED"]);
const sourceTypes = new Set(["PRIMARY", "MAJOR_NEWS"]);
const evidenceClasses = new Set(["PRIMARY", "MAJOR_NEWS", "OTHER"]);

const fail = (message) => { throw new Error("Open-Web holdout gate failed: " + message); };

const text = await fs.readFile(input, "utf8");
const rows = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

if (rows.length !== 100) fail("expected exactly 100 claims, found " + rows.length);

const ids = new Set();
let primaryClaims = 0;
let majorNewsClaims = 0;

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  if (!row.claim_id || ids.has(row.claim_id)) fail("duplicate/missing claim_id at row " + (i + 1));
  ids.add(row.claim_id);

  if (!row.claim || !row.claim_date) fail("claim text/date missing for " + row.claim_id);
  if (!sourceTypes.has(row.claim_source_type)) fail("invalid claim_source_type for " + row.claim_id);
  if (!row.claim_source_url || !row.claim_source_published_at) fail("claim source provenance missing for " + row.claim_id);
  if (!expectedLabels.has(row.human_label)) fail("human label missing/invalid for " + row.claim_id);
  if (!row.human_reviewed_at) fail("human review timestamp missing for " + row.claim_id);
  if (!row.duplicate_cluster_id) fail("duplicate cluster missing for " + row.claim_id);

  const claimDate = new Date(row.claim_date);
  if (Number.isNaN(claimDate.getTime())) fail("invalid claim_date for " + row.claim_id);

  if (row.claim_source_type === "PRIMARY") primaryClaims++;
  if (row.claim_source_type === "MAJOR_NEWS") majorNewsClaims++;

  if (!Array.isArray(row.evidence_items)) fail("evidence_items missing for " + row.claim_id);
  for (const evidence of row.evidence_items) {
    if (!evidence.url || !evidence.publisher || !evidence.published_at || !evidence.evidence_text) {
      fail("incomplete evidence provenance for " + row.claim_id);
    }
    if (!evidenceClasses.has(evidence.source_class)) fail("invalid source_class for " + row.claim_id);

    const evidenceDate = new Date(evidence.published_at);
    if (Number.isNaN(evidenceDate.getTime())) fail("invalid evidence published_at for " + row.claim_id);
    if (evidenceDate.getTime() > claimDate.getTime()) {
      fail("post-claim evidence admitted for " + row.claim_id + ": " + evidence.url);
    }
  }
}

if (primaryClaims === 0 || majorNewsClaims === 0) {
  fail("holdout must contain both PRIMARY and MAJOR_NEWS claim-source classes");
}

const digest = crypto.createHash("sha256").update(text).digest("hex");
const manifest = {
  schema_version: 1,
  benchmark_id: "truthlens_open_web_v1",
  release_state: "SEALED",
  claims: rows.length,
  primary_claims: primaryClaims,
  major_news_claims: majorNewsClaims,
  sha256: digest,
  generated_at: new Date().toISOString(),
  production_evaluation_allowed: true
};

const out = path.resolve("artifacts/v3/open-web-v1/holdout-release-manifest.json");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
