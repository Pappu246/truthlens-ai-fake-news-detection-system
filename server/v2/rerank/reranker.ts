/**
 * V2 EVIDENCE RERANKING
 * =====================
 * Combines several reproducible, transparent signals into one rerank score.
 * Source quality is one signal among several — it never auto-decides a
 * verdict; see the decision policy for how these are aggregated.
 *
 * Signals:
 *   - lexical      : BM25 relevance (from retrieval)
 *   - semantic     : dense/embedding relevance (from retrieval)
 *   - sourceQuality: reuses the EXISTING `determineSourceType` classifier
 *                    from `server/verification/evidenceAnalyzer.ts` — no
 *                    second source-tier taxonomy is introduced.
 *   - freshness    : recency of publication relative to "now" (a stale wire
 *                    story about a fast-moving topic is weaker evidence)
 *   - independence : penalises duplicate/syndicated sources so that ten
 *                    outlets republishing one wire story do not count as ten
 *                    independent confirmations
 */
import { determineSourceType } from '../../verification/evidenceAnalyzer';
import { RetrievedCandidate, RerankedEvidence, RerankSignals } from '../types';

const WEIGHTS = {
  lexical: 0.25,
  semantic: 0.2,
  sourceQuality: 0.25,
  freshness: 0.1,
  independence: 0.2
};

const SOURCE_QUALITY_SCORE: Record<string, number> = {
  OFFICIAL_GOVERNMENT: 1.0,
  OFFICIAL_ORGANIZATION: 0.95,
  PRIMARY_SCIENTIFIC: 0.9,
  MAJOR_NEWS: 0.75,
  REPUTABLE_SOURCE: 0.55,
  UNKNOWN: 0.3
};

const WIRE_SERVICE_PATTERN = /\b(?:associated press|ap news|\bap\b|reuters|afp|agence france-presse|bloomberg)\b/i;

function registrableDomain(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    return parts.length <= 2 ? host : parts.slice(-2).join('.');
  } catch {
    return 'unknown';
  }
}

function freshnessScore(publishedAt: string | null | undefined): number {
  if (!publishedAt) return 0.5; // unknown date: neutral, not penalised nor rewarded
  const published = new Date(publishedAt).getTime();
  if (Number.isNaN(published)) return 0.5;
  const ageDays = Math.max(0, (Date.now() - published) / (1000 * 60 * 60 * 24));
  // Half-life style decay: ~1.0 for same-day, ~0.5 at 180 days, floor 0.15.
  const decayed = Math.exp(-ageDays / 180);
  return Math.max(0.15, Math.min(1, decayed));
}

/**
 * Reranks retrieved candidates. Duplicate/syndicated sources are kept in the
 * output (nothing is silently dropped — see `isDuplicateCluster`) but their
 * independence signal — and therefore their overall rerank score and
 * downstream vote weight — is reduced.
 */
export function rerankEvidence(candidates: RetrievedCandidate[]): RerankedEvidence[] {
  const seenDomains = new Map<string, number>(); // domain -> occurrences seen so far
  const wireSeen = { count: 0 };

  const withSourceType = candidates.map(c => {
    const sourceType = determineSourceType(c.url, c.publisher);
    const domain = registrableDomain(c.url);
    const isWireText = WIRE_SERVICE_PATTERN.test(`${c.snippet} ${c.publisher}`);
    return { c, sourceType, domain, isWireText };
  });

  const reranked: RerankedEvidence[] = withSourceType.map(({ c, sourceType, domain, isWireText }) => {
    const priorDomainCount = seenDomains.get(domain) || 0;
    seenDomains.set(domain, priorDomainCount + 1);
    if (isWireText) wireSeen.count += 1;

    // Independence: first sighting of a domain is fully independent (1.0);
    // repeats of the same domain, or a second+ wire-service reprint, are
    // discounted rather than counted as fresh corroboration.
    const isDuplicateCluster = priorDomainCount > 0 || (isWireText && wireSeen.count > 1);
    const independence = isDuplicateCluster ? 0.25 : 1.0;

    const signals: RerankSignals = {
      lexical: c.lexicalScore,
      semantic: c.denseScore,
      sourceQuality: SOURCE_QUALITY_SCORE[sourceType] ?? 0.3,
      freshness: freshnessScore(c.publishedAt),
      independence
    };

    const rerankScore =
      WEIGHTS.lexical * signals.lexical +
      WEIGHTS.semantic * signals.semantic +
      WEIGHTS.sourceQuality * signals.sourceQuality +
      WEIGHTS.freshness * signals.freshness +
      WEIGHTS.independence * signals.independence;

    const rerankExplanation =
      `score=${rerankScore.toFixed(3)} = ` +
      `${WEIGHTS.lexical}*lexical(${signals.lexical.toFixed(2)}) + ` +
      `${WEIGHTS.semantic}*semantic(${signals.semantic.toFixed(2)}) + ` +
      `${WEIGHTS.sourceQuality}*sourceQuality(${signals.sourceQuality.toFixed(2)}, ${sourceType}) + ` +
      `${WEIGHTS.freshness}*freshness(${signals.freshness.toFixed(2)}) + ` +
      `${WEIGHTS.independence}*independence(${signals.independence.toFixed(2)}` +
      `${isDuplicateCluster ? ', duplicate/syndicated cluster' : ', first independent sighting'})`;

    return {
      ...c,
      rerankScore: Math.round(rerankScore * 1000) / 1000,
      rerankSignals: signals,
      rerankExplanation,
      sourceType,
      domainClusterId: domain,
      isDuplicateCluster
    };
  });

  return reranked.sort((a, b) => b.rerankScore - a.rerankScore);
}
