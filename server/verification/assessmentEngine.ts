import {
  ExtractedClaim,
  ClaimVerificationResult,
  ArticleVerificationResponse,
  FinalAssessment
} from '../../src/types';

export interface FinalAssessmentInput {
  claims: ClaimVerificationResult[];
  mlRiskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'UNDETERMINED';
  articleTitle?: string;
  articleUrl?: string;
  contentPreview: string;
  wordCount: number;
}

/**
 * Transparent rule-based synthesis between ML linguistic risk and factual evidence.
 */
export function synthesizeMlAndEvidence(
  finalAssessment: FinalAssessment,
  mlRiskLevel: string,
  summary: { supported: number; contradicted: number; mixed: number; insufficient: number }
): string {
  const isMlHigh = mlRiskLevel === 'HIGH';
  const isMlLow = mlRiskLevel === 'LOW';

  if (finalAssessment === 'LIKELY SUPPORTED') {
    if (isMlHigh) {
      return 'Divergent signals: The ML classifier flagged high linguistic/sensational risk, but retrieved external evidence independently corroborates the factual claims. Factual verification supersedes stylistic language indicators.';
    }
    return 'Corroborated: Retrieved external reporting supports key claims, and the ML classifier confirms low linguistic risk patterns.';
  }

  if (finalAssessment === 'LIKELY FALSE') {
    if (isMlLow) {
      return 'Deceptive credibility: The article employs formal, low-risk linguistic phrasing, yet factual evidence directly refutes or contradicts the core assertions.';
    }
    return 'Compounded risk: Retrieved evidence directly contradicts key assertions, coinciding with elevated ML linguistic risk flags.';
  }

  if (finalAssessment === 'MIXED / CONTESTED') {
    return 'Contested reporting: External sources present contradictory findings or partial truths across key claims. Cross-referencing multiple primary sources is strongly advised.';
  }

  if (finalAssessment === 'UNVERIFIED' || finalAssessment === 'INSUFFICIENT EVIDENCE') {
    if (isMlHigh) {
      return 'Unverified with elevated stylistic risk: External factual sources are currently insufficient to confirm the assertions, while the ML model detects high sensationalist or unverified language patterns.';
    }
    return 'Unverified developing story: External factual evidence is currently insufficient to independently substantiate or refute the claims. Note: A lack of immediate external evidence does not imply the report is fake.';
  }

  return 'Independent multi-signal assessment completed.';
}

/**
 * Evaluates the claims and creates an article-level verification response.
 */
export function buildArticleVerification(
  id: string | number,
  input: FinalAssessmentInput
): ArticleVerificationResponse {
  const { claims, mlRiskLevel, articleTitle, articleUrl, contentPreview, wordCount } = input;

  const totalClaims = claims.length;
  const verifiedClaims = claims.filter(c => c.assessment !== 'INSUFFICIENT').length;

  const supported = claims.filter(c => c.assessment === 'SUPPORTED').length;
  const contradicted = claims.filter(c => c.assessment === 'CONTRADICTED').length;
  const mixed = claims.filter(c => c.assessment === 'MIXED').length;
  const insufficient = claims.filter(c => c.assessment === 'INSUFFICIENT').length;

  const summary = {
    totalClaims,
    verifiedClaims,
    supported,
    contradicted,
    mixed,
    insufficient
  };

  const highImportanceClaims = claims.filter(c => c.claim.importance === 'HIGH');
  const importantClaims = claims.filter(c => c.claim.importance === 'HIGH' || c.claim.importance === 'MEDIUM');

  let finalAssessment: FinalAssessment = 'INSUFFICIENT EVIDENCE';
  let reasoning = '';
  const warnings: string[] = [];

  // Rule 1: Key claims contradicted
  if (contradicted > 0) {
    const highContradicted = highImportanceClaims.some(c => c.assessment === 'CONTRADICTED');
    if (highContradicted || contradicted >= 2) {
      finalAssessment = 'LIKELY FALSE';
      reasoning = `Core factual assertions were directly contradicted by external reporting (${contradicted} contradicted claim${contradicted > 1 ? 's' : ''}).`;
    } else {
      finalAssessment = 'MIXED / CONTESTED';
      reasoning = `While some claims remain contested or supported, at least one secondary claim was contradicted by independent reporting.`;
    }
  }
  // Rule 2: Mixed or conflicting sources
  else if (mixed > 0 && supported === 0) {
    finalAssessment = 'MIXED / CONTESTED';
    reasoning = `Retrieved evidence presents conflicting accounts or partial verification across key assertions.`;
  }
  else if (mixed > 0 && supported > 0) {
    finalAssessment = 'MIXED / CONTESTED';
    reasoning = `Some claims are supported by external evidence, while other assertions remain contested or inconclusive.`;
  }
  // Rule 3: Supported claims
  else if (supported > 0) {
    const highSupported = highImportanceClaims.length === 0 || highImportanceClaims.every(c => c.assessment === 'SUPPORTED');
    if (highSupported && supported >= Math.ceil(importantClaims.length / 2)) {
      finalAssessment = 'LIKELY SUPPORTED';
      reasoning = `Key factual assertions are substantiated by credible external reporting (${supported} verified claim${supported > 1 ? 's' : ''}).`;
    } else {
      finalAssessment = 'LIKELY SUPPORTED';
      reasoning = `External sources corroborate prominent claims, though certain peripheral details remain unverified.`;
    }
  }
  // Rule 4: Insufficient evidence / Unverified
  else {
    finalAssessment = 'INSUFFICIENT EVIDENCE';
    reasoning = `No authoritative independent evidence was found to confirm or dispute the extracted assertions.`;
    warnings.push('This claim may require additional verification as reporting develops. A lack of evidence does not mean the story is fake.');
  }

  // Collect specific numerical and temporal warnings
  for (const c of claims) {
    if (c.numericalWarning) {
      warnings.push(`Claim "${c.claim.normalizedText.slice(0, 60)}...": ${c.numericalWarning}`);
    }
    if (c.temporalConflict) {
      warnings.push(`Claim "${c.claim.normalizedText.slice(0, 60)}...": ${c.temporalConflict}`);
    }
  }

  // Mandatory journalistic disclaimer
  warnings.push('Important: Evidence availability reflects current external web reporting and does not guarantee absolute factual truth.');

  const mlEvidenceSynthesis = synthesizeMlAndEvidence(finalAssessment, mlRiskLevel, summary);

  return {
    id,
    article: {
      title: articleTitle,
      url: articleUrl,
      contentPreview,
      wordCount
    },
    claims,
    summary,
    finalAssessment,
    finalAssessmentReasoning: reasoning,
    mlRisk: mlRiskLevel,
    mlEvidenceSynthesis,
    warnings,
    createdAt: new Date().toISOString()
  };
}
