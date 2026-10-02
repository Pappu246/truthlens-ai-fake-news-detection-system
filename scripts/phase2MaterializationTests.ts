import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Benchmark = {
  id: string;
  status: string;
  dataset_hashes?: Record<string, string>;
  evidence_collection?: { required?: boolean; status?: string; sha256?: string; pinned_revision?: string };
};

const file = join(process.cwd(), 'research', 'multibenchmark-manifest.json');
const p = JSON.parse(readFileSync(file, 'utf8')) as { benchmarks: Benchmark[] };
const byId = new Map(p.benchmarks.map(b => [b.id, b]));

const fever = byId.get('fever_v1');
if (fever?.status !== 'FROZEN_AND_MATERIALIZED') throw new Error('FEVER must be frozen only after successful materialization');
for (const key of ['train_sha256', 'dev_sha256', 'wikipedia_zip_sha256']) {
  if (!fever?.dataset_hashes?.[key]) throw new Error('FEVER missing frozen hash: ' + key);
}

const feverous = byId.get('feverous');
if (feverous?.status !== 'FROZEN_AND_MATERIALIZED') throw new Error('FEVEROUS must be frozen only after successful materialization');
for (const key of ['train_sha256', 'dev_sha256', 'wikipedia_db_zip_sha256']) {
  if (!feverous?.dataset_hashes?.[key]) throw new Error('FEVEROUS missing frozen hash: ' + key);
}

const averitec = byId.get('averitec');
if (averitec?.status !== 'FROZEN_AND_MATERIALIZED') {
  throw new Error('AVeriTeC must be frozen only after the evidence-store materialization gate succeeds');
}
if (!averitec.evidence_collection?.required) throw new Error('AVeriTeC evidence collection must remain required');
if (averitec.evidence_collection.status !== 'MATERIALIZED_AND_HASH_VERIFIED') {
  throw new Error('AVeriTeC evidence-store status must record completed CI materialization');
}
if (averitec.evidence_collection.pinned_revision !== '26238ae') throw new Error('AVeriTeC evidence-store revision is not pinned');
if (averitec.evidence_collection.sha256 !== '021e258cd6fb5fe6d627a4667d663e95c184c966939c15124df9206142fc2212') {
  throw new Error('AVeriTeC evidence-store SHA-256 does not match the pinned source');
}
if (averitec.evidence_collection.materialization?.workflow_run !== 6) {
  throw new Error('AVeriTeC materialization workflow run is not recorded');
}
if (averitec.evidence_collection.materialization?.artifact_digest !== 'sha256:c5e1da712d42f264f10a637fe417bac0abfced0dd6873161a5a437db8c2e9480') {
  throw new Error('AVeriTeC materialization artifact digest is not recorded correctly');
}
if (averitec.evidence_collection.materialization?.verified_sha256 !== averitec.evidence_collection.sha256) {
  throw new Error('AVeriTeC verified SHA-256 does not match the pinned source SHA-256');
}

console.log('Phase 2 materialization guard: FEVER/FEVEROUS hashes are frozen; AVeriTeC evidence-store materialization is complete and hash-verified.');
