#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const hit = process.argv.find((v) => v.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const input = path.resolve(arg('input', 'data/v3/openweb-external/candidate-claims.jsonl'));
const output = path.resolve(arg('output', 'data/v3/openweb-external/annotation-pack.jsonl'));
if (!fs.existsSync(input)) {
  console.error('Candidate claim file missing: ' + input);
  process.exit(1);
}

const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const seen = new Set();
const pack = [];

for (const row of rows) {
  const claimId = String(row.claim_id || '');
  const claim = String(row.claim || '');
  if (!claimId || !claim || seen.has(claimId)) {
    throw new Error('missing or duplicate claim_id/claim: ' + claimId);
  }
  seen.add(claimId);
  pack.push({
    claim_id: claimId,
    claim,
    claim_date: row.claim_date ?? null,
    annotation: {
      reviewer_a: { label: null, evidence: [], annotator_id: null },
      reviewer_b: { label: null, evidence: [], annotator_id: null },
      agreement: null,
      adjudication: null
    }
  });
}

if (pack.length < 300) {
  throw new Error('minimum external holdout size is 300 claims; found ' + pack.length);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(pack, null, 2) + '\n');
console.log(JSON.stringify({
  benchmark_id: 'openweb-external',
  annotation_rows: pack.length,
  output,
  note: 'This is a blank independent-annotation pack. It contains no model-generated labels.'
}, null, 2));
