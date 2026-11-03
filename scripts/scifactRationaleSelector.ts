export interface RankedSentence {
  index: number;
  score: number;
}

/** Rank abstract sentence embeddings against a claim embedding; no gold rationale data is read. */
export function rankRationaleSentences(
  claimVector: number[],
  sentenceVectors: number[][],
  limit = 3
): RankedSentence[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Sentence limit must be a non-negative integer.');
  if (sentenceVectors.length === 0 || limit === 0) return [];
  if (!Array.isArray(claimVector) || claimVector.length === 0) throw new Error('Claim embedding must be non-empty.');
  const norm = Math.sqrt(claimVector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Claim embedding must have a finite non-zero norm.');
  return sentenceVectors.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length !== claimVector.length) {
      throw new Error(`Sentence embedding dimension mismatch at index ${index}.`);
    }
    let dot = 0;
    let vectorNormSq = 0;
    for (let i = 0; i < claimVector.length; i++) {
      dot += claimVector[i] * vector[i];
      vectorNormSq += vector[i] * vector[i];
    }
    const vectorNorm = Math.sqrt(vectorNormSq);
    const score = vectorNorm === 0 ? 0 : Math.max(-1, Math.min(1, dot / (norm * vectorNorm)));
    return { index, score };
  }).sort((a, b) => (b.score - a.score) || (a.index - b.index)).slice(0, limit);
}
