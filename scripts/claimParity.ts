/**
 * Python <-> Node parity check for the dedicated LIAR claim model.
 *
 * scripts/train_liar_claim.py writes data/claim_parity_fixtures.json containing
 * the sklearn-computed calibrated probability for EVERY row of the held-out
 * LIAR TEST split. This script re-scores all of them through the production
 * Node scorer and asserts:
 *
 *   1. max |p_python - p_node|      <= 1e-9   (numerical tolerance)
 *   2. label flips at the operating threshold == 0
 *   3. the Node accuracy/macro-F1 reproduce the artifact's reported metrics
 *
 * Any drift between server/claimModel.ts and scripts/liar_common.py fails here.
 */
import fs from 'fs';
import path from 'path';
import { ClaimModel } from '../server/claimModel';

const TOLERANCE = 1e-9;

interface Fixture {
  model_version: string;
  variant: 'text_only';
  threshold: number;
  rows: Array<{ id: string; statement: string; y: number; python_probability: number }>;
  meta_rows: Array<{
    id: string; statement: string; y: number; python_probability: number;
    metadata: { speaker: string; party: string; credit_history: Record<string, number> };
  }>;
}

function main(): void {
  const fixturePath = path.join(process.cwd(), 'data', 'claim_parity_fixtures.json');
  if (!fs.existsSync(fixturePath)) {
    console.error(`[claim-parity] FAIL missing ${fixturePath}. Run: python scripts/train_liar_claim.py`);
    process.exit(1);
  }
  const fx: Fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const model = new ClaimModel();
  if (!model.isReady()) {
    console.error(`[claim-parity] FAIL claim model artifact not loadable: ${model.getLoadError()}`);
    process.exit(1);
  }
  const artifact = model.getArtifact();
  if (artifact.model_version !== fx.model_version) {
    console.error(`[claim-parity] FAIL version mismatch artifact=${artifact.model_version} fixtures=${fx.model_version}`);
    process.exit(1);
  }

  let maxDiff = 0;
  let worst = '';
  let flips = 0;
  let correct = 0;
  const conf = [[0, 0], [0, 0]];

  for (const row of fx.rows) {
    const pNode = model.probabilityTrue(fx.variant, row.statement);
    const diff = Math.abs(pNode - row.python_probability);
    if (diff > maxDiff) { maxDiff = diff; worst = row.id; }
    const labelPy = row.python_probability >= fx.threshold ? 1 : 0;
    const labelNode = pNode >= fx.threshold ? 1 : 0;
    if (labelPy !== labelNode) flips++;
    if (labelNode === row.y) correct++;
    conf[row.y][labelNode]++;
  }

  const n = fx.rows.length;
  const accuracy = correct / n;
  const f1 = (cls: number) => {
    const tp = conf[cls][cls];
    const fp = conf[1 - cls][cls];
    const fn = conf[cls][1 - cls];
    const prec = tp + fp === 0 ? 0 : tp / (tp + fp);
    const rec = tp + fn === 0 ? 0 : tp / (tp + fn);
    return prec + rec === 0 ? 0 : (2 * prec * rec) / (prec + rec);
  };
  const macroF1 = (f1(0) + f1(1)) / 2;

  const reported = artifact.variants[fx.variant].metrics.test;
  const accDrift = Math.abs(accuracy - reported.accuracy);
  const f1Drift = Math.abs(macroF1 - reported.macro_f1);

  console.log('='.repeat(72));
  console.log('CLAIM MODEL PYTHON <-> NODE PARITY');
  console.log('='.repeat(72));
  console.log(`  model version        : ${artifact.model_version}`);
  console.log(`  variant              : ${fx.variant}`);
  console.log(`  rows compared        : ${n} / ${n}`);
  console.log(`  max |p_py - p_node|  : ${maxDiff.toExponential(3)} (tolerance ${TOLERANCE.toExponential(0)}, worst row ${worst})`);
  console.log(`  label flips @ ${fx.threshold}   : ${flips}`);
  console.log(`  node TEST accuracy   : ${accuracy.toFixed(6)} (artifact ${reported.accuracy.toFixed(6)}, drift ${accDrift.toExponential(2)})`);
  console.log(`  node TEST macro-F1   : ${macroF1.toFixed(6)} (artifact ${reported.macro_f1.toFixed(6)}, drift ${f1Drift.toExponential(2)})`);

  // ---- text_meta variant --------------------------------------------------
  let metaMaxDiff = 0;
  let metaFlips = 0;
  let metaWorst = '';
  const metaRows = fx.meta_rows || [];
  for (const row of metaRows) {
    const pNode = model.probabilityTrue('text_meta', row.statement, row.metadata as any);
    const diff = Math.abs(pNode - row.python_probability);
    if (diff > metaMaxDiff) { metaMaxDiff = diff; metaWorst = row.id; }
    const lp = row.python_probability >= fx.threshold ? 1 : 0;
    const ln = pNode >= fx.threshold ? 1 : 0;
    if (lp !== ln) metaFlips++;
  }
  console.log(`  text_meta rows       : ${metaRows.length} / ${metaRows.length}`);
  console.log(`  text_meta max drift  : ${metaMaxDiff.toExponential(3)} (worst row ${metaWorst || 'n/a'})`);
  console.log(`  text_meta label flips: ${metaFlips}`);

  const failures: string[] = [];
  if (metaRows.length === 0) failures.push('fixtures contain no text_meta rows');
  if (metaMaxDiff > TOLERANCE) failures.push(`text_meta probability drift ${metaMaxDiff} exceeds ${TOLERANCE}`);
  if (metaFlips !== 0) failures.push(`${metaFlips} text_meta label flips`);
  if (maxDiff > TOLERANCE) failures.push(`probability drift ${maxDiff} exceeds ${TOLERANCE}`);
  if (flips !== 0) failures.push(`${flips} label flips at the operating threshold`);
  if (accDrift > 1e-9) failures.push(`accuracy drift ${accDrift}`);
  if (f1Drift > 1e-9) failures.push(`macro-F1 drift ${f1Drift}`);

  if (failures.length) {
    console.log('-'.repeat(72));
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('-'.repeat(72));
  console.log('  PASS sklearn oracle parity verified to numerical tolerance');
  console.log('='.repeat(72));
}

main();
