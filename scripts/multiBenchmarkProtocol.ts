import { readFileSync } from 'node:fs';

type Benchmark = {
  id: string;
  status: string;
  task: string;
  labels: string[];
  source: string;
  metrics?: string[];
  evaluation?: { primary?: string | string[]; secondary?: string[] };
  dataset_hashes?: Record<string, string>;
};

type Protocol = {
  schema_version: number;
  phase: number;
  production_accuracy_claim: boolean;
  rules: Record<string, boolean>;
  benchmarks: Benchmark[];
};

const fail = (message: string): never => { throw new Error('Phase 2 protocol invalid: ' + message); };
const protocol = JSON.parse(readFileSync('research/multibenchmark-manifest.json', 'utf8')) as Protocol;

if (protocol.schema_version !== 1) fail('unsupported schema_version');
if (protocol.phase !== 2) fail('manifest must belong to Phase 2');
if (protocol.production_accuracy_claim !== false) fail('production_accuracy_claim must remain false');
for (const [key, value] of Object.entries(protocol.rules)) { if (value !== true) fail('required safety rule ' + key + ' is not enabled'); }

const required = new Set(['scifact', 'fever_v1', 'feverous', 'averitec', 'truthlens_open_web_v1']);
const seen = new Set<string>();
for (const benchmark of protocol.benchmarks) {
  if (!benchmark.id) fail('benchmark id is missing');
  if (seen.has(benchmark.id)) fail('duplicate benchmark id: ' + benchmark.id);
  seen.add(benchmark.id);
  if (!benchmark.task) fail(benchmark.id + ' has no task');
  if (!Array.isArray(benchmark.labels) || benchmark.labels.length < 2) fail(benchmark.id + ' must define labels');
  if (!benchmark.status) fail(benchmark.id + ' has no status');
  if (!benchmark.metrics && !benchmark.evaluation) fail(benchmark.id + ' has no metric contract');
  if (!benchmark.source) fail(benchmark.id + ' has no source');
}
for (const id of required) if (!seen.has(id)) fail('required benchmark missing: ' + id);
const sci = protocol.benchmarks.find((item) => item.id === 'scifact');
if (!sci?.dataset_hashes?.claims_sha256 || !sci?.dataset_hashes?.corpus_sha256) fail('SciFact hashes must remain frozen');
for (const id of ['fever_v1', 'feverous']) {
  const benchmark = protocol.benchmarks.find((item) => item.id === id);
  if (benchmark?.status === 'FROZEN_AND_MATERIALIZED' && !benchmark.dataset_hashes) {
    fail(id + ' is marked materialized but has no dataset_hashes');
  }
}

console.log(JSON.stringify({ ok: true, phase: protocol.phase, benchmarks: protocol.benchmarks.map((b) => ({ id: b.id, status: b.status })) }, null, 2));
