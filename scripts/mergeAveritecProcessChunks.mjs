#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function arg(name, fallback) {
  const value = process.argv.find(item => item.startsWith('--' + name + '='));
  return value ? value.slice(name.length + 3) : fallback;
}
function find(root, name) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...find(file, name));
    else if (entry.isFile() && entry.name === name) result.push(file);
  }
  return result;
}
function sha256Files(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

const inputDir = path.resolve(arg('input-dir', 'artifacts/v2-averitec-e2e/chunks'));
const outputDir = path.resolve(arg('output-dir', 'artifacts/v2-averitec-e2e/shard'));
const start = Number(arg('start', '0'));
const count = Number(arg('count', '125'));
if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 1 || start + count > 500) {
  throw new Error('Invalid expected chunk range.');
}
const provenanceFiles = find(inputDir, 'provenance.json');
const chunks = provenanceFiles.map(file => {
  const dir = path.dirname(file);
  const provenance = JSON.parse(fs.readFileSync(file, 'utf8'));
  const predictionsPath = path.join(dir, 'predictions.json');
  const digestPath = path.join(dir, 'bundle-sha256.txt');
  if (!fs.existsSync(predictionsPath) || !fs.existsSync(digestPath)) throw new Error('Incomplete chunk artifact: ' + dir);
  const predictions = JSON.parse(fs.readFileSync(predictionsPath, 'utf8'));
  const expectedDigest = sha256Files([predictionsPath, file]);
  const storedDigest = fs.readFileSync(digestPath, 'utf8').trim();
  if (expectedDigest !== storedDigest) throw new Error('Chunk bundle digest mismatch: ' + dir);
  const chunkStart = Number(provenance.claim_range?.start_claim);
  const chunkCount = Number(provenance.claim_range?.claim_count);
  if (!Number.isInteger(chunkStart) || !Number.isInteger(chunkCount) || predictions.length !== chunkCount ||
      provenance.evaluation_count !== chunkCount || !Array.isArray(provenance.claims) ||
      provenance.claims.length !== chunkCount) throw new Error('Invalid chunk metadata: ' + dir);
  return { dir, file, predictions, provenance, start: chunkStart, count: chunkCount, digest: storedDigest };
}).sort((a, b) => a.start - b.start);

let next = start;
for (const chunk of chunks) {
  if (chunk.start !== next) throw new Error('Chunk coverage gap/overlap: expected ' + next + ', got ' + chunk.start);
  if (chunk.provenance.git_sha !== chunks[0].provenance.git_sha) throw new Error('Mixed evaluated commits across chunks.');
  if (chunk.provenance.models?.manifest_sha256 !== chunks[0].provenance.models?.manifest_sha256) throw new Error('Mixed model manifests across chunks.');
  if (chunk.provenance.claims_sha256 !== chunks[0].provenance.claims_sha256 ||
      chunk.provenance.evidence_store?.sha256 !== chunks[0].provenance.evidence_store?.sha256) {
    throw new Error('Mixed AVeriTeC input hashes across chunks.');
  }
  next += chunk.count;
}
if (next !== start + count) throw new Error('Expected coverage ' + start + '-' + (start + count) + ', got ' + start + '-' + next);
const predictions = chunks.flatMap(chunk => chunk.predictions);
const claims = chunks.flatMap(chunk => chunk.provenance.claims);
if (predictions.length !== count || claims.length !== count) throw new Error('Merged chunk count mismatch.');
for (let i = 0; i < count; i++) {
  const expectedId = start + i;
  if (claims[i]?.id !== expectedId) throw new Error('Claim order mismatch at ' + expectedId);
  if (predictions[i]?.label !== claims[i]?.prediction_label) throw new Error('Prediction/provenance mismatch at ' + expectedId);
}
const provenance = {
  ...chunks[0].provenance,
  evaluation_scope: 'shard_' + start + '_' + (start + count) + '_of_500',
  evaluation_count: count,
  claim_range: { start_claim: start, claim_count: count, end_exclusive: start + count },
  process_chunk_count: chunks.length,
  process_chunk_size: 10,
  claims,
  chunks: chunks.map(chunk => ({
    start_claim: chunk.start,
    claim_count: chunk.count,
    bundle_sha256: chunk.digest
  }))
};
provenance.runner = {
  ...provenance.runner,
  process_chunk_size: 10,
  worker_lifecycle: 'one_fresh_os_process_per_chunk_no_worker_thread_recreation'
};
fs.mkdirSync(outputDir, { recursive: true });
const predictionsPath = path.join(outputDir, 'predictions.json');
const provenancePath = path.join(outputDir, 'provenance.json');
fs.writeFileSync(predictionsPath, JSON.stringify(predictions, null, 2) + '\n');
fs.writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + '\n');
const digest = sha256Files([predictionsPath, provenancePath]);
fs.writeFileSync(path.join(outputDir, 'bundle-sha256.txt'), digest + '\n');
console.log(JSON.stringify({ ok: true, start, count, process_chunks: chunks.length, bundle_sha256: digest }, null, 2));
