import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

type Asset = { name: string; url: string; kind: 'jsonl' | 'zip' | 'json'; expectedSha256?: string | null };
type BenchmarkAssets = Record<string, Asset[]>;

const ASSETS: BenchmarkAssets = {
  fever_v1: [
    { name: 'train.jsonl', url: 'https://fever.ai/download/fever/train.jsonl', kind: 'jsonl' },
    { name: 'shared_task_dev.jsonl', url: 'https://fever.ai/download/fever/shared_task_dev.jsonl', kind: 'jsonl' },
    { name: 'wiki-pages.zip', url: 'https://fever.ai/download/fever/wiki-pages.zip', kind: 'zip' }
  ],
  feverous: [
    { name: 'feverous_train_challenges.jsonl', url: 'https://fever.ai/download/feverous/feverous_train_challenges.jsonl', kind: 'jsonl' },
    { name: 'feverous_dev_challenges.jsonl', url: 'https://fever.ai/download/feverous/feverous_dev_challenges.jsonl', kind: 'jsonl' },
    { name: 'feverous-wiki-pages-db.zip', url: 'https://fever.ai/download/feverous/feverous-wiki-pages-db.zip', kind: 'zip' }
  ],
  averitec: [
    { name: 'train.json', url: 'https://raw.githubusercontent.com/MichSchli/AVeriTeC/main/data/train.json', kind: 'json' },
    { name: 'dev.json', url: 'https://raw.githubusercontent.com/MichSchli/AVeriTeC/main/data/dev.json', kind: 'json' }
  ]
};

async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  const { size } = await stat(file);
  return { sha256: hash.digest('hex'), bytes: size };
}

async function download(url: string, out: string): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  await exec('curl', ['-L', '--fail', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', '--max-time', '1800', '-o', out, url], { maxBuffer: 1024 * 1024 });
}

async function lineCount(file: string): Promise<number | null> {
  try {
    const text = await readFile(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).length;
  } catch { return null; }
}

async function main(): Promise<void> {
  const root = join(process.cwd(), 'artifacts', 'phase2', 'raw');
  const manifest: Record<string, unknown> = { generated_at: new Date().toISOString(), assets: {} };

  for (const [benchmark, assets] of Object.entries(ASSETS)) {
    const rows: unknown[] = [];
    for (const asset of assets) {
      const out = join(root, benchmark, asset.name);
      await download(asset.url, out);
      const { sha256, bytes } = await hashFile(out);
      const count = asset.kind === 'jsonl' ? await lineCount(out) : null;
      rows.push({ name: asset.name, url: asset.url, bytes, sha256, jsonl_rows: count });
      console.log(JSON.stringify({ benchmark, asset: asset.name, bytes, sha256, jsonl_rows: count }));
    }
    (manifest.assets as Record<string, unknown>)[benchmark] = rows;
  }

  await writeFile(join(root, 'materialization-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(join(root, 'materialization-manifest.json'));
}

main().catch((error) => { console.error(error); process.exit(1); });
