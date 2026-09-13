import re
import string
from typing import List, Dict, Any, Tuple

# Built-in lightweight English stopwords list (standard scikit-learn/NLTK subset)
STOPWORDS = {
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren\'t',
    'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can',
    'cannot', 'could', 'couldn\'t', 'did', 'didn\'t', 'do', 'does', 'doesn\'t', 'doing', 'don\'t', 'down',
    'during', 'each', 'few', 'for', 'from', 'further', 'had', 'hadn\'t', 'has', 'hasn\'t', 'have', 'haven\'t',
    'having', 'he', 'he\'d', 'he\'ll', 'he\'s', 'her', 'here', 'here\'s', 'hers', 'herself', 'him', 'himself',
    'his', 'how', 'how\'s', 'i', 'i\'d', 'i\'ll', 'i\'m', 'i\'ve', 'if', 'in', 'into', 'is', 'isn\'t', 'it',
    'it\'s', 'its', 'itself', 'let\'s', 'me', 'more', 'most', 'mustn\'t', 'my', 'myself', 'no', 'nor', 'not',
    'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
    'same', 'shan\'t', 'she', 'she\'d', 'she\'ll', 'she\'s', 'should', 'shouldn\'t', 'so', 'some', 'such',
    'than', 'that', 'that\'s', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'there\'s',
    'these', 'they', 'they\'d', 'they\'ll', 'they\'re', 'they\'ve', 'this', 'those', 'through', 'to', 'too',
    'under', 'until', 'up', 'very', 'was', 'wasn\'t', 'we', 'we\'d', 'we\'ll', 'we\'re', 'we\'ve', 'were',
    'weren\'t', 'what', 'what\'s', 'when', 'when\'s', 'where', 'where\'s', 'which', 'while', 'who', 'who\'s',
    'whom', 'why', 'why\'s', 'with', 'won\'t', 'would', 'wouldn\'t', 'you', 'you\'d', 'you\'ll', 'you\'re',
    'you\'ve', 'your', 'yours', 'yourself', 'yourselves'
}

# Linguistic indicator lexicons
SENSATIONAL_TERMS = {
    'shocking', 'unbelievable', 'secret', 'exposed', 'censored', 'miracle', 'bombshell',
    'banned', 'terrifying', 'mind control', 'clones', 'whistleblower', 'alien', 'suppressed',
    'hidden truth', 'deep state', 'globalist', 'poisons', 'furious', 'wake up', 'conspiracy'
}

CERTAINTY_TERMS = {
    'guaranteed', '100%', 'never before', 'undeniable', 'proven fact', 'absolute proof',
    'every single', 'cure all', 'miracle cure', 'completely destroys'
}

CREDIBILITY_MARKERS = {
    'according to', 'published in', 'spokesperson stated', 'official statement', 'clinical trial',
    'peer-reviewed', 'data indicates', 'department announced', 'preliminary findings', 'reiterated'
}

def clean_text(text: str, remove_stopwords: bool = True) -> str:
    """
    Standard text preprocessor used symmetrically during both training and inference.
    - Lowers case
    - Strips URLs
    - Normalizes multiple spaces and line breaks
    - Removes punctuation while keeping word boundaries
    - Strips numbers or standardizes
    - Removes stopwords if requested
    """
    if not isinstance(text, str):
        return ""
    
    # Lowercase
    cleaned = text.lower()
    
    # Strip URLs
    cleaned = re.sub(r'https?://\S+|www\.\S+', ' ', cleaned)
    
    # Strip HTML tags if any
    cleaned = re.sub(r'<.*?>', ' ', cleaned)
    
    # Remove punctuation
    cleaned = re.sub(r'[%s]' % re.escape(string.punctuation), ' ', cleaned)
    
    # Normalize whitespaces
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    
    if remove_stopwords:
        tokens = cleaned.split()
        tokens = [token for token in tokens if token not in STOPWORDS and len(token) > 2]
        cleaned = " ".join(tokens)
        
    return cleaned

