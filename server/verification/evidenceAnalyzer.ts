import {
  ExtractedClaim,
  EvidenceItem,
  ClaimAssessment,
  ClaimVerificationResult,
  SourceType,
  ClaimEvidenceRelation
} from '../../src/types';

export function determineSourceType(url: string, sourceName?: string): SourceType {
  const sName = (sourceName || '').toLowerCase();
  try {
    const domain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase();
    
    // 1. Official Government
    if (/\.gov(?:\.[a-z]{2})?$|\.mil(?:\.[a-z]{2})?$/i.test(domain) || domain.includes('whitehouse.gov') || domain.includes('nasa.gov') || sName.includes('white house') || sName.includes('nasa')) {
      return 'OFFICIAL_GOVERNMENT';
    }
    // 2. Official Organizations
    if (domain.endsWith('.int') || domain.includes('who.int') || domain.includes('un.org') || domain.includes('worldbank.org') || domain.includes('europa.eu') || sName.includes('united nations') || sName.includes('world health organization')) {
      return 'OFFICIAL_ORGANIZATION';
    }
    // 3. Primary scientific / academic
    if (domain.endsWith('.edu') || domain.includes('nature.com') || domain.includes('science.org') || domain.includes('sciencedirect.com') || domain.includes('arxiv.org') || domain.includes('nih.gov') || sName.includes('nature') || sName.includes('science')) {
      return 'PRIMARY_SCIENTIFIC';
    }
    // 4. Major established news organizations
    if (/(?:bbc\.(?:co\.uk|com)|reuters\.com|apnews\.com|npr\.org|bloomberg\.com|nytimes\.com|theguardian\.com|washingtonpost\.com|wsj\.com|ft\.com|afp\.com|aljazeera\.com|pbs\.org)/i.test(domain) ||
        /\b(?:bbc|reuters|associated press|ap news|npr|bloomberg|the guardian|new york times|washington post|wall street journal|financial times|afp|al jazeera|pbs)\b/i.test(sName)) {
      return 'MAJOR_NEWS';
    }
    // 5. Reputable sources
    if (/(?:techcrunch\.com|theverge\.com|wired\.com|forbes\.com|time\.com|politico\.com|economist\.com|wikipedia\.org|wikimedia\.org)/i.test(domain) ||
        /\b(?:techcrunch|the verge|wired|forbes|time|politico|the economist|wikipedia|wikimedia|ign|polygon|eurogamer|gamespot)\b/i.test(sName)) {
      return 'REPUTABLE_SOURCE';
    }
    return 'UNKNOWN';
  } catch {
    if (/\b(?:bbc|reuters|associated press|ap news|npr|bloomberg|the guardian|new york times|washington post)\b/i.test(sName)) {
      return 'MAJOR_NEWS';
    }
    return 'UNKNOWN';
  }
}

/**
 * Calculates a transparent, formulaic relevance score based on entity, numerical,
 * and keyword overlap between the claim and the candidate evidence snippet.
 */
