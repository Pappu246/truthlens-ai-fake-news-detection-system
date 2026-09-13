import { ExtractedClaim, ClaimType, ClaimImportance } from '../../src/types';
import { GoogleGenAI } from '@google/genai';

export interface ClaimExtractionResult {
  has_claim: boolean;
  detected_claim: string;
  confidence: number;
  method: string;
}

const CLAIM_INTRO_PATTERNS = [
  /(?:claims?|claimed|claiming)\s+that\s+([^.!?]+)/i,
  /(?:alleges?|alleged|alleging)\s+that\s+([^.!?]+)/i,
  /(?:confirms?|confirmed|confirming)\s+that\s+([^.!?]+)/i,
  /(?:reports?|reported|reporting)\s+that\s+([^.!?]+)/i,
  /(?:stated?|states?|stating)\s+that\s+([^.!?]+)/i,
  /(?:announced?|announces?|announcing)\s+that\s+([^.!?]+)/i,
  /(?:reveals?|revealed|revealing)\s+that\s+([^.!?]+)/i,
  /(?:warns?|warned|warning)\s+that\s+([^.!?]+)/i,
  /(?:discovered?|discovers?)\s+that\s+([^.!?]+)/i,
  /(?:found?|finds?)\s+that\s+([^.!?]+)/i,
];

// Patterns representing non-claims or pure opinion / emotional fluff
const NON_CLAIM_PATTERNS = [
  /^(?:this is|it is|that is)\s+(?:shocking|unbelievable|terrible|awesome|great|crazy|insane|wild|absurd)/i,
  /^(?:people|citizens|voters|users|critics)\s+are\s+(?:furious|angry|shocked|celebrating|outraged|crying|divided)/i,
  /^(?:i think|i believe|in my opinion|many believe|some say|it seems to me)/i,
  /^(?:this may be|this could be|this might be)\s+the\s+(?:biggest|worst|best|most incredible)\s+event\s+ever/i,
  /^(?:wow|unbelievable|omg|look at this|must see|breaking|exclusive)[:!]?$/i,
  /^(?:click here|read more|subscribe|share this|follow us)/i
];

const CATEGORY_KEYWORDS: Record<ClaimType, RegExp[]> = {
  'Government / Policy': [
    /\b(?:government|ministry|parliament|congress|senate|bill|legislation|policy|executive order|cabinet|regulator|sanction|subsidy|official announcement)\b/i
  ],
  'Politics': [
    /\b(?:election|president|prime minister|campaign|party|democrat|republican|poll|vote|candidate|parliamentary|governor|mayor)\b/i
  ],
  'Science': [
    /\b(?:nasa|space|telescope|astronomer|physics|quantum|planet|galaxy|climate|fossil|study|experiment|laboratory|researchers found|discovery)\b/i
  ],
  'Health': [
    /\b(?:vaccine|hospital|who|cdc|disease|virus|fda|clinical trial|treatment|patient|infection|medicine|cancer|drug|surgeon)\b/i
  ],
  'Economics': [
    /\b(?:inflation|gdp|unemployment|interest rate|central bank|federal reserve|economic growth|recession|trade deficit|consumer price)\b/i
  ],
  'Finance': [
    /\b(?:stock|wall street|shares|nasdaq|dow|bitcoin|crypto|banking|acquisition|market cap|quarterly revenue|dividend|investment)\b/i
  ],
  'Technology': [
    /\b(?:ai|software|hardware|apple|google|microsoft|chip|semiconductor|cybersecurity|algorithm|smartphone|cloud|app|operating system)\b/i
  ],
  'Crime': [
    /\b(?:police|arrested|court|convicted|judge|prison|investigation|prosecutor|fbi|theft|murder|fraud|smuggling|guilty|lawsuit)\b/i
  ],
  'International': [
    /\b(?:united nations|un|treaty|diplomat|nato|ambassador|foreign minister|border|international court|sovereignty|bilateral)\b/i
  ],
  'Environment': [
    /\b(?:emission|deforestation|wildfire|hurricane|renewable|solar|pollution|biodiversity|glacier|conservation|carbon)\b/i
  ],
  'Statistics': [
    /\b(?:\d+%\s+(?:increase|decrease|rise|drop|surge|fall)|survey of \d+|statistic|ratio|proportion of \d+|percentage points)\b/i
  ],
  'Historical': [
    /\b(?:in (?:19\d\d|18\d\d|200\d|201\d)|century|historical record|decades ago|world war|ancient|treaty of \d{4})\b/i
  ],
  'Other': []
};

