/**
 * Research-only synthetic adversarial evidence contamination diagnostic.
 * This is not a human-labelled benchmark or model-accuracy result.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyClaimV2 } from '../server/v2/pipeline.js';
import { FixtureCorpusSource } from '../server/v2/retrieval/corpusSource.js';
import { HashingNgramEmbeddingModel } from '../server/v2/retrieval/embeddings.js';
import { hybridRetrieve } from '../server/v2/retrieval/hybridRetriever.js';
import { rerankEvidence } from '../server/v2/rerank/reranker.js';
import { expandQueries, buildClaim } from '../server/v2/queryExpansion.js';
import { defaultNliAdapter } from '../server/v2/nli/heuristicNliAdapter.js';
import { RawDocument, VerdictV2 } from '../server/v2/types.js';

const CLAIM = 'Rivergate City Council approved the Eastbank bridge project on 12 March 2024.';
const CLAIM_CUTOFF = '2024-03-12T23:59:59Z';
const PUBLISHED_AT = '2024-03-12T08:00:00Z';
const SEEDS = [11, 23, 37, 41, 59];
const CONTAMINATION_COUNTS = [4, 5, 8];
const GOLD_IDS = ['gold-01', 'gold-02', 'gold-03', 'gold-04'];
const embeddingModel = new HashingNgramEmbeddingModel({ dimensions: 256, nGramSizes: [3, 4] });

type RankMetrics = {
  candidate_count: number;
  attack_in_top5: number;
  attack_in_top10: number;
  attack_share_top5: number;
  attack_share_top10: number;
  gold_evidence_recall_at5: number;
  gold_evidence_recall_at10: number;
  top5_ids: string[];
  top10_ids: string[];
};

type ScenarioResult = {
  scenario_id: string;
  seed: number | null;
  injected_attack_count: number;
  contamination_rate_percent: number;
  ranking: { retrieval: RankMetrics; reranked: RankMetrics };
  verification: {
    verdict: VerdictV2;
    confidence: number;
    abstained: boolean;
    nli_model: string;
    nli_version: string;
    evidence_count: number;
    injected_evidence_count: number;
    supporting_evidence_count: number;
    refuting_evidence_count: number;
    neutral_or_unclear_evidence_count: number;
    temporal_candidates_excluded: number;
    source_domains_used: number;
  };
  verdict_flip_vs_clean: boolean | null;
};

function doc(
  id: string,
  url: string,
  publisher: string,
  title: string,
  snippet: string
): RawDocument {
  return {
    id, url, publisher, title, snippet, contentType: 'SUMMARY',
    publishedAt: PUBLISHED_AT,
    retrievedAt: '2024-03-12T12:00:00Z',
    retrievalMethod: 'synthetic_adversarial_contamination_fixture'
  };
}

function buildCleanCorpus(): RawDocument[] {
  const gold: RawDocument[] = [
    doc('gold-01', 'https://city-council.example/records/2024-03-12', 'Rivergate City Council',
      'Council meeting minutes', 'Official meeting minutes confirm Rivergate City Council approved the Eastbank bridge project on 12 March 2024.'),
    doc('gold-02', 'https://rivergate-ledger.example/council/bridge-vote', 'Rivergate Ledger',
      'Eastbank bridge vote', 'The Eastbank bridge project approval was confirmed in Rivergate council records from 12 March 2024.'),
    doc('gold-03', 'https://regional-infrastructure.example/rivergate/eastbank', 'Regional Infrastructure Review',
      'Eastbank project decision', 'A review of the published meeting record confirms the council approved the Eastbank bridge project on 12 March 2024.'),
    doc('gold-04', 'https://public-records.example/rivergate/bridge-resolution', 'Public Records Desk',
      'Bridge resolution record', 'The Rivergate City Council resolution confirms approval of the Eastbank bridge project at its 12 March 2024 meeting.')
  ];
  const topics = [
    'Eastbank bridge inspection programme', 'Westbank bridge design review',
    'Rivergate pedestrian safety budget', 'Eastbank traffic-light maintenance',
    'Rivergate riverbank flood assessment', 'Westbank crossing feasibility study',
    'Eastbank road resurfacing contract', 'Rivergate transport committee agenda',
    'bridge maintenance procurement notice', 'council capital-works progress report',
    'Eastbank accessibility consultation', 'Rivergate engineering survey'
  ];
  const actions = [
    'was discussed', 'received a technical review', 'was added to the agenda',
    'entered a procurement phase', 'received a budget estimate', 'was sent for consultation',
    'was reviewed by staff', 'was listed in a progress update'
  ];
  const noise: RawDocument[] = [];
  for (let i = 0; i < 96; i++) {
    const number = String(i + 1).padStart(3, '0');
    const snippet = 'Rivergate City Council records show the ' + topics[i % topics.length] + ' ' +
      actions[Math.floor(i / topics.length) % actions.length] +
      ' during the March 2024 meeting cycle. This record does not state that the Eastbank bridge project received final approval on 12 March 2024. Reference ' + number + '.';
    noise.push(doc(
      'noise-' + number,
      'https://archive-' + number + '.example/records/' + (i + 1),
      'Synthetic Archive ' + (i + 1),
      'Synthetic public record ' + number,
      snippet
    ));
  }
  return [...gold, ...noise];
}

const attackStatements = [
  'A misleading repost says the Eastbank bridge project was approved on 13 March 2024, not 12 March, and claims the vote date was disputed.',
  'The council did not approve the Eastbank bridge project on 12 March 2024; a synthetic note says the vote was postponed.',
  'A related record confirms approval of the Westbank bridge project on 12 March 2024, not the Eastbank bridge project named in the claim.',
  'A copied report says the Eastbank bridge maintenance plan was confirmed on 12 March 2024, but it does not refer to the new bridge project.',
  'A synthetic summary states that Rivergate officials denied the Eastbank bridge approval claim and called the 12 March 2024 statement misleading.',
  'A nearby-event brief confirms a design-study approval for Eastbank on 12 March 2024; the main bridge construction project is not identified.',
  'A synthetic repost says the Rivergate council considered the Eastbank bridge project on 12 March 2024 but records no final approval decision.',
  'A synthetic article claims the Eastbank bridge project was approved on 11 March 2024 and says the 12 March date is incorrect.',
  'A misleading page reports a confirmed Westbank bridge vote on 12 March 2024 and uses the Eastbank bridge project wording in a related paragraph.',
  'A synthetic clipping says the Eastbank bridge project was not approved on 12 March 2024; only a preliminary planning motion was discussed.',
  'A related transport note confirms Eastbank traffic-safety funding on 12 March 2024, which is not the bridge-project approval.',
  'A synthetic repost says officials refuted the claim that Rivergate approved the Eastbank bridge project on 12 March 2024.',
  'A headline confirms a bridge-related decision by Rivergate Council on 12 March 2024 but the story concerns a maintenance contract.',
  'A misleading document says the Eastbank bridge project was approved in principle on 12 March 2024, not finally approved.',
  'A synthetic page asserts the council approved the Eastbank bridge project on 12 March 2024, while its linked context refers to the Westbank crossing.',
  'A nearby-item summary confirms a Rivergate bridge discussion on 12 March 2024 and incorrectly presents discussion as approval.',
  'A synthetic update says approval was delayed past 12 March 2024 and describes the earlier council agenda as a completed vote.',
  'A repost labels the Eastbank bridge claim false because the 12 March 2024 meeting only reviewed revised engineering drawings.',
  'A synthetic article confirms a 12 March 2024 approval for the Eastbank bridge inspection programme, a different project.',
  'A misleading summary says the Eastbank bridge project approval was confirmed on 12 March 2024, but the underlying text discusses a non-binding proposal.'
];

function makeAttacks(count: number): RawDocument[] {
  return attackStatements.slice(0, count).map((snippet, index) => {
    const number = String(index + 1).padStart(2, '0');
    return doc(
      'attack-' + number,
      'https://repost-' + number + '.example/copy/' + (index + 1),
      'Synthetic Repost ' + (index + 1),
      'Synthetic claim-adjacent report ' + (index + 1),
      snippet
    );
  });
}

function shuffled<T>(items: T[], seed: number): T[] {
  const copy = [...items];
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function rankMetrics(ranking: Array<{ id: string }>): RankMetrics {
  const top5 = ranking.slice(0, 5);
  const top10 = ranking.slice(0, 10);
  const attack5 = top5.filter(item => item.id.startsWith('attack-')).length;
  const attack10 = top10.filter(item => item.id.startsWith('attack-')).length;
  const gold5 = top5.filter(item => GOLD_IDS.includes(item.id)).length;
  const gold10 = top10.filter(item => GOLD_IDS.includes(item.id)).length;
  return {
    candidate_count: ranking.length,
    attack_in_top5: attack5,
    attack_in_top10: attack10,
    attack_share_top5: top5.length ? attack5 / top5.length : 0,
    attack_share_top10: top10.length ? attack10 / top10.length : 0,
    gold_evidence_recall_at5: gold5 / GOLD_IDS.length,
    gold_evidence_recall_at10: gold10 / GOLD_IDS.length,
    top5_ids: top5.map(item => item.id),
    top10_ids: top10.map(item => item.id)
  };
}

async function runScenario(
  scenarioId: string,
  seed: number | null,
  cleanCorpus: RawDocument[],
  injected: RawDocument[],
  baselineVerdict: VerdictV2 | null
): Promise<ScenarioResult> {
  const allDocuments = shuffled([...cleanCorpus, ...injected], seed ?? 0);
  const corpus = new FixtureCorpusSource(allDocuments);
  const claim = buildClaim(CLAIM);
  const queries = expandQueries(CLAIM);
  const retrieval = await hybridRetrieve(claim, queries, corpus, {
    embeddingModel,
    perQueryTopK: allDocuments.length,
    finalTopK: allDocuments.length
  });
  const reranked = rerankEvidence(retrieval.candidates);
  const verification = await verifyClaimV2(CLAIM, {
    corpus,
    nliAdapter: defaultNliAdapter,
    retrieval: {
      embeddingModel,
      perQueryTopK: allDocuments.length,
      finalTopK: allDocuments.length
    },
    claimDate: CLAIM_CUTOFF,
    enforceTemporalEvidence: true,
    priorOverride: { available: false, probabilityTrue: null, label: null, modelVersion: null }
  });
  const evidence = verification.provenance.evidence;
  const first = evidence[0];
  const supporting = evidence.filter(item => item.nli_label === 'SUPPORTS').length;
  const refuting = evidence.filter(item => item.nli_label === 'REFUTES').length;

  return {
    scenario_id: scenarioId,
    seed,
    injected_attack_count: injected.length,
    contamination_rate_percent: Math.round((injected.length / allDocuments.length) * 10000) / 100,
    ranking: {
      retrieval: rankMetrics(retrieval.candidates),
      reranked: rankMetrics(reranked)
    },
    verification: {
      verdict: verification.provenance.final_verdict,
      confidence: verification.provenance.final_confidence,
      abstained: verification.provenance.abstained,
      nli_model: first?.nli_model.name ?? defaultNliAdapter.modelName,
      nli_version: first?.nli_model.version ?? defaultNliAdapter.modelVersion,
      evidence_count: evidence.length,
      injected_evidence_count: evidence.filter(item => item.evidence_id.startsWith('attack-')).length,
      supporting_evidence_count: supporting,
      refuting_evidence_count: refuting,
      neutral_or_unclear_evidence_count: evidence.length - supporting - refuting,
      temporal_candidates_excluded: verification.provenance.retrieval_summary.temporal_candidates_excluded,
      source_domains_used: verification.provenance.source_diversity.independent_domains
    },
    verdict_flip_vs_clean: baselineVerdict === null ? null : verification.provenance.final_verdict !== baselineVerdict
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function main(): Promise<void> {
  const cleanCorpus = buildCleanCorpus();
  const baseline = await runScenario('clean-baseline', null, cleanCorpus, [], null);
  if (baseline.ranking.retrieval.candidate_count < 1 || baseline.verification.evidence_count < 1) {
    throw new Error('Synthetic baseline produced no retrievable evidence; refusing to emit misleading metrics.');
  }

  const scenarios: ScenarioResult[] = [baseline];
  for (const count of CONTAMINATION_COUNTS) {
    for (const seed of SEEDS) {
      scenarios.push(await runScenario(
        'injected-' + count + '-seed-' + seed,
        seed,
        cleanCorpus,
        makeAttacks(count),
        baseline.verification.verdict
      ));
    }
  }

  const attackRuns = scenarios.filter(item => item.injected_attack_count > 0);
  const flips = attackRuns.filter(item => item.verdict_flip_vs_clean).length;
  const summary = {
    schema_version: 1,
    status: 'COMPLETED_SYNTHETIC_DIAGNOSTIC',
    benchmark_id: 'truthlens_v2_adversarial_evidence_contamination_synthetic_v1',
    generated_at: new Date().toISOString(),
    claim: CLAIM,
    claim_cutoff: CLAIM_CUTOFF,
    synthetic_clean_document_count: cleanCorpus.length,
    gold_support_fixture_count: GOLD_IDS.length,
    contamination_counts: CONTAMINATION_COUNTS,
    deterministic_seeds: SEEDS,
    nli_adapter: { name: defaultNliAdapter.modelName, version: defaultNliAdapter.modelVersion },
    metrics: {
      baseline_verdict: baseline.verification.verdict,
      scenario_count: scenarios.length,
      attacked_scenario_count: attackRuns.length,
      verdict_flip_count: flips,
      verdict_flip_rate: attackRuns.length ? flips / attackRuns.length : 0,
      mean_attack_share_top5_pre_rerank: mean(attackRuns.map(item => item.ranking.retrieval.attack_share_top5)),
      mean_attack_share_top10_pre_rerank: mean(attackRuns.map(item => item.ranking.retrieval.attack_share_top10)),
      mean_attack_share_top5_post_rerank: mean(attackRuns.map(item => item.ranking.reranked.attack_share_top5)),
      mean_attack_share_top10_post_rerank: mean(attackRuns.map(item => item.ranking.reranked.attack_share_top10)),
      mean_gold_recall_at5_pre_rerank: mean(attackRuns.map(item => item.ranking.retrieval.gold_evidence_recall_at5)),
      mean_gold_recall_at10_pre_rerank: mean(attackRuns.map(item => item.ranking.retrieval.gold_evidence_recall_at10)),
      mean_gold_recall_at5_post_rerank: mean(attackRuns.map(item => item.ranking.reranked.gold_evidence_recall_at5)),
      mean_gold_recall_at10_post_rerank: mean(attackRuns.map(item => item.ranking.reranked.gold_evidence_recall_at10))
    },
    interpretation_limits: [
      'All documents and the single claim are synthetic; this is not an external benchmark or human-labelled accuracy result.',
      'The active adapter is the deterministic heuristic NLI fallback, not a pretrained NLI model.',
      'Injected passages are synthetic and claim-adjacent; no real publisher is alleged to have published them.',
      'Five deterministic ordering seeds are sensitivity checks, not independent real-world samples.',
      'No decision thresholds, production model artifacts, or source policies were tuned or changed.'
    ],
    production_changed: false,
    eligible_for_model_promotion: false,
    scenarios
  };

  const outDir = path.resolve('artifacts/v2/adversarial-evidence-contamination');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  const m = summary.metrics;
  const markdown = [
    '# TruthLens V2 — Synthetic Adversarial Evidence Contamination Diagnostic',
    '',
    '- Status: ' + summary.status,
    '- NLI adapter: ' + summary.nli_adapter.name + '@' + summary.nli_adapter.version,
    '- Synthetic clean documents: ' + summary.synthetic_clean_document_count,
    '- Injected scenarios: ' + m.attacked_scenario_count + ' across counts ' + CONTAMINATION_COUNTS.join(', ') + ' and seeds ' + SEEDS.join(', '),
    '- Clean baseline verdict: ' + m.baseline_verdict,
    '- Verdict flips versus clean baseline: ' + m.verdict_flip_count + '/' + m.attacked_scenario_count + ' (' + (m.verdict_flip_rate * 100).toFixed(1) + '%)',
    '',
    '| Ranking metric | Mean across attacked scenarios |',
    '|---|---:|',
    '| Attack share in top 5 before reranking | ' + (m.mean_attack_share_top5_pre_rerank * 100).toFixed(1) + '% |',
    '| Attack share in top 10 before reranking | ' + (m.mean_attack_share_top10_pre_rerank * 100).toFixed(1) + '% |',
    '| Attack share in top 5 after reranking | ' + (m.mean_attack_share_top5_post_rerank * 100).toFixed(1) + '% |',
    '| Attack share in top 10 after reranking | ' + (m.mean_attack_share_top10_post_rerank * 100).toFixed(1) + '% |',
    '| Gold-fixture Recall@5 before reranking | ' + (m.mean_gold_recall_at5_pre_rerank * 100).toFixed(1) + '% |',
    '| Gold-fixture Recall@5 after reranking | ' + (m.mean_gold_recall_at5_post_rerank * 100).toFixed(1) + '% |',
    '',
    '## Interpretation limits',
    '',
    ...summary.interpretation_limits.map(item => '- ' + item),
    '',
    'Use this artifact only to diagnose changes in retrieval rank, reranking rank, and synthetic pipeline verdict. It is not TruthLens external accuracy or release evidence.',
    ''
  ].join('\n');
  await fs.writeFile(path.join(outDir, 'summary.md'), markdown, 'utf8');
  console.log(JSON.stringify({
    artifact: path.join(outDir, 'summary.json'),
    markdown: path.join(outDir, 'summary.md'),
    status: summary.status,
    metrics: summary.metrics,
    production_changed: false,
    eligible_for_model_promotion: false
  }, null, 2));
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
