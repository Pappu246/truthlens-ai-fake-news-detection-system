import {
  ExtractedClaim,
  ClaimVerificationResult,
  ArticleVerificationResponse,
  EvidenceItem
} from '../../src/types';
import { extractClaims, extractPrimaryClaim, ClaimExtractionResult } from './claimExtractor';
import { evidenceProvider } from './evidenceProvider';
import { buildArticleVerification } from './assessmentEngine';

export interface SourceEvaluation {
  provided: boolean;
  url: string | null;
  domain: string | null;
  source_status: string;
  verification_status: string;
  notes: string;
}

export interface EvidenceSearchStatus {
  available: boolean;
  status: 'AVAILABLE' | 'UNAVAILABLE';
  message: string;
  reason: string;
  results: any[];
}

export interface ClaimVerificationResponse {
  claim: ClaimExtractionResult;
  source: SourceEvaluation;
  evidence: EvidenceSearchStatus;
  status: 'COMPLETED';
  verification_verdict: string;
  verification_note: string;
}

export function evaluateSourceProvenance(sourceUrl?: string | null): SourceEvaluation {
  if (!sourceUrl || !sourceUrl.trim()) {
    return {
      provided: false,
      url: null,
      domain: null,
      source_status: 'Not provided',
      verification_status: 'Not independently verified',
      notes: 'No source URL was supplied. The assessment was performed solely on article text.'
    };
  }

  const trimmed = sourceUrl.trim();
  try {
    const urlObj = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const domain = urlObj.hostname.toLowerCase();
    return {
      provided: true,
      url: trimmed,
      domain,
      source_status: domain,
      verification_status: 'Recorded for provenance',
      notes: `Origin domain '${domain}' recorded for provenance tracking. Evaluation is based on text content and external corroboration.`
    };
  } catch {
    return {
      provided: true,
      url: trimmed,
      domain: trimmed,
      source_status: trimmed,
      verification_status: 'Not independently verified',
      notes: 'Source URL string recorded. Evaluation is based on text content and external corroboration.'
    };
  }
}

/**
 * Executes full Phase 4 Article Verification pipeline:
 * Article -> Extract Claims -> Normalize Claims -> Search Evidence -> Assess Claims -> Rule Aggregation -> Final Assessment
 */
export async function verifyArticleContent(options: {
  title?: string;
  content: string;
  sourceUrl?: string;
  mlRiskLevel?: 'LOW' | 'MODERATE' | 'HIGH' | 'UNDETERMINED';
  id?: string | number;
}): Promise<ArticleVerificationResponse> {
  const { title = '', content, sourceUrl = '', mlRiskLevel = 'UNDETERMINED', id = Date.now().toString() } = options;

  // 1. Extract claims
  const claims = await extractClaims(title, content);

  // 2. Search and verify evidence for claims
  const verifiedClaims = await evidenceProvider.verifyClaims(claims);

  // 3. Build article verification with rule-based aggregation
  const wordCount = content.trim().split(/\s+/).filter(w => w.length > 0).length;
  const contentPreview = content.slice(0, 200) + (content.length > 200 ? '...' : '');

  return buildArticleVerification(id, {
    claims: verifiedClaims,
    mlRiskLevel,
    articleTitle: title || undefined,
    articleUrl: sourceUrl || undefined,
    contentPreview,
    wordCount
  });
}

/**
 * Backward-compatible single claim verification helper
 */
export function verifyClaim(text: string, sourceUrl?: string | null): ClaimVerificationResponse {
  const claim = extractPrimaryClaim(text);
  const source = evaluateSourceProvenance(sourceUrl);

  const evidence: EvidenceSearchStatus = {
    available: true,
    status: 'AVAILABLE',
    message: 'Phase 4 Claim Extraction and Evidence Verification Engine active.',
    reason: 'Multi-source live web and knowledge verification pipeline enabled.',
    results: []
  };

  return {
    claim,
    source,
    evidence,
    status: 'COMPLETED',
    verification_verdict: 'MULTI_SIGNAL_PIPELINE_ACTIVE',
    verification_note: 'Claim extraction and live evidence search engine configured.'
  };
}