// Known common locations
const COMMON_LOCATIONS = [
  'united states', 'us', 'usa', 'united kingdom', 'uk', 'britain', 'china', 'india', 'russia',
  'ukraine', 'germany', 'france', 'japan', 'canada', 'australia', 'brazil', 'israel', 'iran',
  'washington', 'london', 'beijing', 'delhi', 'moscow', 'tokyo', 'paris', 'berlin', 'kyiv', 'geneva',
  'california', 'texas', 'florida', 'new york', 'europe', 'asia', 'africa', 'middle east'
];

/**
 * Extracts individual named entities, numbers, dates, locations, and keywords from a sentence.
 */
function extractClaimComponents(sentence: string): {
  entities: string[];
  dates: string[];
  locations: string[];
  numbers: string[];
  keywords: string[];
} {
  const entities: string[] = [];
  const dates: string[] = [];
  const locations: string[] = [];
  const numbers: string[] = [];
  const keywords: string[] = [];

  // 1. Numbers / Statistics / Currencies / Percentages
  const numberMatches = sentence.match(/(?:[\$€£₹¥]\s*[\d,.]+(?:\s*(?:billion|million|trillion|lakh|crore))?|\b\d+(?:\.\d+)?%|\b\d+(?:,\d+)*(?:\.\d+)?\s*(?:hours?|days?|months?|years?|percent|people|dollars|tonnes?|miles?|km)?\b)/gi);
  if (numberMatches) {
    for (const num of numberMatches) {
      const clean = num.trim();
      if (!numbers.includes(clean) && clean.length > 0) numbers.push(clean);
    }
  }

  // 2. Dates / Temporal markers
  const dateMatches = sentence.match(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:yesterday|today|tomorrow|last week|next month|from tomorrow|starting tomorrow|in \d{4})\b/gi);
  if (dateMatches) {
    for (const d of dateMatches) {
      const clean = d.trim();
      if (!dates.includes(clean)) dates.push(clean);
    }
  }

  // 3. Locations
  const lowerSentence = sentence.toLowerCase();
  for (const loc of COMMON_LOCATIONS) {
    const regex = new RegExp(`\\b${loc}\\b`, 'i');
    if (regex.test(lowerSentence)) {
      const proper = loc.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      if (!locations.includes(proper)) locations.push(proper);
    }
  }

  // 4. Entities (Capitalized proper nouns of 2+ words or known acronyms)
  const entityMatches = sentence.match(/\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+|[A-Z]{2,6})\b/g);
  if (entityMatches) {
    for (const ent of entityMatches) {
      const clean = ent.trim();
      // Filter out sentence starters that are not entities
      if (!['This Is', 'There Are', 'In The', 'According To', 'It Was'].includes(clean)) {
        if (!entities.includes(clean)) entities.push(clean);
      }
    }
  }

  // 5. Salient Keywords
  const words = sentence
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 3 && !['that', 'with', 'from', 'this', 'have', 'were', 'which', 'their', 'about', 'after', 'said', 'says', 'will', 'would', 'could'].includes(w));

  for (const w of words) {
    if (!keywords.includes(w) && keywords.length < 8) {
      keywords.push(w);
    }
  }

  return { entities, dates, locations, numbers, keywords };
}

/**
 * Classifies a claim into one of the 13 required standard categories.
 */
export function classifyClaimType(text: string): ClaimType {
  for (const [type, patterns] of Object.entries(CATEGORY_KEYWORDS) as [ClaimType, RegExp[]][]) {
    if (type === 'Other') continue;
    for (const p of patterns) {
      if (p.test(text)) {
        return type;
      }
    }
  }
  return 'Other';
}

/**
 * Normalizes a raw claim sentence into a clean, canonical declarative assertion
 * without modifying factual meaning or introducing external facts.
 */
