import { readFileSync } from 'node:fs';

const p = JSON.parse(readFileSync('research/multibenchmark-manifest.json', 'utf8')) as { phase:number; production_accuracy_claim:boolean; benchmarks:Array<{id:string;status:string;labels:string[]}> };
const expected = ['scifact','fever_v1','feverous','averitec','truthlens_open_web_v1'];
const ids = p.benchmarks.map((b) => b.id);
const assert = (condition:boolean, message:string) => { if (!condition) throw new Error(message); };
assert(p.phase === 2, 'wrong phase');
assert(p.production_accuracy_claim === false, 'production accuracy claim must be false');
assert(ids.length === expected.length, 'benchmark count mismatch');
for (const id of expected) assert(ids.includes(id), 'missing benchmark: ' + id);
for (const b of p.benchmarks) { assert(Boolean(b.status), b.id + ' missing status'); assert(b.labels.length >= 2, b.id + ' missing labels'); }
console.log('Phase 2 protocol tests: ' + ids.length + ' benchmark contracts validated.');
