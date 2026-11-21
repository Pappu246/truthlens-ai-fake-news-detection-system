#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mergeAveritecProcessChunks.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'truthlens-averitec-process-chunks-'));
function writeChunk(root, start, count) {
  const dir = path.join(root, 'chunk-' + start);
  fs.mkdirSync(dir, { recursive: true });
  const predictions = [], claims = [];
  for (let id = start; id < start + count; id++) {
    predictions.push({ label: 'Supported', string_evidence: [], justification: '' });
    claims.push({ id, gold_label: 'Supported', prediction_label: 'Supported', production_prediction_label: 'Supported' });
  }
  const provenance = {
    evaluation_count: count,
    evaluation_scope: 'shard_' + start + '_' + (start + count) + '_of_500',
    claim_range: { start_claim: start, claim_count: count, end_exclusive: start + count },
    git_sha: 'a'.repeat(40),
    claims_sha256: 'b'.repeat(64),
    evidence_store: { sha256: 'c'.repeat(64) },
    models: { manifest_sha256: 'd'.repeat(64) },
    runner: { worker_recycle_every: 10 },
    claims
  };
  const predictionsPath = path.join(dir, 'predictions.json');
  const provenancePath = path.join(dir, 'provenance.json');
  fs.writeFileSync(predictionsPath, JSON.stringify(predictions) + '\n');
  fs.writeFileSync(provenancePath, JSON.stringify(provenance) + '\n');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(predictionsPath)).update(fs.readFileSync(provenancePath)).digest('hex');
  fs.writeFileSync(path.join(dir, 'bundle-sha256.txt'), digest + '\n');
}
try {
  const input = path.join(temp, 'chunks'), output = path.join(temp, 'out');
  fs.mkdirSync(input);
  for (let start = 0; start < 20; start += 10) writeChunk(input, start, Math.min(10, 20 - start));
  const result = spawnSync(process.execPath, [script, '--input-dir=' + input, '--output-dir=' + output, '--start=0', '--count=20'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'merger failed');
  const predictions = JSON.parse(fs.readFileSync(path.join(output, 'predictions.json'), 'utf8'));
  const provenance = JSON.parse(fs.readFileSync(path.join(output, 'provenance.json'), 'utf8'));
  if (predictions.length !== 20 || provenance.claims.length !== 20 || provenance.evaluation_count !== 20) throw new Error('merged count mismatch');
  if (provenance.process_chunk_count !== 2 || provenance.runner.worker_lifecycle !== 'one_fresh_os_process_per_chunk_no_worker_thread_recreation') throw new Error('process isolation provenance missing');
  console.log('AVeriTeC process-chunk merger regression: PASS');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
