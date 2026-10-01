export type UnifiedLabel = 'SUPPORT' | 'CONTRADICT' | 'NOT_ENOUGH_INFO' | 'INSUFFICIENT_EVIDENCE' | 'CONFLICTED';

export interface UnifiedEvidenceRef {
  source_id: string;
  locator: string;
  source_url: string | null;
  sentence_ids?: number[];
  content_ids?: string[];
}

export interface UnifiedBenchmarkClaim {
  benchmark: 'fever_v1' | 'feverous' | 'averitec';
  id: string;
  claim: string;
  label: UnifiedLabel;
  evidence: UnifiedEvidenceRef[];
  metadata: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object record');
  return value as Record<string, any>;
}

function mapFeverLabel(value: unknown): UnifiedLabel {
  if (value === 'SUPPORTS') return 'SUPPORT';
  if (value === 'REFUTES') return 'CONTRADICT';
  if (value === 'NOT ENOUGH INFO') return 'NOT_ENOUGH_INFO';
  throw new Error('Unknown FEVER label: ' + String(value));
}

export function normalizeFever(input: unknown): UnifiedBenchmarkClaim {
  const row = asRecord(input);
  const evidence: UnifiedEvidenceRef[] = [];
  const groups = Array.isArray(row.evidence) ? row.evidence : [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const tuple of group) {
      if (!Array.isArray(tuple) || tuple.length < 4) continue;
      evidence.push({
        source_id: String(tuple[1] ?? tuple[0] ?? ''),
        locator: String(tuple[2] ?? ''),
        source_url: tuple[2] ? 'https://en.wikipedia.org/wiki/' + String(tuple[2]) : null,
        sentence_ids: tuple[3] == null ? [] : [Number(tuple[3])]
      });
    }
  }
  return {
    benchmark: 'fever_v1',
    id: String(row.id),
    claim: String(row.claim),
    label: mapFeverLabel(row.label),
    evidence,
    metadata: {}
  };
}

function mapFeverousLabel(value: unknown): UnifiedLabel {
  return mapFeverLabel(value);
}

export function normalizeFeverous(input: unknown): UnifiedBenchmarkClaim {
  const row = asRecord(input);
  const evidence: UnifiedEvidenceRef[] = [];
  const sets = Array.isArray(row.evidence) ? row.evidence : [];
  for (const set of sets.slice(0, 3)) {
    const content = asRecord(set).content;
    const contentIds = Array.isArray(content) ? content.map(String) : [];
    evidence.push({
      source_id: contentIds.join('|'),
      locator: contentIds.join('|'),
      source_url: null,
      content_ids: contentIds
    });
  }
  return {
    benchmark: 'feverous',
    id: String(row.id),
    claim: String(row.claim),
    label: mapFeverousLabel(row.label),
    evidence,
    metadata: { challenge: row.challenge ?? null }
  };
}

function mapAveritecLabel(value: unknown): UnifiedLabel {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'supported') return 'SUPPORT';
  if (normalized === 'refuted') return 'CONTRADICT';
  if (normalized === 'not enough evidence') return 'INSUFFICIENT_EVIDENCE';
  if (normalized === 'conflicting evidence/cherry-picking') return 'CONFLICTED';
  throw new Error('Unknown AVeriTeC label: ' + String(value));
}

export function normalizeAveritec(input: unknown): UnifiedBenchmarkClaim {
  const row = asRecord(input);
  const evidence: UnifiedEvidenceRef[] = [];
  const questions = Array.isArray(row.questions) ? row.questions : [];
  for (let qi = 0; qi < questions.length; qi++) {
    const question = asRecord(questions[qi]);
    const answers = Array.isArray(question.answers) ? question.answers : [];
    for (let ai = 0; ai < answers.length; ai++) {
      const answer = asRecord(answers[ai]);
      const url = answer.source_url ? String(answer.source_url) : null;
      evidence.push({
        source_id: String(row.id ?? row.claim ?? '') + ':' + qi + ':' + ai,
        locator: url ?? 'question:' + qi + ':answer:' + ai,
        source_url: url
      });
    }
  }
  return {
    benchmark: 'averitec',
    id: String(row.id ?? row.claim),
    claim: String(row.claim),
    label: mapAveritecLabel(row.label),
    evidence,
    metadata: { claim_date: row.claim_date ?? null, speaker: row.speaker ?? null, reporting_source: row.reporting_source ?? null }
  };
}