export function normalizeClaimText(rawSentence: string): string {
  let text = rawSentence.trim();

  // Remove leading conversational attributions or quotes
  text = text.replace(/^(?:the\s+)?(?:government|officials?|spokesperson|police|company)\s+(?:says?|said|stated?|claims?|claimed|announced?)\s+(?:that\s+)?/i, (match) => {
    // Preserve subject if it was government or police
    if (/government/i.test(match)) return 'The government announced ';
    return '';
  });

  // Clean trailing punctuation and quotes
  text = text.replace(/^["'\u201c\u201d\s]+|["'\u201c\u201d\s]+$/g, '');
  text = text.replace(/\s+/g, ' ');

  // Ensure first letter capitalized
  if (text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  if (!/[.!?]$/.test(text)) {
    text += '.';
  }

  return text;
}

/**
 * Generates 2-3 focused search queries for verifying a specific claim.
 * Queries preserve entities, dates, numbers, and key actions while omitting fluff.
 */
export function generateSearchQueries(claim: {
  normalizedText: string;
  entities: string[];
  numbers: string[];
  dates: string[];
  locations?: string[];
  keywords: string[];
}): string[] {
  const queries: string[] = [];

  // Query 1: Entity + Action + Numbers
  const q1Parts: string[] = [];
  if (claim.entities.length > 0) q1Parts.push(claim.entities.slice(0, 2).join(' '));
  if (claim.numbers.length > 0) q1Parts.push(claim.numbers[0]);
  if (claim.keywords.length > 0) q1Parts.push(claim.keywords.slice(0, 3).join(' '));

  if (q1Parts.length > 0) {
    queries.push(q1Parts.join(' ').replace(/[^\w\s$%€£₹.]/g, '').trim());
  }

  // Query 2: Direct salient search phrase from normalized text
  const cleanTokens = claim.normalizedText
    .replace(/[^\w\s$%€£₹.]/g, '')
    .split(/\s+/)
    .filter(t => !['the', 'a', 'an', 'is', 'was', 'are', 'were', 'to', 'in', 'of', 'and', 'for', 'by', 'on', 'with', 'from'].includes(t.toLowerCase()))
    .slice(0, 7)
    .join(' ');

  if (cleanTokens && !queries.includes(cleanTokens)) {
    queries.push(cleanTokens);
  }

  // Query 3: Entity + Topic + Date / official announcement
  if (claim.entities.length > 0 && claim.dates.length > 0) {
    const q3 = `${claim.entities[0]} ${claim.keywords.slice(0, 2).join(' ')} ${claim.dates[0]}`.trim();
    if (!queries.includes(q3)) queries.push(q3);
  } else if (claim.entities.length > 0) {
    const q3 = `${claim.entities[0]} official announcement ${claim.keywords.slice(0, 2).join(' ')}`.trim();
    if (!queries.includes(q3)) queries.push(q3);
  }

  return queries.filter(q => q.length > 5).slice(0, 3);
}

/**
 * Deterministic rule-based claim extraction from title, body, and description.
 */
export function extractClaimsHeuristic(
  title: string = '',
  body: string = '',
  description: string = ''
): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  let claimIndex = 1;

  // 1. Check title for high-priority claim
  const titleClean = title.trim();
  if (titleClean.length >= 15 && !NON_CLAIM_PATTERNS.some(p => p.test(titleClean))) {
    const comp = extractClaimComponents(titleClean);
    const norm = normalizeClaimText(titleClean);
    const cType = classifyClaimType(titleClean);
    const searchQueries = generateSearchQueries({
      normalizedText: norm,
      ...comp
    });

    claims.push({
      claimId: `claim-${claimIndex++}`,
      originalText: titleClean,
      normalizedText: norm,
      claimType: cType,
      importance: 'HIGH',
      entities: comp.entities,
      dates: comp.dates,
      locations: comp.locations,
      numbers: comp.numbers,
      keywords: comp.keywords,
      searchQueries
    });
  }

  // 2. Parse sentences in body
  const rawSentences = body
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 25 && s.length <= 300);

  for (let i = 0; i < rawSentences.length && claims.length < 6; i++) {
    const sentence = rawSentences[i];

    // Filter out boilerplate or pure opinion
    if (NON_CLAIM_PATTERNS.some(p => p.test(sentence))) continue;
    if (/^(?:share|comment|advertisement|copyright|all rights reserved|source:)/i.test(sentence)) continue;

    // Check if sentence makes a verifiable factual assertion
    const comp = extractClaimComponents(sentence);
    const hasNumbers = comp.numbers.length > 0;
    const hasEntities = comp.entities.length > 0;
    const hasDates = comp.dates.length > 0;
    const hasAssertionVerb = /\b(?:announced?|confirmed?|reported?|stated?|passed?|approved?|launched?|discovered?|signed?|voted?|increased?|decreased?|fell|rose|dropped?|arrested?|revealed?|published?)\b/i.test(sentence);

    // Only extract sentences with concrete factual indicators
    if ((hasNumbers && (hasEntities || hasAssertionVerb)) || (hasEntities && hasAssertionVerb) || (hasDates && hasAssertionVerb)) {
      // Avoid duplicate claims
      const norm = normalizeClaimText(sentence);
      if (claims.some(c => c.normalizedText.toLowerCase() === norm.toLowerCase())) continue;

      let importance: ClaimImportance = 'MEDIUM';
      if (i === 0 && claims.length === 0) {
        importance = 'HIGH';
      } else if (i > 4 && !hasNumbers) {
        importance = 'LOW';
      }

      const cType = classifyClaimType(sentence);
      const searchQueries = generateSearchQueries({
        normalizedText: norm,
        ...comp
      });

      claims.push({
        claimId: `claim-${claimIndex++}`,
        originalText: sentence,
        normalizedText: norm,
        claimType: cType,
        importance,
        entities: comp.entities,
        dates: comp.dates,
        locations: comp.locations,
        numbers: comp.numbers,
        keywords: comp.keywords,
        searchQueries
      });
    }
  }

  // If no claims met the strict criteria, fall back to the first declarative sentence
  if (claims.length === 0 && (body.trim().length > 20 || title.trim().length > 10)) {
    const fallbackText = title.trim() || body.trim().slice(0, 150);
    const comp = extractClaimComponents(fallbackText);
    const norm = normalizeClaimText(fallbackText);
    claims.push({
      claimId: `claim-1`,
      originalText: fallbackText,
      normalizedText: norm,
      claimType: classifyClaimType(fallbackText),
      importance: 'HIGH',
      entities: comp.entities,
      dates: comp.dates,
      locations: comp.locations,
      numbers: comp.numbers,
      keywords: comp.keywords,
      searchQueries: generateSearchQueries({ normalizedText: norm, ...comp })
    });
  }

  return claims;
}

/**
 * Main claim extraction service.
 * Supports Gemini-powered extraction when configured, with seamless fallback
 * to rule-based deterministic NLP.
 */
export async function extractClaims(
  title: string = '',
  body: string = '',
  description: string = ''
): Promise<ExtractedClaim[]> {
  // If Gemini API Key is available, attempt AI-assisted extraction
  if (process.env.GEMINI_API_KEY) {
    try {
      const ai = new GoogleGenAI();
      const prompt = `You are a precision factual claim extractor for a journalistic verification system.
Extract between 1 and 4 verifiable, factual claims from the following news text.

Guidelines:
- Extract concrete, checkable factual assertions (who did what, statistics, official decisions, actions).
- DO NOT extract subjective opinions, emotion ("this is shocking"), or rhetoric.
- Classify into one of: 'Government / Policy', 'Politics', 'Science', 'Health', 'Economics', 'Finance', 'Technology', 'Crime', 'International', 'Environment', 'Statistics', 'Historical', 'Other'.
- Assign importance: 'HIGH', 'MEDIUM', or 'LOW'.
- DO NOT invent or extrapolate facts not in the text.

Article Title: "${title}"
Article Description: "${description}"
Article Text:
"""
${body.slice(0, 2500)}
"""

Return JSON ONLY as an array of objects matching this exact schema:
[
  {
    "claimId": "claim-1",
    "originalText": "exact text from article",
    "normalizedText": "concise factual declarative statement without altering meaning",
    "claimType": "Science",
    "importance": "HIGH",
    "entities": ["NASA", "James Webb"],
    "dates": ["Tuesday"],
    "locations": ["Cape Canaveral"],
    "numbers": ["20%"],
    "keywords": ["space", "mission", "fuel"],
    "searchQueries": ["NASA launch Tuesday fuel", "NASA mission announcement"]
  }
]`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const responseText = response.text?.trim() || '';
      if (responseText) {
        const parsed = JSON.parse(responseText);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((item, idx) => ({
            claimId: item.claimId || `claim-${idx + 1}`,
            originalText: item.originalText || title || '',
            normalizedText: item.normalizedText || item.originalText || '',
            claimType: item.claimType || 'Other',
            importance: item.importance || (idx === 0 ? 'HIGH' : 'MEDIUM'),
            entities: Array.isArray(item.entities) ? item.entities : [],
            dates: Array.isArray(item.dates) ? item.dates : [],
            locations: Array.isArray(item.locations) ? item.locations : [],
            numbers: Array.isArray(item.numbers) ? item.numbers : [],
            keywords: Array.isArray(item.keywords) ? item.keywords : [],
            searchQueries: Array.isArray(item.searchQueries) ? item.searchQueries : generateSearchQueries({
              normalizedText: item.normalizedText || '',
              entities: item.entities || [],
              dates: item.dates || [],
              locations: item.locations || [],
              numbers: item.numbers || [],
              keywords: item.keywords || []
            })
          }));
        }
      }
    } catch (err: any) {
      console.warn('[ClaimExtractor] Gemini extraction fallback to deterministic NLP:', err.message);
    }
  }

  // Fallback to deterministic NLP extraction
  return extractClaimsHeuristic(title, body, description);
}

/**
 * Backward compatibility with existing ML engine call
 */
export function extractPrimaryClaim(rawText: string): ClaimExtractionResult {
  if (!rawText || rawText.trim().length < 20) {
    return {
      has_claim: false,
      detected_claim: 'Specific factual claim could not be confidently identified.',
      confidence: 0,
      method: 'insufficient_text'
    };
  }

  const claims = extractClaimsHeuristic('', rawText);
  if (claims.length > 0) {
    return {
      has_claim: true,
      detected_claim: claims[0].normalizedText,
      confidence: claims[0].importance === 'HIGH' ? 0.85 : 0.72,
      method: 'claim_extractor_v4'
    };
  }

  return {
    has_claim: false,
    detected_claim: 'Specific factual claim could not be confidently identified.',
    confidence: 0,
    method: 'heuristic_fallback'
  };
}

