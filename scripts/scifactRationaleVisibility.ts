export interface SciFactRationaleInput {
  label: 'SUPPORT' | 'CONTRADICT';
  sentences: number[];
}
export interface SciFactAbstractInput {
  doc_id: number;
  abstract: string[];
}
export interface RationaleVisibilityResult {
  gold_evidence_documents: number;
  gold_rationale_sentences: number;
  visible_rationale_sentences_within_limit: number;
  hidden_rationale_sentences_after_limit: number;
  missing_gold_document_ids: string[];
  per_document: Array<{
    document_id: string;
    gold_rationale_sentences: number;
    visible_within_limit: number;
    hidden_after_limit: number;
    rationale_sentence_indices: number[];
    hidden_sentence_indices: number[];
  }>;
}

/**
 * Research-only diagnostic. Mirrors the pipeline's plain-text cleanup and
 * 800-character passage cap; never feeds retrieval, NLI, or verdict logic.
 */
function normalizeAbstract(sentences: string[]): string[] {
  return sentences.map(sentence => sentence
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

export function analyzeSciFactRationaleVisibility(
  evidence: Record<string, SciFactRationaleInput[]>,
  corpus: SciFactAbstractInput[],
  maxChars = 800
): RationaleVisibilityResult {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer.');
  const docs = new Map(corpus.map(doc => [String(doc.doc_id), doc]));
  const perDocument: RationaleVisibilityResult['per_document'] = [];
  const missing: string[] = [];
  let totalSentences = 0;
  let visibleSentences = 0;
  let hiddenSentences = 0;

  for (const [documentId, rationales] of Object.entries(evidence || {})) {
    const doc = docs.get(documentId);
    if (!doc) {
      missing.push(documentId);
      continue;
    }
    const normalized = normalizeAbstract(doc.abstract);
    const offsets: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const sentence of normalized) {
      const start = cursor;
      const end = start + sentence.length;
      offsets.push({ start, end });
      cursor = end + 1; // abstract.join(' ') separator
    }
    const indices = rationales.flatMap(rationale => rationale.sentences);
    const uniqueIndices = Array.from(new Set(indices)).sort((a, b) => a - b);
    const visible = uniqueIndices.filter(index => Number.isInteger(index) && index >= 0 &&
      index < offsets.length && offsets[index].start < maxChars && offsets[index].end <= maxChars);
    const hidden = uniqueIndices.filter(index => Number.isInteger(index) && index >= 0 &&
      index < offsets.length && offsets[index].end > maxChars);
    totalSentences += uniqueIndices.length;
    visibleSentences += visible.length;
    hiddenSentences += hidden.length;
    perDocument.push({
      document_id: documentId,
      gold_rationale_sentences: uniqueIndices.length,
      visible_within_limit: visible.length,
      hidden_after_limit: hidden.length,
      rationale_sentence_indices: uniqueIndices,
      hidden_sentence_indices: hidden
    });
  }
  return {
    gold_evidence_documents: Object.keys(evidence || {}).length - missing.length,
    gold_rationale_sentences: totalSentences,
    visible_rationale_sentences_within_limit: visibleSentences,
    hidden_rationale_sentences_after_limit: hiddenSentences,
    missing_gold_document_ids: missing.sort(),
    per_document: perDocument
  };
}
