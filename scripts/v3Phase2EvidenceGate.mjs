#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'phase2-artifacts');
function findFirst(dir, filename) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFirst(full, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return full;
    }
  }
  return null;
}

const required = [
  ['fever', ['strict_score','label_accuracy','evidence_precision','evidence_recall','evidence_f1']],
  ['averitec', ['veracity_accuracy','veracity_macro_f1']],
  ['feverous', ['strict_score','label_accuracy','evidence_precision','evidence_recall','evidence_f1']]
];
const errors=[];

for (const [benchmark, metrics] of required) {
  if (!fs.existsSync(root)) { errors.push('artifact root missing: ' + root); continue; }
  const target = findFirst(root, 'official-scorer-run.json');
  if (!target) { errors.push(benchmark + ': official-scorer-run.json not found'); continue; }
  let data;
  try { data = JSON.parse(fs.readFileSync(target,'utf8')); } catch (e) { errors.push(benchmark + ': invalid JSON: ' + e.message); continue; }
  if (data.benchmark_id !== benchmark) {
    // The recursive download can contain multiple scorer artifacts; keep searching for the matching benchmark.
    const candidates = [];
    function collect(dir) {
      for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
        const full=path.join(dir,entry.name);
        if(entry.isDirectory()) collect(full);
        else if(entry.name==='official-scorer-run.json') candidates.push(full);
      }
    }
    collect(root);
    const match=candidates.map(file=>({file,data:JSON.parse(fs.readFileSync(file,'utf8'))})).find(x=>x.data.benchmark_id===benchmark);
    if(!match){ errors.push(benchmark + ': matching official scorer artifact not found'); continue; }
    data=match.data;
  }
  if (!data.protocol_version) errors.push(benchmark + ': missing protocol_version');
  if (!data.generated_at) errors.push(benchmark + ': missing generated_at');
  for (const name of metrics) {
    const value=data.metrics?.[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(benchmark + ': metric not finite: ' + name);
  }
}

if(errors.length){
  console.error('TruthLens V3 Phase 2 evidence gate: FAIL');
  for(const e of errors) console.error('- '+e);
  process.exit(1);
}

console.log('TruthLens V3 Phase 2 evidence gate: PASS');
console.log('Validated official scorer artifacts for FEVER, AVeriTeC and FEVEROUS.');