export function calculateRelevance(
  claim: ExtractedClaim,
  snippet: string,
  title: string
): { score: number; explanation: string } {
  const textToEvaluate = `${title} ${snippet}`.toLowerCase();
  
  // 1. Entity overlap (weight: 0.40)
  let entityOverlap = 0;
  if (claim.entities.length > 0) {
    const matchedEntities = claim.entities.filter(ent => 
      textToEvaluate.includes(ent.toLowerCase())
    );
    entityOverlap = matchedEntities.length / claim.entities.length;
  }

  // 2. Number / Measurement overlap (weight: 0.30)
  let numberOverlap = 0;
  if (claim.numbers.length > 0) {
    const matchedNumbers = claim.numbers.filter(num => {
      const cleanNum = num.replace(/[^\d.]/g, '');
      return cleanNum.length > 0 && textToEvaluate.includes(cleanNum);
    });
    numberOverlap = matchedNumbers.length / claim.numbers.length;
  }

  // 3. Keyword Jaccard overlap (weight: 0.30)
  let keywordOverlap = 0;
  if (claim.keywords.length > 0) {
    const matchedKeywords = claim.keywords.filter(kw => 
      textToEvaluate.includes(kw.toLowerCase())
    );
    keywordOverlap = matchedKeywords.length / claim.keywords.length;
  }

  // Dynamic weighting depending on which fields were present in the claim
  let totalScore = 0;
  let explanation = '';

  if (claim.entities.length > 0 && claim.numbers.length > 0) {
    totalScore = (0.40 * entityOverlap) + (0.30 * numberOverlap) + (0.30 * keywordOverlap);
    explanation = `Computed score: ${(totalScore * 100).toFixed(0)}% (Entity match: ${(entityOverlap * 100).toFixed(0)}%, Numerical match: ${(numberOverlap * 100).toFixed(0)}%, Keyword match: ${(keywordOverlap * 100).toFixed(0)}%)`;
  } else if (claim.entities.length > 0) {
    totalScore = (0.55 * entityOverlap) + (0.45 * keywordOverlap);
    explanation = `Computed score: ${(totalScore * 100).toFixed(0)}% (Entity match: ${(entityOverlap * 100).toFixed(0)}%, Keyword match: ${(keywordOverlap * 100).toFixed(0)}%)`;
  } else if (claim.numbers.length > 0) {
    totalScore = (0.50 * numberOverlap) + (0.50 * keywordOverlap);
    explanation = `Computed score: ${(totalScore * 100).toFixed(0)}% (Numerical match: ${(numberOverlap * 100).toFixed(0)}%, Keyword match: ${(keywordOverlap * 100).toFixed(0)}%)`;
  } else {
    totalScore = keywordOverlap;
    explanation = `Computed score: ${(totalScore * 100).toFixed(0)}% (Keyword match: ${(keywordOverlap * 100).toFixed(0)}%)`;
  }

  const clampedScore = Math.max(0, Math.min(1, Math.round(totalScore * 100) / 100));
  return { score: clampedScore, explanation };
}

/**
 * Validates numerical consistency between claim and evidence snippet.
 * Flags numerical disagreement (e.g. "4%" vs "0.4%").
 */
export function checkNumericalConsistency(
  claim: ExtractedClaim,
  snippet: string
): { isConsistent: boolean; claimNumbers: string[]; evidenceNumbers: string[]; warning?: string } {
  if (claim.numbers.length === 0) {
    return { isConsistent: true, claimNumbers: [], evidenceNumbers: [] };
  }

  const numberMatches = snippet.match(/(?:[\$€£₹¥]\s*[\d,.]+(?:\s*(?:billion|million|trillion|lakh|crore))?|\b\d+(?:\.\d+)?%|\b\d+(?:,\d+)*(?:\.\d+)?\s*(?:hours?|days?|months?|years?|percent|people|dollars|tonnes?|miles?|km)?\b)/gi) || [];
  const cleanSnippetNums = Array.from(new Set(numberMatches.map(n => n.trim())));

  for (const claimNum of claim.numbers) {
    const claimRaw = claimNum.replace(/[^\d.]/g, '');
    if (!claimRaw) continue;

    // Check if snippet has percentages while claim had percentages
    if (claimNum.includes('%')) {
      const snippetPercents = cleanSnippetNums.filter(n => n.includes('%'));
      if (snippetPercents.length > 0) {
        const hasExactMatch = snippetPercents.some(sp => sp.replace(/[^\d.]/g, '') === claimRaw);
        if (!hasExactMatch) {
          return {
            isConsistent: false,
            claimNumbers: claim.numbers,
            evidenceNumbers: cleanSnippetNums,
            warning: `Numerical discrepancy: Claim states ${claimNum}, but retrieved evidence reports ${snippetPercents.join(', ')}.`
          };
        }
      }
    }

    // Check if there are other conflicting numbers in the snippet
    const conflictingNums = cleanSnippetNums.filter(sn => {
      const snRaw = sn.replace(/[^\d.]/g, '');
      return snRaw && snRaw !== claimRaw && Math.abs(parseFloat(snRaw) - parseFloat(claimRaw)) > 0.001;
    });

    // If no exact match found at all for the number in snippet
    const exactMatch = cleanSnippetNums.some(sn => sn.replace(/[^\d.]/g, '') === claimRaw);
    if (!exactMatch && conflictingNums.length > 0) {
      return {
        isConsistent: false,
        claimNumbers: claim.numbers,
        evidenceNumbers: cleanSnippetNums,
        warning: `Numerical discrepancy: Claim references '${claimNum}', but retrieved evidence mentions '${conflictingNums.join(', ')}'.`
      };
    }
  }

  return { isConsistent: true, claimNumbers: claim.numbers, evidenceNumbers: cleanSnippetNums };
}

