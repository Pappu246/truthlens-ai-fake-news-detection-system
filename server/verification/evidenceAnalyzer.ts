import {
  ExtractedClaim,
  EvidenceItem,
  ClaimAssessment,
  ClaimVerificationResult,
  SourceType,
  ClaimEvidenceRelation
} from '../../src/types.js';

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
  const dateNumbers = new Set(
    claim.dates.flatMap(date => date.match(/\d+(?:\.\d+)?/g) || [])
  );
  const dateText = claim.dates.map(date => date.toLowerCase());
  const numericIdentifiers = (
    claim.normalizedText.match(/\b[A-Z][A-Za-z-]*(?:\s+[A-Z][A-Za-z-]*){0,2}\s+\d+\b/g) || []
  )
    .filter(identifier => !dateText.some(date => date.includes(identifier.toLowerCase())))
    .map(identifier => identifier.match(/(\d+)$/)?.[1])
    .filter((value): value is string => Boolean(value));
  const identifierNumbers = new Set(numericIdentifiers);

  for (const claimNum of claim.numbers) {
    const claimRaw = claimNum.replace(/[^\d.]/g, '');
    if (!claimRaw) continue;
    // Dates and numbered subjects are contextual identifiers rather than
    // free-standing measurements. July 20, 1969 is compatible with July 16–24,
    // 1969; Apollo 12 is not a numerical refutation of Apollo 11.
    if (dateNumbers.has(claimRaw) || identifierNumbers.has(claimRaw)) continue;

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
  _numConsistency: { isConsistent: boolean; warning?: string }
): ClaimEvidenceRelation {
  if (relevanceScore < 0.22) {
    return 'IRRELEVANT';
  }

  const contradictionPatterns = [
    /\b(?:denied|denies|debunked|false|refuted|disproved|hoax|untrue|incorrect|no evidence that|fabricated|fake|never happened|misleading|retracted)\b/i,
    /\b(?:not true|not correct|contrary to claims|disputed by|rejected claims)\b/i
  ];
  const mixedPatterns = [
    /\b(?:partially true|mixed reports|unclear whether|contested|debated|partly true|conflicting claims|some dispute)\b/i
  ];
  const predicatePatterns: RegExp[] = [
    /\b(?:fall|falls|fell|falling|decline|declined|decrease|decreased|drop|dropped|remain|remained)\b/i,
    /\b(?:raise|raised|raising|increase|increased|increasing|hike|hiked|cut|cuts|cutting|lower|lowered|reduce|reduced|reduction)\b/i,
    /\b(?:open|opened|opening)\b/i,
    /\b(?:find|found|finding)\b/i,
    /\b(?:publish|published|publishing|release|released)\b/i,
    /\b(?:convict|convicted|conviction)\b/i,
    /\b(?:add|added|adding)\b/i,
    /\b(?:issue|issued|issuing)\b/i,
    /\b(?:recall|recalled)\b/i,
    /\b(?:report|reported|reporting)\b/i,
    /\b(?:land|lands|landed|landing)\b/i,
    /\b(?:win|wins|won|lose|loses|lost|qualify|qualified)\b/i,
    /\b(?:approve|approved|reject|rejected|sign|signed|pass|passed)\b/i
  ];
  const directionalPairs: Array<{
    claimSide: RegExp;
    evidenceOpposite: RegExp;
    evidenceClaimSide: RegExp;
  }> = [
    {
      claimSide: /\b(?:fall|fell|declined|decreased|dropped|below|under|less than)\b/i,
      evidenceOpposite: /\b(?:rose|increased|grew|gained|exceeded|above|over|more than)\b/i,
      evidenceClaimSide: /\b(?:fall|fell|declined|decreased|dropped|below|under|less than)\b/i
    },
    {
      claimSide: /\b(?:raised|raise|increased|hiked|increase|increasing)\b/i,
      evidenceOpposite: /\b(?:cut|cutting|lowered|lower|decreased|reduced|reduction)\b/i,
      evidenceClaimSide: /\b(?:raised|raise|increased|hiked|increase|increasing)\b/i
    },
    {
      claimSide: /\b(?:convicted|conviction|guilty)\b/i,
      evidenceOpposite: /\b(?:acquitted|acquittal|not guilty)\b/i,
      evidenceClaimSide: /\b(?:convicted|conviction|guilty)\b/i
    },
    {
      claimSide: /\b(?:opened|open|launched|launch|landed|land)\b/i,
      evidenceOpposite: /\b(?:closed|shut|delayed|postponed|cancelled|canceled|did not land|never landed)\b/i,
      evidenceClaimSide: /\b(?:opened|open|launched|launch|landed|land)\b/i
    },
    {
      claimSide: /\b(?:added|add|introduced)\b/i,
      evidenceOpposite: /\b(?:removed|remove|did not add|no new)\b/i,
      evidenceClaimSide: /\b(?:added|add|introduced)\b/i
    }
  ];

  // Generic words like "false", "denied", or a mismatching number can occur
  // anywhere in a long publisher page. Only classify a sentence directionally
  // when it overlaps the claim's actual content and contains a claim predicate,
  // a known directional opposite, or a strongly anchored explicit refutation.
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those',
    'was', 'were', 'are', 'is', 'has', 'have', 'had', 'did', 'does', 'do',
    'not', 'but', 'its', 'their', 'they', 'them', 'there', 'here', 'into',
    'onto', 'over', 'under', 'than', 'then', 'when', 'where', 'what', 'which',
    'who', 'why', 'how', 'all', 'any', 'some', 'more', 'most', 'less', 'very',
    'in', 'on', 'at', 'by', 'to', 'of', 'as', 'an', 'a', 'or', 'be', 'been',
    'being', 'it', 'he', 'she', 'we', 'you', 'i', 'they', 'year', 'month'
  ]);
  const claimTokens = new Set(
    (claim.normalizedText.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)?/g) || [])
      .filter(token => token.length > 2 && !stopWords.has(token))
  );
  const claimEntities = claim.entities.filter(entity => entity.trim().length > 0);
  const claimPredicates = predicatePatterns.filter(pattern => pattern.test(claim.normalizedText));
  const applicableDirectionalPairs = directionalPairs.filter(pair => pair.claimSide.test(claim.normalizedText));
  const sentences = snippet
    .split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);

  const relevantSentences = sentences.filter(sentence => {
    const lower = sentence.toLowerCase();
    const sentenceTokens = new Set(lower.match(/[a-z0-9]+(?:\.[0-9]+)?/g) || []);
    const anchorMatches = [...claimTokens].filter(token => sentenceTokens.has(token)).length;
    const entityMatches = claimEntities.some(entity => lower.includes(entity.toLowerCase()));
    const matchingClaimNumber = claim.numbers.some(number => {
      const numberTokens = number.match(/\d+(?:\.\d+)?/g) || [];
      return numberTokens.length > 0 && numberTokens.every(token => sentenceTokens.has(token));
    });
    const matchingClaimDate = claim.dates.some(date => lower.includes(date.toLowerCase()));
    // Numbered entities identify a distinct subject (e.g. Apollo 11 vs Apollo 12).
    // Matching only the shared year, planet, or generic entity word must not let
    // a different numbered subject generate a directional relation.
    const numberedEntityPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+\d+\b/g;
    // The heuristic entity extractor can turn "Apollo 11" into "The Apollo"
    // because the numeric suffix isn't a capitalized word. Recover numbered
    // identifiers from the original claim text as well as the entity list.
    const numberedEntityCandidates = [
      ...claimEntities.filter(entity => /\b[A-Za-z][A-Za-z0-9-]*\s+\d+\b/.test(entity)),
      ...(claim.originalText.match(numberedEntityPattern) || []),
      ...(claim.normalizedText.match(numberedEntityPattern) || [])
    ].map(entity => entity.toLowerCase().replace(/\s+/g, ' ').trim());
    const numberedEntities = [...new Set(numberedEntityCandidates)];
    const exactNumberedEntityMatch = numberedEntities.some(entity => lower.includes(entity));
    const specificIdentifierMatches = numberedEntities.length > 0
      ? exactNumberedEntityMatch
      : entityMatches || matchingClaimNumber || matchingClaimDate;
    const predicateMatches = claimPredicates.some(pattern => pattern.test(sentence));
    const directionalOppositeMatches = applicableDirectionalPairs.some(pair => pair.evidenceOpposite.test(sentence));
    const explicitRefutation = contradictionPatterns.some(pattern => pattern.test(sentence));
    const explicitMixed = mixedPatterns.some(pattern => pattern.test(sentence));

    const anchoredFact = anchorMatches >= 2 ||
      (entityMatches && anchorMatches >= 1) ||
      (predicateMatches && anchorMatches >= 1);
    const claimLinkedSignal =
      predicateMatches ||
      (directionalOppositeMatches && (!claim.numbers.length && !claim.dates.length || specificIdentifierMatches)) ||
      ((explicitRefutation || explicitMixed) &&
        (anchorMatches >= 3 || (entityMatches && specificIdentifierMatches)));
    const needsSpecificIdentifier =
      claim.entities.length > 0 || claim.numbers.length > 0 || claim.dates.length > 0;

    // For claims containing named entities, dates or figures, a related noun
    // plus a generic opposite word is not enough. Require a match to the
    // particular entity/number/date before any directional signal is admitted.
    return anchoredFact && claimLinkedSignal &&
      (!needsSpecificIdentifier || specificIdentifierMatches);
  });

  if (relevantSentences.length === 0) {
    // A title/keyword overlap alone is not evidence that the page supports or
    // contradicts this specific assertion.
    return 'INSUFFICIENT';
  }

  const relationText = relevantSentences.join(' ');
  const textLower = relationText.toLowerCase();

  // Re-run the numeric check on only claim-linked sentences. Numbers elsewhere
  // in an article (for other events or years) must not refute this claim.
  const contextualNumericalConsistency = checkNumericalConsistency(claim, relationText);
  if (!contextualNumericalConsistency.isConsistent) {
    return 'CONTRADICTS';
  }

  for (const pat of contradictionPatterns) {
    if (pat.test(textLower)) {
      return 'CONTRADICTS';
    }
  }

  const hasNegatedPredicate = claimPredicates.some(predicate => {
    const source = predicate.source.replace(/^\\b|\\b$/g, '');
    const directNegation = new RegExp(
      '\\b(?:did|does|do|was|were|is|are|has|have|had)\\s+not\\s+(?:\\w+\\s+){0,2}' + source + '\\b',
      'i'
    );
    const localNegation = new RegExp('\\bnot\\s+' + source + '\\b', 'i');
    const absoluteNegation = new RegExp(
      '\\b(?:no|never)\\s+(?:\\w+\\s+){0,2}' + source + '\\b',
      'i'
    );
    return directNegation.test(textLower) ||
      localNegation.test(textLower) ||
      absoluteNegation.test(textLower);
  });
  if (hasNegatedPredicate) {
    return 'CONTRADICTS';
  }

  for (const pair of applicableDirectionalPairs) {
    if (pair.evidenceOpposite.test(textLower) && !pair.evidenceClaimSide.test(textLower)) {
      return 'CONTRADICTS';
    }
  }

  for (const pat of mixedPatterns) {
    if (pat.test(textLower)) {
      return 'MIXED';
    }
  }

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
function normalizeForFingerprint(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\b(?:read more|click here|subscribe|sign up|advertisement|copyright)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function contentClusterKey(item: EvidenceItem): string {
  const title = normalizeForFingerprint(item.title).slice(0, 220);
  const body = normalizeForFingerprint(item.evidenceExcerpt || item.snippet).slice(0, 360);
  const wire = item.isSyndicated ||
    /\b(?:reuters|ap news|associated press|afp|agence france presse|bloomberg)\b/i.test(
      `${item.sourceName} ${item.title} ${item.snippet}`
    );
  if (wire && body.length >= 80) return `wire:${fnv1a(body)}`;
  if (body.length >= 160) return `body:${fnv1a(body)}`;
  if (title.length >= 40) return `title:${fnv1a(title)}`;
  return `weak:${fnv1a(title + '|' + body)}`;
}

function shingleSet(text: string, width = 5): Set<string> {
  const words = normalizeForFingerprint(text).split(/\s+/).filter(Boolean);
  const set = new Set<string>();
  if (words.length === 0) return set;
  if (words.length <= width) {
    set.add(words.join(' '));
    return set;
  }
  for (let i = 0; i <= words.length - width; i++) {
    set.add(words.slice(i, i + width).join(' '));
  }
  return set;
}

function shingleSimilarity(a: string, b: string): number {
  const aa = shingleSet(a);
  const bb = shingleSet(b);
  if (aa.size === 0 || bb.size === 0) return 0;
  let overlap = 0;
  for (const item of aa) if (bb.has(item)) overlap++;
  return overlap / (aa.size + bb.size - overlap);
}

export function evaluateSourceDiversity(evidenceList: EvidenceItem[]): {
  independentSourcesCount: number;
  totalSourcesCount: number;
  syndicationNote?: string;
} {
  if (evidenceList.length === 0) {
    return { independentSourcesCount: 0, totalSourcesCount: 0 };
  }

  const uniqueDomains = new Set<string>();
  const domainByItem: string[] = [];
  const clusterByItem: string[] = [];
  const clusterToDomains = new Map<string, Set<string>>();
  const clusterRepresentative = new Map<string, string>();
  let syndicatedCount = 0;
  let nearDuplicateCount = 0;

  for (const item of evidenceList) {
    let domain = item.sourceName.toLowerCase().trim() || 'unknown-source';
    try {
      const canonicalSourceUrl = item.sourceFinalUrl || item.sourceUrl;
      domain = new URL(canonicalSourceUrl.startsWith('http') ? canonicalSourceUrl : `https://${canonicalSourceUrl}`).hostname
        .toLowerCase()
        .replace(/^www\./, '');
    } catch {
      /* keep source-name fallback */
    }

    const sourceText = `${item.title} ${item.evidenceExcerpt || item.snippet}`;
    const key = contentClusterKey(item);
    const wire = item.isSyndicated ||
      /\b(?:reuters|ap news|associated press|afp|agence france presse|bloomberg)\b/i.test(
        `${item.sourceName} ${item.title} ${item.snippet}`
      );

    let clusterId = key;
    // 5-gram Jaccard is intentionally conservative but must still catch
    // lightly edited wire/copy stories. Keep wire content stricter while
    // allowing near-duplicate reporting with small editorial changes.
    const similarityThreshold = wire ? 0.68 : 0.72;
    for (const [candidateId, representative] of clusterRepresentative.entries()) {
      if (shingleSimilarity(sourceText, representative) >= similarityThreshold) {
        clusterId = candidateId;
        nearDuplicateCount++;
        break;
      }
    }
    clusterRepresentative.set(clusterId, clusterRepresentative.get(clusterId) || sourceText);
    domainByItem.push(domain);
    clusterByItem.push(clusterId);
    if (!clusterToDomains.has(clusterId)) clusterToDomains.set(clusterId, new Set<string>());
    clusterToDomains.get(clusterId)!.add(domain);
    uniqueDomains.add(domain);

    const text = `${item.sourceName} ${item.title} ${item.snippet}`;
    if (wire) syndicatedCount++;
  }

  // A content cluster represents one underlying report. Distinct domains inside
  // the same cluster are reproduction/syndication until the evidence is
  // materially different; independence cannot exceed distinct domains.
  const clusterCount = clusterToDomains.size;
  const independentCount = Math.min(uniqueDomains.size, clusterCount);
  const wireClusterCount = Array.from(clusterToDomains.entries()).filter(([key, domains]) =>
    key.startsWith('wire:') && domains.size > 1
  ).length;

  let syndicationNote =
    `${independentCount} independent source cluster${independentCount !== 1 ? 's' : ''} across ${uniqueDomains.size} domain${uniqueDomains.size !== 1 ? 's' : ''}.`;
  if (wireClusterCount > 0 || syndicatedCount >= 2 || nearDuplicateCount > 0) {
    syndicationNote +=
      ` ${wireClusterCount || syndicatedCount} syndicated/wire reproduction signal(s) and ${nearDuplicateCount} near-duplicate cluster match(es) were discounted as non-independent confirmation.`;
  }

  return {
    independentSourcesCount: independentCount,
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
    const strongContradiction = relevantItems.some(item =>
      item.relation === 'CONTRADICTS' &&
      ['OFFICIAL_GOVERNMENT', 'OFFICIAL_ORGANIZATION', 'PRIMARY_SCIENTIFIC', 'MAJOR_NEWS', 'REPUTABLE_SOURCE'].includes(item.sourceType)
    );
    const contradictionThresholdMet = diversity.independentSourcesCount >= 2 || strongContradiction;
    if (!contradictionThresholdMet) {
      assessment = 'INSUFFICIENT';
      explanation = 'A contradiction was retrieved, but the available evidence does not meet the minimum independence/source-quality threshold for a negative factual assessment.';
      confidenceScore = 0.35;
      confidenceExplanation = 'One weak or non-independent contradiction is not sufficient for a strong conclusion.';
    } else {
      assessment = 'CONTRADICTED';
      explanation = numWarningItem?.numericalConsistency?.warning ||
        `Retrieved evidence directly refutes or contradicts the factual assertion (${counts.contradicts} source${counts.contradicts > 1 ? 's' : ''}).`;
      confidenceScore = Math.min(0.95, 0.60 + (diversity.independentSourcesCount * 0.15));
      confidenceExplanation = `Substantiated by ${diversity.independentSourcesCount} independent source(s) identifying factual disagreement.`;
    }
  } else if (counts.supports >= 1) {
    const strongSupport = relevantItems.some(item =>
      item.relation === 'SUPPORTS' &&
      ['OFFICIAL_GOVERNMENT', 'OFFICIAL_ORGANIZATION', 'PRIMARY_SCIENTIFIC', 'MAJOR_NEWS', 'REPUTABLE_SOURCE'].includes(item.sourceType)
    );
    const supportThresholdMet = diversity.independentSourcesCount >= 2 || strongSupport;
    if (!supportThresholdMet) {
      assessment = 'INSUFFICIENT';
      explanation = 'Supporting evidence was retrieved, but the available evidence does not meet the minimum independence/source-quality threshold for a positive factual assessment.';
      confidenceScore = 0.35;
      confidenceExplanation = 'A single weak or non-independent source is not sufficient for strong corroboration.';
    } else {
      assessment = 'SUPPORTED';
      explanation = `Retrieved external reporting corroborates the factual assertion across ${diversity.independentSourcesCount} independent source(s).`;
      confidenceScore = Math.min(0.95, 0.55 + (diversity.independentSourcesCount * 0.15));
      confidenceExplanation = `Corroborated by ${diversity.independentSourcesCount} reputable external reporting outlet(s).`;
    }
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
