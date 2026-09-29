/**
 * TRUTHLENS V2.1 — SEALED MODEL DOWNLOADER
 * ==========================================
 * Provisions the real pretrained model files required by the V2.1 pretrained
 * adapters (Xenova/all-MiniLM-L6-v2 embeddings, Xenova/nli-deberta-v3-xsmall
 * NLI) into `models/v2/` (override with TRUTHLENS_V2_MODEL_DIR).
 *
 * REPRODUCIBILITY CONTRACT:
 *  - sources are tried in the order declared in server/v2/ml/modelManifest.ts
 *    (canonical Hugging Face first, then pinned GitHub git-blob mirrors);
 *  - a file is only ACCEPTED when it matches BOTH the sealed byte size and
 *    the sealed SHA-256 recorded in the manifest — anything else is rejected
 *    loudly (never silently used);
 *  - for GitHub mirrors we fetch by exact git blob SHA-1 at a pinned commit,
 *    so the bytes are content-addressed at the source AND hash-verified here;
 *  - already-correct local files are skipped (idempotent, offline re-runs).
 *
 * Total download: ~110 MB (two int8-quantized ONNX models + tokenizers).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  ALL_MODEL_MANIFESTS,
  MIRROR_SOURCES,
  ModelFileSeal,
  ModelManifestEntry,
  ModelMirrorSource,
  getV2ModelDir,
  modelRoot
} from '../server/v2/ml/modelManifest';

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let cachedToken: string | null | undefined;

/** GitHub token for the blob API: env first, then an installed `gh` CLI best-effort. */
function githubToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) { cachedToken = envToken; return cachedToken; }
  try {
    const t = execFileSync('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    cachedToken = t.length > 0 ? t : null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

async function fetchFromSource(source: ModelMirrorSource, file: ModelFileSeal): Promise<Buffer> {
  const headers: Record<string, string> = { 'User-Agent': 'truthlens-v2.1-model-downloader' };
  const token = githubToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  if (source.type === 'huggingface-resolve') {
    const url = source.urlTemplate!.replace('{file}', file.path);
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // github-git-blob: fetch the exact blob by its SHA-1 (content-addressed).
  const api = `https://api.github.com/repos/${source.repo}/git/blobs/${file.gitBlobSha1}`;
  const res = await fetch(api, {
    headers: { ...headers, Accept: 'application/vnd.github.raw' },
    signal: AbortSignal.timeout(180_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from git blob API for ${source.repo} (blob ${file.gitBlobSha1})`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadFile(manifest: ModelManifestEntry, file: ModelFileSeal, modelDir: string): Promise<'already' | 'downloaded'> {
  const root = modelRoot(modelDir, manifest);
  const target = path.join(root, file.path);

  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (existing.length === file.bytes && sha256(existing) === file.sha256) return 'already';
    console.log(`  ! existing ${file.path} does not match the seal (re-downloading)`);
  }

  const sources = MIRROR_SOURCES[manifest.id] || [];
  let lastErr: string = 'no sources configured';
  for (const source of sources) {
    const label = source.type === 'huggingface-resolve'
      ? `huggingface.co (${manifest.id})`
      : `github:${source.repo}@${source.commit?.slice(0, 7)}`;
    try {
      process.stdout.write(`    trying ${label} ... `);
      const buf = await fetchFromSource(source, file);
      if (buf.length !== file.bytes) {
        lastErr = `byte size mismatch (${buf.length} != sealed ${file.bytes})`;
        console.log(`REJECTED: ${lastErr}`);
        continue;
      }
      const digest = sha256(buf);
      if (digest !== file.sha256) {
        lastErr = `sha256 mismatch (${digest} != sealed ${file.sha256})`;
        console.log(`REJECTED: ${lastErr}`);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      console.log('OK (seal verified)');
      return 'downloaded';
    } catch (err: any) {
      lastErr = err?.message || String(err);
      console.log(`unreachable/failed (${lastErr})`);
    }
  }
  throw new Error(
    `Could not obtain ${manifest.id}:${file.path} from any source. Last error: ${lastErr}. ` +
    `If your network blocks public model hosts, mirror the file whose sealed sha256 is ${file.sha256} and re-run.`
  );
}

async function main() {
  const modelDir = getV2ModelDir();
  console.log('='.repeat(78));
  console.log('TRUTHLENS V2.1 — SEALED MODEL DOWNLOAD');
  console.log(`Target directory: ${modelDir}`);
  console.log('Every file is accepted only if it matches the sealed size + SHA-256 in server/v2/ml/modelManifest.ts');
  console.log('='.repeat(78));

  let downloaded = 0;
  let already = 0;
  for (const manifest of ALL_MODEL_MANIFESTS) {
    console.log(`\n${manifest.id}  (base: ${manifest.baseModel}, ${manifest.quantization}, seal ${manifest.versionSeal})`);
    for (const file of manifest.files) {
      const outcome = await downloadFile(manifest, file, modelDir);
      if (outcome === 'already') already++;
      else downloaded++;
    }
  }

  console.log('\n' + '-'.repeat(78));
  console.log(`Done. ${downloaded} downloaded, ${already} already sealed-and-present.`);
  console.log('Next: `npm run test:v2-models` validates the pretrained adapters against this local copy.');
  console.log('-'.repeat(78));
}

main().then(
  () => process.exit(0),
  err => { console.error(`\nDOWNLOAD FAILED: ${err.message}`); process.exit(1); }
);
