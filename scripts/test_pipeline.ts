/**
 * Legacy compatibility entry point.
 *
 * The original test_pipeline.ts targeted the pre-production 36-row demo
 * dataset and is no longer a source-of-truth test suite. Keeping that stale
 * logic executable caused misleading failures after the production model was
 * promoted to the real ISOT artifact.
 *
 * This path now delegates to the canonical production + V2 regression gate.
 * The canonical suites live in package.json and CI; this file remains only so
 * older local commands do not execute obsolete assumptions.
 */
import { spawnSync } from 'node:child_process';

const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(command, ['run', 'test:all-with-v2'], {
  stdio: 'inherit',
  shell: false
});

if (result.error) {
  console.error('Failed to execute the canonical TruthLens test suite:', result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