/**
 * Checks temporal consistency between claimed timing and published evidence.
 */
export function checkTemporalConsistency(
  claim: ExtractedClaim,
  evidenceDate?: string
): { isConsistent: boolean; warning?: string } {
  if (!evidenceDate || claim.dates.length === 0) {
    return { isConsistent: true };
  }

  try {
    const pubDate = new Date(evidenceDate);
    if (isNaN(pubDate.getTime())) return { isConsistent: true };

    const lowerDates = claim.dates.map(d => d.toLowerCase());
    // If claim mentions "in 2026" and article was published in 2020
    const yearMatch = claim.dates.join(' ').match(/\b(19\d\d|20\d\d)\b/);
    if (yearMatch) {
      const claimYear = parseInt(yearMatch[1], 10);
      const pubYear = pubDate.getFullYear();
      if (claimYear !== pubYear) {
        return {
          isConsistent: false,
          warning: `Temporal conflict: Claim references year ${claimYear}, whereas source was published in ${pubYear}.`
        };
      }
    }
  } catch {
    // Ignore date parsing issues
  }

  return { isConsistent: true };
}

/**
 * Classifies an individual evidence item's relation to a claim.
 */
export function classifyEvidenceRelation(
  claim: ExtractedClaim,
  snippet: string,
  relevanceScore: number,
  numConsistency: { isConsistent: boolean; warning?: string }
): ClaimEvidenceRelation {
  if (relevanceScore < 0.22) {
    return 'IRRELEVANT';
  }

  const textLower = snippet.toLowerCase();

  // If numerical discrepancy detected, it cannot be SUPPORTS
  if (!numConsistency.isConsistent) {
    return 'CONTRADICTS';
  }

  // Refutation and contradiction markers
  const contradictionPatterns = [
    /\b(?:denied|denies|debunked|false|refuted|disproved|hoax|untrue|incorrect|no evidence that|fabricated|fake|never happened|misleading|retracted)\b/i,
    /\b(?:not true|not correct|contrary to claims|disputed by|rejected claims)\b/i
  ];

  for (const pat of contradictionPatterns) {
    if (pat.test(textLower)) {
      return 'CONTRADICTS';
    }
  }

  // Mixed or nuanced markers
  const mixedPatterns = [
    /\b(?:partially true|mixed reports|unclear whether|contested|debated|partly true|conflicting claims|some dispute)\b/i
  ];

  for (const pat of mixedPatterns) {
    if (pat.test(textLower)) {
      return 'MIXED';
    }
  }

  // Supporting markers or high relevance alignment
  if (relevanceScore >= 0.40) {
    return 'SUPPORTS';
  }

  if (relevanceScore >= 0.25) {
    return 'MIXED';
  }

  return 'INSUFFICIENT';
}

/**
 * Analyzes diversity among retrieved sources and detects syndication / duplication.
 */
export function evaluateSourceDiversity(evidenceList: EvidenceItem[]): {
  independentSourcesCount: number;
  totalSourcesCount: number;
  syndicationNote?: string;
} {
  if (evidenceList.length === 0) {
    return { independentSourcesCount: 0, totalSourcesCount: 0 };
  }

  const uniqueDomains = new Set<string>();
  let syndicatedCount = 0;

  for (const item of evidenceList) {
    try {
      const domain = new URL(item.sourceUrl.startsWith('http') ? item.sourceUrl : `https://${item.sourceUrl}`).hostname.toLowerCase().replace(/^www\./, '');
      uniqueDomains.add(domain);
    } catch {
      uniqueDomains.add(item.sourceName.toLowerCase());
    }

    if (item.isSyndicated || /\b(?:reuters|ap news|associated press|afp)\b/i.test(item.snippet)) {
      syndicatedCount++;
    }
  }

  const independentCount = uniqueDomains.size;
  const effectiveIndependentCount = syndicatedCount >= 2 ? Math.max(1, independentCount - syndicatedCount + 1) : independentCount;
  
  let syndicationNote = `${independentCount} independent root domain${independentCount !== 1 ? 's' : ''} identified.`;

  if (syndicatedCount >= 2) {
    syndicationNote = `Multiple wire reports detected (${syndicatedCount} outlets republishing syndicated wire coverage); discounted to avoid treating wire reproduction as independent confirmation.`;
  }

  return {
    independentSourcesCount: effectiveIndependentCount,
    totalSourcesCount: evidenceList.length,
    syndicationNote
  };
}

