/**
 * TRUTHLENS V2.2 — EXPERIMENTAL NLI CANDIDATE PROVISIONER (evaluation only)
 * =========================================================================
 * Provisions ONE registered experimental candidate from
 * `EXPERIMENTAL_NLI_CANDIDATES` (server/v2/ml/modelManifest.ts) into
 * `models/v2/<id>/` (override with TRUTHLENS_V2_MODEL_DIR).
 *
 * Contract:
 *   - the candidate must be REGISTERED and SEALED; an unsealed entry is
 *     refused loudly (fail closed) — bytes are never fetched "on trust";
 *   - each file is accepted only when BOTH the sealed byte size and the
 *     sealed SHA-256 match; anything else is rejected and nothing is written;
 *   - GitHub mirrors are fetched by exact git blob SHA-1 at a pinned commit
 *     (content-addressed at the source AND hash-verified locally);
 *   - already-correct local files are skipped (idempotent, offline re-runs);
 *   - this script CANNOT change the default model: it only writes files, and
 *     the default resolver reads ALL_MODEL_MANIFESTS, not this registry.
 *
 * Usage:
 *   npm run download:v2-candidate -- --model=Xenova/distilbert-base-uncased-mnli
 *   npm run download:v2-candidate -- --list
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  EXPERIMENTAL_NLI_CANDIDATES,
  ExperimentalNliCandidate,
  ModelFileSeal,
  ModelMirrorSource,
  candidateReadiness,
  findExperimentalCandidate,
  getV2ModelDir,
  verifyCandidateHashes
} from '../server/v2/ml/modelManifest';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find(value => value.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

let cachedToken: string | null | undefined;
function githubToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) { cachedToken = envToken; return cachedToken; }
  try {
    const token = execFileSync('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    cachedToken = token.length > 0 ? token : null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

async function fetchFromSource(source: ModelMirrorSource, file: ModelFileSeal): Promise<Buffer> {
  const headers: Record<string, string> = { 'User-Agent': 'truthlens-v2.2-candidate-provisioner' };
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  if (source.type === 'huggingface-resolve') {
    const url = source.urlTemplate!.replace('{file}', file.path);
    const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  }

  if (!file.gitBlobSha1) throw new Error(`no git blob SHA-1 sealed for ${file.path}; cannot fetch content-addressed`);
  const api = `https://api.github.com/repos/${source.repo}/git/blobs/${file.gitBlobSha1}`;
  const response = await fetch(api, {
    headers: { ...headers, Accept: 'application/vnd.github.raw' },
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from git blob API (${source.repo}, blob ${file.gitBlobSha1})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function provisionFile(candidate: ExperimentalNliCandidate, file: ModelFileSeal, modelDir: string): Promise<'already' | 'downloaded'> {
  const target = path.join(modelDir, candidate.id, file.path);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (existing.length === file.bytes && sha256(existing) === file.sha256) return 'already';
    console.log(`  ! existing ${file.path} does not match the seal (re-downloading)`);
  }

  let lastError = 'no sources configured';
  for (const source of candidate.sources) {
    const label = source.type === 'huggingface-resolve'
      ? `huggingface.co (${candidate.id})`
      : `github:${source.repo}@${source.commit?.slice(0, 7)}`;
    try {
      process.stdout.write(`    trying ${label} ... `);
      const data = await fetchFromSource(source, file);
      if (data.length !== file.bytes) {
        lastError = `byte size mismatch (${data.length} != sealed ${file.bytes})`;
        console.log(`REJECTED: ${lastError}`);
        continue;
      }
      const digest = sha256(data);
      if (digest !== file.sha256) {
        lastError = `sha256 mismatch (${digest} != sealed ${file.sha256})`;
        console.log(`REJECTED: ${lastError}`);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      console.log('OK (seal verified)');
      return 'downloaded';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.log(`unreachable/failed (${lastError})`);
    }
  }
  throw new Error(
    `Could not obtain ${candidate.id}:${file.path} from any pinned source. Last error: ${lastError}. ` +
    `Mirror the file whose sealed sha256 is ${file.sha256} and re-run; nothing unverified is ever accepted.`
  );
}

function printRegistry(): void {
  console.log('Registered experimental NLI candidates (evaluation only, never the default):');
  for (const candidate of EXPERIMENTAL_NLI_CANDIDATES) {
    console.log(`  - ${candidate.id}`);
    console.log(`      base       : ${candidate.baseModel}`);
    console.log(`      revision   : ${candidate.revision ?? 'UNPINNED'}`);
    console.log(`      seal state : ${candidate.sealState}${candidate.versionSeal ? ` (${candidate.versionSeal})` : ''}`);
    if (candidate.unsealedReason) console.log(`      blocker    : ${candidate.unsealedReason}`);
  }
}

export async function provisionCandidateById(id: string, modelDirOverride?: string): Promise<void> {
  const savedArgv = process.argv;
  process.argv = [savedArgv[0], savedArgv[1], `--model=${id}`, ...(modelDirOverride ? [`--model-dir=${modelDirOverride}`] : [])];
  try {
    await main();
  } finally {
    process.argv = savedArgv;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--list') || !arg('model')) {
    printRegistry();
    if (!arg('model')) {
      console.log('\nUsage: npm run download:v2-candidate -- --model=<registered-candidate-id>');
      process.exitCode = process.argv.includes('--list') ? 0 : 1;
    }
    if (!arg('model')) return;
  }

  const id = arg('model')!;
  const modelDir = path.resolve(arg('model-dir') || getV2ModelDir());
  const candidate = findExperimentalCandidate(id);
  if (!candidate) {
    printRegistry();
    throw new Error(`'${id}' is not a registered experimental candidate (see the list above).`);
  }

  console.log('='.repeat(78));
  console.log('TRUTHLENS V2.2 — EXPERIMENTAL CANDIDATE PROVISIONING (evaluation only)');
  console.log(`Candidate     : ${candidate.id}`);
  console.log(`Base model    : ${candidate.baseModel}`);
  console.log(`Revision      : ${candidate.revision ?? 'UNPINNED'}`);
  console.log(`Quantization  : ${candidate.quantization}`);
  console.log(`Seal state    : ${candidate.sealState}`);
  console.log(`Target dir    : ${path.join(modelDir, candidate.id)}`);
  console.log('This does NOT change the default V2.1 model manifest or resolver.');
  console.log('='.repeat(78));

  if (candidate.sealState !== 'sealed' || candidate.files.length === 0) {
    throw new Error(
      `FAIL CLOSED: '${candidate.id}' is registered but UNSEALED, so there is nothing trustworthy to download.\n` +
      `  reason: ${candidate.unsealedReason ?? 'no seals recorded'}\n` +
      '  -> Obtain the files in a network-enabled environment, run ' +
      '`npm run seal:v2-candidate -- --model=<id> --dir=<path>`, paste the printed seal block into ' +
      'EXPERIMENTAL_NLI_CANDIDATES, flip sealState to "sealed", and re-run this command.'
    );
  }

  let downloaded = 0;
  let already = 0;
  for (const file of candidate.files) {
    console.log(`  ${file.path} (${file.bytes} bytes)`);
    const outcome = await provisionFile(candidate, file, modelDir);
    if (outcome === 'already') { already++; console.log('    already present and sealed'); }
    else downloaded++;
  }

  const readiness = candidateReadiness(candidate.id, modelDir);
  const hashes = verifyCandidateHashes(candidate.id, modelDir);
  if (!readiness.ok || !hashes.ok) {
    throw new Error(
      'Post-provision verification FAILED (fail closed):\n' +
      [...readiness.problems, ...hashes.mismatches].map(problem => `  - ${problem}`).join('\n')
    );
  }

  console.log('-'.repeat(78));
  console.log(`Done. ${downloaded} downloaded, ${already} already sealed-and-present; all SHA-256 seals verified.`);
  console.log(`Evaluate with: npm run eval:v2-external -- --nli-model-id=${candidate.id}`);
  console.log('-'.repeat(78));
}

const invokedDirectly = process.argv[1] ? /v2DownloadCandidateModel\.ts$/.test(process.argv[1]) : false;
if (invokedDirectly) {
  main().catch(error => {
    console.error(`\nCANDIDATE PROVISIONING FAILED: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
