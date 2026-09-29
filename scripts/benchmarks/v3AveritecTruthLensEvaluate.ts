import fs from 'node:fs';
import path from 'node:path';
import { LiveEvidenceProviderCorpusSource } from '../../server/v2/retrieval/corpusSource';
import { verifyClaimV2 } from '../../server/v2/pipeline';

type Reference = {
  claim: string;
  claim_date?: string | null;
  label: string;
  [key: string]: unknown;
};

function arg(name: string, fallback?: string) {
  const hit = process.argv.find((v) => v.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function mapVerdict(verdict: string): string {
  switch (verdict) {
    case 'VERIFIED':
      return 'Supported';
    case 'REFUTED':
      return 'Refuted';
    case 'CONFLICTED':
      return 'Conflicting Evidence/Cherrypicking';
    default:
      return 'Not Enough Evidence';
  }
}

function normalizeEvidence(evidence: any[], queries: string[]) {
  return evidence.slice(0, 10).map((item, index) => ({
    question: queries[index % Math.max(1, queries.length)] || 'What evidence is available about this claim?',
    answers: [{
      answer: item.passage || item.snippet || item.title || '',
      answer_type: 'Extractive',
      source_url: item.url,
      cached_source_url: null,
      source_medium: 'web_text'
    }]
  }));
}

async function main() {
  const input = path.resolve(arg('input', 'artifacts/v3/averitec/dev.json')!);
  const output = path.resolve(arg('output', 'artifacts/v3/averitec/truthlens-predictions.json')!);
  const maxClaims = Number(arg('max-claims', '0'));
  const rows: Reference[] = JSON.parse(fs.readFileSync(input, 'utf8'));
  const selected = maxClaims > 0 ? rows.slice(0, maxClaims) : rows;

  const corpus = new LiveEvidenceProviderCorpusSource();
  const predictions: any[] = [];

  for (let i = 0; i < selected.length; i += 1) {
    const row = selected[i];
    const result = await verifyClaimV2(row.claim, {
      corpus,
      nliConcurrency: Number(process.env.TRUTHLENS_NLI_CONCURRENCY || 4),
      retrieval: { perQueryTopK: 20, finalTopK: 8 },
      enableFullTextEnrichment: false,
      minCandidatesExpectedWarning: 0,
      claimDate: row.claim_date ?? (row.date as string | null | undefined) ?? (row.claimDate as string | null | undefined) ?? null,
      enforceTemporalEvidence: true,
      priorOverride: {
        available: false,
        probabilityTrue: null,
        label: null,
        modelVersion: null
      }
    });

    const provenance = result.provenance;
    const evidence = provenance.evidence || [];
    const queries = provenance.queries?.all || [];

    predictions.push({
      claim: row.claim,
      label: mapVerdict(provenance.final_verdict),
      questions: normalizeEvidence(evidence, queries),
      justification: evidence.slice(0, 5).map((e: any) => e.passage || e.snippet || e.title || '').filter(Boolean).join(' '),
      truthlens_provenance: {
        final_verdict: provenance.final_verdict,
        confidence: provenance.final_confidence,
        abstained: provenance.abstained,
        abstention_reason: provenance.abstention_reason,
        evidence_count: evidence.length,
        retrieval_diagnostics: provenance.retrieval_summary,
        evidence_urls: evidence.map((e: any) => e.url)
      }
    });

    if ((i + 1) % 10 === 0 || i + 1 === selected.length) {
      console.log('Evaluated ' + (i + 1) + '/' + selected.length);
    }
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(predictions, null, 2) + '\\n');
  console.log(JSON.stringify({
    benchmark_id: 'averitec',
    evaluation_count: predictions.length,
    output
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