/**
 * Aggregates evidence items for a single claim into a ClaimVerificationResult.
 */
export function aggregateClaimAssessment(
  claim: ExtractedClaim,
  evidenceItems: EvidenceItem[]
): ClaimVerificationResult {
  const relevantItems = evidenceItems.filter(e => e.relation !== 'IRRELEVANT');

  const counts = {
    supports: relevantItems.filter(e => e.relation === 'SUPPORTS').length,
    contradicts: relevantItems.filter(e => e.relation === 'CONTRADICTS').length,
    mixed: relevantItems.filter(e => e.relation === 'MIXED').length,
    insufficient: relevantItems.filter(e => e.relation === 'INSUFFICIENT').length
  };

  const diversity = evaluateSourceDiversity(relevantItems);

  // Check for any numerical or temporal warnings in evidence items
  const numWarningItem = relevantItems.find(e => e.numericalConsistency && !e.numericalConsistency.isConsistent);
  const temporalWarningItem = relevantItems.find(e => e.temporalConsistency && !e.temporalConsistency.isConsistent);

  let assessment: ClaimAssessment = 'INSUFFICIENT';
  let explanation = '';
  let confidenceScore = 0;
  let confidenceExplanation = '';

  if (relevantItems.length === 0) {
    assessment = 'INSUFFICIENT';
    explanation = 'No reliable independent evidence was retrieved for this specific claim.';
    confidenceScore = 0.20;
    confidenceExplanation = 'Zero independent sources found to substantiate or dispute the claim.';
  } else if (counts.contradicts > 0 && counts.supports > 0) {
    assessment = 'MIXED';
    explanation = `Credible external sources present conflicting findings (${counts.supports} supporting vs ${counts.contradicts} contradicting).`;
    confidenceScore = 0.65;
    confidenceExplanation = 'Multiple independent sources retrieved, but evidence contains conflicting assertions.';
  } else if (counts.contradicts > 0) {
    assessment = 'CONTRADICTED';
    explanation = numWarningItem?.numericalConsistency?.warning ||
      `Retrieved evidence directly refutes or contradicts the factual assertion (${counts.contradicts} source${counts.contradicts > 1 ? 's' : ''}).`;
    confidenceScore = Math.min(0.95, 0.60 + (diversity.independentSourcesCount * 0.15));
    confidenceExplanation = `Substantiated by ${diversity.independentSourcesCount} independent source(s) identifying factual disagreement.`;
  } else if (counts.supports >= 1) {
    assessment = 'SUPPORTED';
    explanation = `Retrieved external reporting corroborates the factual assertion across ${diversity.independentSourcesCount} independent source(s).`;
    confidenceScore = Math.min(0.95, 0.55 + (diversity.independentSourcesCount * 0.15));
    confidenceExplanation = `Corroborated by ${diversity.independentSourcesCount} reputable external reporting outlet(s).`;
  } else if (counts.mixed > 0) {
    assessment = 'MIXED';
    explanation = 'Retrieved evidence indicates partial agreement or inconclusive circumstances.';
    confidenceScore = 0.50;
    confidenceExplanation = 'Retrieved sources provide ambiguous or partial corroboration.';
  } else {
    assessment = 'INSUFFICIENT';
    explanation = 'Available search results do not provide enough specific factual details to verify this claim.';
    confidenceScore = 0.30;
    confidenceExplanation = 'Retrieved articles mention topic but lack direct verification of the specific assertion.';
  }

  return {
    claim,
    assessment,
    assessmentExplanation: explanation,
    evidence: relevantItems,
    evidenceCounts: counts,
    numericalWarning: numWarningItem?.numericalConsistency?.warning,
    temporalConflict: temporalWarningItem?.temporalConsistency?.warning,
    sourceDiversity: diversity,
    confidence: {
      score: Math.round(confidenceScore * 100),
      explanation: confidenceExplanation
    }
  };
}
