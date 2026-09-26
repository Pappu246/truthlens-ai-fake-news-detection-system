/**
 * Provisions the sealed comparison-only DistilBERT MNLI model used by the
 * external report. It is intentionally NOT added to ALL_MODEL_MANIFESTS and
 * can never become the default adapter through this script.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { getV2ModelDir } from '../server/v2/ml/modelManifest';

const MODEL_ID = 'Xenova/distilbert-base-uncased-mnli';
const MIRROR_REPO = 'ramcsamal/MLNodeJSParser';
const MIRROR_COMMIT = 'b8f11993a2bcb4412fe7328a613e0ddb3c12f214';
const FILES = [
  { path: 'config.json', bytes: 753, sha256: '7d897374b56613fb8579c623dd89bbc01ab9795612b3d1d546cd5658232a5c7a', blob: '8c9d46fe6cf23ab39dd6fbad2e4d0640397c4faa' },
  { path: 'onnx/model_quantized.onnx', bytes: 67581975, sha256: '5b7e374d8d1e44149fafa498efe80166f740914b3e53bcfa6115fb3ecaca0945', blob: '63946d67f70fe7c975b801ee5d5e23cd27492db6' },
  { path: 'tokenizer.json', bytes: 711396, sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66', blob: '688882a79f44442ddc1f60d70334a7ff5df0fb47' },
  { path: 'tokenizer_config.json', bytes: 372, sha256: '2bbf2ea55c232406706144b907ca020cd7528a78e3e4741115be3b3566542b0b', blob: '1ccca247a6bf76cfc977ce13c570f541c984ca94' }
] as const;

function hash(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function ghBlob(blob: string): Buffer {
  const endpoint = `repos/${MIRROR_REPO}/git/blobs/${blob}`;
  const encoded = execFileSync('gh', ['api', endpoint, '--jq', '.content'], {
    encoding: 'utf8',
    maxBuffer: 160 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit']
  });
  return Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
}

async function fetchBlob(blob: string): Promise<Buffer> {
  const endpoint = `https://api.github.com/repos/${MIRROR_REPO}/git/blobs/${blob}`;
  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'truthlens-v2-external-model-provisioner',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      },
      signal: AbortSignal.timeout(180_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    try {
      return ghBlob(blob);
    } catch {
      throw new Error(
        `Could not fetch GitHub blob ${blob} with fetch or authenticated gh CLI: ` +
        (error instanceof Error ? error.message : String(error))
      );
    }
  }
}

async function main(): Promise<void> {
  const root = path.join(getV2ModelDir(), MODEL_ID);
  console.log(`Comparison-only model: ${MODEL_ID}`);
  console.log(`Pinned mirror: ${MIRROR_REPO}@${MIRROR_COMMIT}`);
  console.log('This does not change the default V2.1 model manifest or resolver.');
  for (const file of FILES) {
    const target = path.join(root, file.path);
    if (fs.existsSync(target)) {
      const data = fs.readFileSync(target);
      if (data.length === file.bytes && hash(data) === file.sha256) {
        console.log(`  OK ${file.path} (already sealed)`);
        continue;
      }
    }
    const data = await fetchBlob(file.blob);
    if (data.length !== file.bytes || hash(data) !== file.sha256) {
      throw new Error(`${file.path}: downloaded bytes did not match frozen size/SHA-256; rejected.`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    console.log(`  OK ${file.path} (downloaded and sealed)`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
