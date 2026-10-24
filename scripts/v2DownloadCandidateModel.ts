#!/usr/bin/env node
/**
 * Download a sealed experimental NLI candidate without adding it to the
 * production/default model manifest. Every file must match its byte-size and
 * SHA-256 seal. Unsealed candidates fail closed before any network request.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXPECTED_CANDIDATE_FILES,
  ExperimentalNliCandidate,
  ModelFileSeal,
  ModelMirrorSource,
  assertCandidateUsable,
  candidateReadiness,
  findExperimentalCandidate,
  getV2ModelDir,
  verifyCandidateHashes
} from '../server/v2/ml/modelManifest.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function githubToken(): string | null {
  const value = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return value && value.trim() ? value.trim() : null;
}

async function fetchFromSource(source: ModelMirrorSource, file: ModelFileSeal): Promise<Buffer> {
  const headers: Record<string, string> = { 'User-Agent': 'truthlens-sealed-candidate-downloader' };
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let url: string;
  if (source.type === 'huggingface-resolve') {
    if (!source.urlTemplate) throw new Error('Hugging Face source is missing urlTemplate.');
    url = source.urlTemplate.replace('{file}', file.path);
  } else {
    if (!source.repo || !source.commit || !file.gitBlobSha1) {
      throw new Error('GitHub blob source requires a pinned repository, commit, and per-file gitBlobSha1.');
    }
    // The blob is content-addressed. The downloaded bytes are additionally
    // verified against the independently recorded SHA-256 and byte-size seal.
    url = `https://api.github.com/repos/${source.repo}/git/blobs/${file.gitBlobSha1}`;
    headers.Accept = 'application/vnd.github.raw';
  }

  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} from ${source.type} source.`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadFile(candidate: ExperimentalNliCandidate, file: ModelFileSeal, modelDir: string): Promise<'already' | 'downloaded'> {
  const root = path.join(modelDir, candidate.id);
  const target = path.join(root, file.path);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (existing.length === file.bytes && sha256(existing) === file.sha256) {
      console.log(`  already sealed: ${file.path}`);
      return 'already';
    }
    console.log(`  existing file failed seal; re-downloading: ${file.path}`);
  }

  const failures: string[] = [];
  for (const source of candidate.sources) {
    const label = source.repo ? `github:${source.repo}@${source.commit?.slice(0, 7)}` : source.urlTemplate;
    try {
      process.stdout.write(`  fetching ${file.path} from ${label} ... `);
      const bytes = await fetchFromSource(source, file);
      if (bytes.length !== file.bytes) {
        failures.push(`${label}: byte size ${bytes.length} != sealed ${file.bytes}`);
        console.log('REJECTED (size mismatch)');
        continue;
      }
      const digest = sha256(bytes);
      if (digest !== file.sha256) {
        failures.push(`${label}: SHA-256 ${digest} != sealed ${file.sha256}`);
        console.log('REJECTED (SHA-256 mismatch)');
        continue;
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tempPath = `${target}.download-${process.pid}.tmp`;
      fs.writeFileSync(tempPath, bytes, { flag: 'wx' });
      fs.renameSync(tempPath, target);
      console.log('OK (size + SHA-256 verified)');
      return 'downloaded';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${label}: ${message}`);
      console.log(`unavailable/failed (${message})`);
    }
  }
  throw new Error(
    `Could not obtain sealed candidate file ${candidate.id}:${file.path}. ` +
    failures.join(' | ')
  );
}

async function main(): Promise<void> {
  const modelId = arg('model');
  if (!modelId) throw new Error('Pass --model=<registered-candidate-id>.');
  const candidate = findExperimentalCandidate(modelId);
  if (!candidate) {
    throw new Error(`Unknown candidate '${modelId}'. Registered candidates must be explicitly sealed in modelManifest.ts.`);
  }
  if (candidate.sealState !== 'sealed' || candidate.files.length === 0) {
    const ready = candidateReadiness(modelId);
    throw new Error(
      `Refusing to download unsealed candidate '${modelId}': ${ready.problems.join(' ')}`
    );
  }
  const sealedPaths = new Set(candidate.files.map(file => file.path));
  const missingRequired = EXPECTED_CANDIDATE_FILES.filter(file => !sealedPaths.has(file));
  if (missingRequired.length) {
    throw new Error(`Candidate seal is incomplete; missing file seals: ${missingRequired.join(', ')}`);
  }

  const modelDir = getV2ModelDir();
  console.log(`Sealed NLI candidate: ${candidate.id}`);
  console.log(`Version seal: ${candidate.versionSeal}`);
  console.log(`Target directory: ${path.join(modelDir, candidate.id)}`);

  let downloaded = 0;
  let already = 0;
  for (const file of candidate.files) {
    const result = await downloadFile(candidate, file, modelDir);
    if (result === 'downloaded') downloaded++;
    else already++;
  }

  // The existing helper is the single fail-closed readiness policy.
  assertCandidateUsable(modelId, modelDir);
  const verified = verifyCandidateHashes(modelId, modelDir);
  if (!verified.ok) throw new Error(`Candidate hash verification failed: ${verified.mismatches.join('; ')}`);

  console.log(`Candidate files verified: ${downloaded} downloaded, ${already} already present; all SHA-256 seals match.`);
}

main().then(
  () => process.exit(0),
  error => {
    console.error(`\nCANDIDATE DOWNLOAD FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exit(1);
  }
);
