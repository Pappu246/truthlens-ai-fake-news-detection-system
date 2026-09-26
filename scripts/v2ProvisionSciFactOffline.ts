/**
 * Install the exact frozen SciFact inputs from an externally supplied bundle.
 * This is intentionally offline: it never fetches, regenerates, or edits data.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const manifestPath = path.join(process.cwd(), 'data', 'v2', 'scifact_bundle_manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
  bundle_version: string;
  dataset: string;
  split: string;
  files: Array<{ path: string; sha256: string }>;
};
const targetDir = path.join(process.cwd(), 'data', 'external', 'scifact');

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}
function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function sourceFile(root: string, relative: string): string {
  const direct = path.join(root, relative);
  if (fs.existsSync(direct)) return direct;
  // Accept a directory containing the exact named files, not an archive or a
  // guessed alternative. Keep the import contract simple and auditable.
  return path.join(root, path.basename(relative));
}

function main(): void {
  const sourceArg = arg('source');
  if (!sourceArg) throw new Error('Usage: npm run external:v2-data:offline -- --source=/path/to/exact/scifact/files');
  const source = path.resolve(sourceArg);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`Source must be an existing directory containing the exact files listed in ${manifestPath}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  console.log(`Installing ${manifest.dataset} ${manifest.split} bundle ${manifest.bundle_version}`);

  for (const entry of manifest.files) {
    const input = sourceFile(source, entry.path);
    if (!fs.existsSync(input) || !fs.statSync(input).isFile()) {
      throw new Error(`Missing required bundle file: ${entry.path}`);
    }
    const digest = sha256(input);
    if (digest !== entry.sha256) {
      throw new Error(`SHA-256 mismatch for ${entry.path}: got ${digest}, expected ${entry.sha256}; refusing import`);
    }
    const output = path.join(targetDir, entry.path);
    if (fs.existsSync(output)) {
      const existing = sha256(output);
      if (existing !== entry.sha256) {
        throw new Error(`Refusing to overwrite recognized path ${output}: existing SHA-256=${existing}`);
      }
      console.log(`  already installed and verified: ${entry.path}`);
      continue;
    }
    fs.copyFileSync(input, output);
    console.log(`  installed and verified: ${entry.path} (${fs.statSync(output).size} bytes)`);
  }
  console.log('SciFact bundle installed. Evaluation may now use --data-dir=data/external/scifact.');
}

try { main(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