def extract_linguistic_indicators(raw_text: str, source_url: str = "") -> List[Dict[str, Any]]:
    """
    Extracts transparent, explainable linguistic and structural signals.
    Note: These indicators are framed as 'contributing signals' and 'model indicators',
    not definitive proof of falsehood.
    """
    indicators = []
    
    if not raw_text or len(raw_text.strip()) == 0:
        return indicators
        
    words = raw_text.split()
    total_words = max(len(words), 1)
    
    # 1. Excessive Capitalization Analysis
    all_caps_words = [w for w in words if len(w) > 2 and w.isupper() and w.isalpha()]
    caps_ratio = len(all_caps_words) / total_words
    if caps_ratio > 0.10:
        indicators.append({
            "name": "Excessive Capitalization",
            "type": "structural",
            "signal": "warning",
            "score": round(caps_ratio * 100, 1),
            "description": f"Detected {len(all_caps_words)} words in ALL-CAPS ({round(caps_ratio * 100)}% of content), often characteristic of clickbait or urgency-driven writing.",
            "examples": all_caps_words[:4]
        })
    elif caps_ratio > 0.04:
        indicators.append({
            "name": "Moderate Capitalization",
            "type": "structural",
            "signal": "caution",
            "score": round(caps_ratio * 100, 1),
            "description": f"Elevated frequency of capitalized emphasis words ({round(caps_ratio * 100)}%).",
            "examples": all_caps_words[:3]
        })
        
    # 2. Punctuation Intensity (Exclamation marks & question marks)
    exclamations = raw_text.count('!')
    questions = raw_text.count('?')
    repeated_punct = len(re.findall(r'[!?]{2,}', raw_text))
    
    if exclamations >= 3 or repeated_punct > 0:
        indicators.append({
            "name": "Intense / Repeated Punctuation",
            "type": "stylistic",
            "signal": "warning" if repeated_punct > 0 or exclamations > 5 else "caution",
            "score": exclamations + questions,
            "description": f"Found {exclamations} exclamation marks and {repeated_punct} instances of repeated punctuation ('!!', '??'), which frequently signals emotional agitation rather than neutral reporting.",
            "examples": re.findall(r'[!?]{2,}', raw_text)[:3] or ["!"]
        })
        
    # 3. Sensational Lexicon Scan
    lower_text = raw_text.lower()
    matched_sensational = [term for term in SENSATIONAL_TERMS if term in lower_text]
    if matched_sensational:
        indicators.append({
            "name": "Sensationalist & Hyperbolic Terms",
            "type": "lexical",
            "signal": "warning" if len(matched_sensational) >= 2 else "caution",
            "score": len(matched_sensational),
            "description": f"Identified {len(matched_sensational)} high-arousal sensational terms known to correlate with unverified or conspiratorial claims.",
            "examples": matched_sensational[:5]
        })
        
    # 4. Absolute Certainty / Unsupported Urgency
    matched_certainty = [term for term in CERTAINTY_TERMS if term in lower_text]
    if matched_certainty:
        indicators.append({
            "name": "Absolute Certainty Claims",
            "type": "lexical",
            "signal": "warning",
            "score": len(matched_certainty),
            "description": "Uses unqualified absolute certainty phrases (e.g. '100%', 'guaranteed', 'cure all') that deviate from standard qualified scientific and journalistic attribution.",
            "examples": matched_certainty[:4]
        })
        
    # 5. Presence of Credible Journalistic Markers
    matched_credibility = [term for term in CREDIBILITY_MARKERS if term in lower_text]
    if matched_credibility:
        indicators.append({
            "name": "Attribution & Journalistic Hedging",
            "type": "verifiability",
            "signal": "positive",
            "score": len(matched_credibility),
            "description": f"Contains {len(matched_credibility)} institutional attribution phrases ('according to', 'published in', 'official statement') typical of established news reporting.",
            "examples": matched_credibility[:4]
        })
        
    # 6. Source URL Check
    if not source_url or not source_url.strip():
        indicators.append({
            "name": "Source Attribution Absent",
            "type": "metadata",
            "signal": "caution",
            "score": 0,
            "description": "No original source URL was provided. Unattributed text carries higher evaluation uncertainty.",
            "examples": []
        })
    else:
        # Extract basic domain
        domain_match = re.search(r'https?://([^/]+)', source_url)
        domain = domain_match.group(1) if domain_match else source_url
        indicators.append({
            "name": "Source URL Metadata Provided",
            "type": "metadata",
            "signal": "info",
            "score": 1,
            "description": f"Domain identified as '{domain}'. Note: Domain credibility could not be independently verified.",
            "examples": [domain]
        })
        
    return indicators
