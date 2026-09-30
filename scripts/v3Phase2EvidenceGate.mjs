#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'phase2-artifacts');
const required = [
  ['fever', 'official-scorer-run.json', ['strict_score','label_accuracy','evidence_precision','evidence_recall','evidence_f1']],
  ['averitec', 'official-scorer-run.json', ['veracity_accuracy','veracity_macro_f1']],
  ['feverous', 'official-scorer-run.json', ['strict_score','label_accuracy','evidence_precision','evidence_recall','evidence_f1']]
];
const errors=[];

for (const [benchmark,file,metrics] of required) {
  const target = path.join(root, benchmark, file);
  if (!fs.existsSync(target)) { errors.push(benchmark + ': missing ' + file); continue; }
  let data;
  try { data = JSON.parse(fs.readFileSync(target,'utf8')); } catch (e) { errors.push(benchmark + ': invalid JSON: ' + e.message); continue; }
  if (data.benchmark_id !== benchmark) errors.push(benchmark + ': benchmark_id mismatch');
  if (!data.protocol_version) errors.push(benchmark + ': missing protocol_version');
  if (!data.generated_at) errors.push(benchmark + ': missing generated_at');
  for (const name of metrics) {
    const value = data.metrics?.[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(benchmark + ': metric not finite: ' + name);
  }
}

if (errors.length) {
  console.error('TruthLens V3 Phase 2 evidence gate: FAIL');
  for (const e of errors) console.error('- ' + e);
  process.exit(1);
}

console.log('TruthLens V3 Phase 2 evidence gate: PASS');
console.log('Validated FEVER, AVeriTeC and FEVEROUS official scorer artifacts.');
