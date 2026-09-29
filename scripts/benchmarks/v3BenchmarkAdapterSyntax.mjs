import { execFileSync } from 'node:child_process';

const nodeFiles = [
  'scripts/benchmarks/v3FeverEvaluate.ts',
  'scripts/benchmarks/v3AveritecOfficialEvaluate.mjs',
  'scripts/benchmarks/v3FeverOfficialEvaluate.mjs',
  'scripts/benchmarks/v3FeverousOfficialEvaluate.mjs',
  'scripts/researchIntelligence.mjs',
  'scripts/v3BenchmarkPreflight.mjs',
  'scripts/v3BenchmarkRunValidator.mjs'
];

const pythonFiles = [
  'scripts/benchmarks/v3FeverPrepareCandidates.py',
  'scripts/benchmarks/v3FeverousPrepareCandidates.py'
];

for (const file of nodeFiles) {
  if (!file.endsWith('.ts')) {
    execFileSync('node', ['--check', file], { stdio: 'pipe' });
    console.log('syntax ok:', file);
  }
}

console.log('TypeScript adapters are validated by the repository type-check gate.');

for (const file of pythonFiles) {
  execFileSync('python3', ['-m', 'py_compile', file], { stdio: 'pipe' });
  console.log('syntax ok:', file);
}

console.log('TruthLens V3 benchmark adapter syntax: PASS');
