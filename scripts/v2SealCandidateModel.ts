/**
 * TRUTHLENS V2.2 — CANDIDATE SEAL RECORDER
 * =========================================
 * Computes the content seal (per-file byte size + SHA-256, plus the git blob
 * SHA-1 each file would have) for a LOCALLY PRESENT candidate model
 * directory, and prints a ready-to-paste `ExperimentalNliCandidate` block.
 *
 * This is the ONLY supported way to add seals to
 * server/v2/ml/modelManifest.ts: seals must be computed from bytes that are
 * actually on disk, never copied from a web page or guessed. The script
 * never writes into the manifest itself — a human pastes the block, which
 * keeps the attestation an explicit, reviewable act.
 *
 * Usage:
 *   npm run seal:v2-candidate -- --model=Xenova/DeBERTa-v3-base-mnli-fever-anli \
 *                                --dir=/path/to/Xenova/DeBERTa-v3-base-mnli-fever-anli \
 *                                [--revision=<hf commit sha>]
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EXPECTED_CANDIDATE_FILES, getV2ModelDir } from '../server/v2/ml/modelManifest';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** git blob SHA-1: sha1("blob <len>\0" + content) — the source-side attestation. */
function gitBlobSha1(buffer: Buffer): string {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, buffer])).digest('hex');
}

function listFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, relative));
    else out.push(relative.split(path.sep).join('/'));
  }
  return out.sort();
}

function main(): void {
  const id = arg('model');
  if (!id) throw new Error('Usage: npm run seal:v2-candidate -- --model=<id> [--dir=<path>] [--revision=<sha>]');
  const root = path.resolve(arg('dir') || path.join(getV2ModelDir(), id));
  if (!fs.existsSync(root)) throw new Error(`Model directory not found: ${root}`);

  const files = listFiles(root);
  const missing = EXPECTED_CANDIDATE_FILES.filter(required => !files.includes(required));

  console.log('='.repeat(78));
  console.log(`Sealing ${id}`);
  console.log(`Directory: ${root}`);
  console.log(`Files found: ${files.length}${missing.length ? `; MISSING required: ${missing.join(', ')}` : ''}`);
  console.log('='.repeat(78));

  let onnxSha = '';
  const lines: string[] = [];
  let totalBytes = 0;
  for (const relative of files) {
    const data = fs.readFileSync(path.join(root, relative));
    const digest = sha256(data);
    totalBytes += data.length;
    if (relative === 'onnx/model_quantized.onnx') onnxSha = digest;
    lines.push(
      `    { path: '${relative}', bytes: ${data.length}, sha256: '${digest}', gitBlobSha1: '${gitBlobSha1(data)}' }`
    );
  }

  console.log('\n// ---- paste into EXPERIMENTAL_NLI_CANDIDATES ----');
  console.log(`  id: '${id}',`);
  console.log(`  revision: ${arg('revision') ? `'${arg('revision')}'` : 'null /* record the upstream commit sha */'},`);
  console.log(`  versionSeal: ${onnxSha ? `'q8@${onnxSha.slice(0, 8)}'` : 'null /* onnx/model_quantized.onnx not found */'},`);
  console.log(`  sealState: '${missing.length === 0 && onnxSha ? 'sealed' : 'unsealed'}',`);
  console.log('  files: [');
  console.log(lines.join(',\n'));
  console.log('  ],');
  console.log(`// total on-disk size: ${(totalBytes / (1024 * 1024)).toFixed(1)} MB`);

  if (missing.length > 0) {
    console.error(`\nREFUSING to declare this candidate sealed: missing ${missing.join(', ')}.`);
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
