import fs from 'fs';
import path from 'path';
import { classifyEvidenceRelation } from '../server/verification/evidenceAnalyzer';
import { ExtractedClaim } from '../src/types';

type NumericalConsistency = { isConsistent: boolean; claimNumbers: string[]; evidenceNumbers: string[]; warning?: string };

type Gold = 'SUPPORT' | 'CONTRADICT' | 'UNCLEAR';

interface Fixture {
  id: string;
  claim: string;
  evidence: string;
  gold: Gold;
  score: number;
  claimNumbers?: string[];
  evidenceNumbers?: string[];
}

function metric(predictions: Gold[], gold: Gold[], label: Gold) {
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < gold.length; i++) {
    if (predictions[i] === label && gold[i] === label) tp++;
    if (predictions[i] === label && gold[i] !== label) fp++;
    if (predictions[i] !== label && gold[i] === label) fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, support: tp + fn };
}

function buildClaim(text: string, numbers: string[] = []): ExtractedClaim {
  const words = text.toLowerCase().replace(/[^a-z0-9%]+/g, ' ')
    .split(/\s+/).filter(word => word.length > 3);
  return {
    claimId: 'benchmark',
    originalText: text,
    normalizedText: text,
    claimType: 'Other',
    importance: 'HIGH',
    entities: [],
    dates: [],
    locations: [],
    numbers,
    keywords: Array.from(new Set(words)).slice(0, 8),
    searchQueries: [text]
  };
}

function numerical(claimNumbers: string[], evidenceNumbers: string[]): NumericalConsistency {
  const normalize = (values: string[]) => values.map(v => v.toLowerCase().replace(/[^0-9.%-]/g, '')).filter(Boolean);
  const a = normalize(claimNumbers);
  const b = normalize(evidenceNumbers);
  const isConsistent = a.length === b.length && a.every((v, i) => v === b[i]);
  return {
    claimNumbers: claimNumbers,
    evidenceNumbers: evidenceNumbers,
    isConsistent,
    warning: isConsistent ? undefined : 'Benchmark numeric mismatch'
  };
}

function mapRelation(relation: string): Gold {
  if (relation === 'SUPPORTS') return 'SUPPORT';
  if (relation === 'CONTRADICTS') return 'CONTRADICT';
  return 'UNCLEAR';
}

async function main(): Promise<void> {
  const file = path.resolve('research/evidence_benchmark.json');
  const fixtures = JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture[];
  if (fixtures.length < 20) throw new Error('Evidence benchmark fixture set is unexpectedly small.');

  const predictions: Gold[] = [];
  const gold: Gold[] = [];
  const rows: Array<Record<string, unknown>> = [];

  for (const fixture of fixtures) {
    const claim = buildClaim(fixture.claim, fixture.claimNumbers || []);
    const consistency = numerical(fixture.claimNumbers || [], fixture.evidenceNumbers || []);
    const relation = classifyEvidenceRelation(claim, fixture.evidence, fixture.score, consistency);
    const prediction = mapRelation(relation);
    predictions.push(prediction);
    gold.push(fixture.gold);
    rows.push({ ...fixture, predicted: prediction, raw_relation: relation });
  }

  const labels: Gold[] = ['SUPPORT', 'CONTRADICT', 'UNCLEAR'];
  const perClass = Object.fromEntries(labels.map(label => [label, metric(predictions, gold, label)]));
  const accuracy = predictions.length
    ? predictions.reduce((sum, prediction, i) => sum + Number(prediction === gold[i]), 0) / predictions.length
    : 0;
  const macroF1 = labels.reduce((sum, label) => sum + perClass[label].f1, 0) / labels.length;
  const coverage = predictions.filter((_, i) => rows[i].raw_relation === 'SUPPORTS' || rows[i].raw_relation === 'CONTRADICTS').length / predictions.length;
  const abstention = 1 - coverage;

  const confusion: Record<Gold, Record<Gold, number>> = {
    SUPPORT: { SUPPORT: 0, CONTRADICT: 0, UNCLEAR: 0 },
    CONTRADICT: { SUPPORT: 0, CONTRADICT: 0, UNCLEAR: 0 },
    UNCLEAR: { SUPPORT: 0, CONTRADICT: 0, UNCLEAR: 0 }
  };
  for (let i = 0; i < gold.length; i++) confusion[gold[i]][predictions[i]]++;

  const output = {
    protocol_version: 'truthlens-evidence-relation-benchmark-v1',
    generated_at: new Date().toISOString(),
    benchmark: 'Evidence-specific relation classifier; not production article-model accuracy.',
    dataset: {
      name: 'TruthLens Gate-14 frozen relation fixtures',
      samples: fixtures.length,
      labels
    },
    metrics: {
      accuracy,
      macro_f1: macroF1,
      precision: Object.fromEntries(labels.map(label => [label, perClass[label].precision])),
      recall: Object.fromEntries(labels.map(label => [label, perClass[label].recall])),
      f1: Object.fromEntries(labels.map(label => [label, perClass[label].f1])),
      per_class: perClass
    },
    confusion_matrix: confusion,
    coverage,
    abstention_rate: abstention,
    interpretation: [
      'SUPPORT and CONTRADICT are non-abstaining directional relation outputs.',
      'UNCLEAR covers MIXED, IRRELEVANT, and INSUFFICIENT relation outcomes.',
      'Coverage and abstention are reported because evidence verification is designed to withhold directional conclusions when relation confidence is inadequate.',
      'These fixtures are deterministic development evidence tests, not a representative internet-wide truth benchmark.'
    ],
    rows
  };

  const outPath = path.resolve('artifacts/evidence-benchmark/report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
