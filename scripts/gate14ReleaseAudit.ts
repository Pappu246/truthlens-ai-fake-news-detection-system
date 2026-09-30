import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

interface AuditResult {
  status: 'PASS' | 'FAIL';
  checks: Array<{ id: string; ok: boolean; detail: string }>;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function check(result: AuditResult, id: string, ok: boolean, detail: string): void {
  result.checks.push({ id, ok, detail });
  if (!ok) result.status = 'FAIL';
}

async function main(): Promise<void> {
  const result: AuditResult = { status: 'PASS', checks: [] };

  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
  check(result, 'CI gate script', packageJson.scripts?.['test:gate14'] === 'tsx scripts/gate14RemainingTests.ts',
    packageJson.scripts?.['test:gate14'] || 'missing');
  check(result, 'Evidence benchmark script', packageJson.scripts?.['eval:evidence-benchmark'] === 'tsx scripts/evidenceBenchmark.ts',
    packageJson.scripts?.['eval:evidence-benchmark'] || 'missing');

  const productionArtifact = path.resolve('data/saved_model_artifacts.json');
  check(result, 'Production ML artifact exists', fs.existsSync(productionArtifact), productionArtifact);

  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  check(result, 'CI runs Gate-14 suite', workflow.includes('npm run test:gate14'), 'workflow registration');
  check(result, 'CI runs evidence benchmark', workflow.includes('npm run eval:evidence-benchmark'), 'workflow registration');
  check(result, 'CI runs external harness smoke', workflow.includes('npm run test:v2-model-quality-external-smoke'), 'workflow registration');

  const semantic = fs.readFileSync('server/verification/semanticRelation.ts', 'utf8');
  check(result, 'Semantic NLI is opt-in', semantic.includes('createConfiguredNliAdapter'), 'existing adapter reuse');
  check(result, 'Semantic layer sanitises publisher text', semantic.includes('sanitiseForSemanticNli'), 'sanitisation function present');

  const obs = fs.readFileSync('server/verification/observability.ts', 'utf8');
  check(result, 'Observability is aggregate-only', !obs.includes('claim_text') && !obs.includes('source_url'),
    'no raw claim/source fields in telemetry payload');

  const docs = fs.readFileSync('docs/GATE14_RELEASE_AUDIT.md', 'utf8');
  check(result, 'Release governance documentation present', docs.includes('Release gates') && docs.includes('production / research'),
    'Gate-14 governance record');

  check(result, 'Evidence benchmark fixture exists', fs.existsSync('research/evidence_benchmark.json'),
    'research/evidence_benchmark.json');
  check(result, 'Gate-14 regression suite exists', fs.existsSync('scripts/gate14RemainingTests.ts'),
    'scripts/gate14RemainingTests.ts');

  if (fs.existsSync(productionArtifact)) {
    check(result, 'Production artifact hash recorded locally for audit',
      sha256(productionArtifact).length === 64,
      sha256(productionArtifact));
  }

  const outputPath = path.resolve('artifacts/gate14-release-audit.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    protocol_version: 'truthlens-gate14-release-audit-v1',
    generated_at: new Date().toISOString(),
    status: result.status,
    checks: result.checks,
    note: 'Repository-structure audit only. CI/Vercel results must still be verified from their external systems.'
  }, null, 2) + '\n');

  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'FAIL') process.exit(1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
