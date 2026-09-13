"""
TruthLens AI - Claim Extraction Module
Extracts the primary factual assertion from news articles using deterministic linguistic patterns
(hedging, reported speech, subject-verb-object structures, assertion keywords).
"""

import re
from typing import Optional, Dict, Any

CLAIM_INTRO_PATTERNS = [
    r"(?:claims?|claimed|claiming)\s+that\s+([^.!?]+)",
    r"(?:alleges?|alleged|alleging)\s+that\s+([^.!?]+)",
    r"(?:confirms?|confirmed|confirming)\s+that\s+([^.!?]+)",
    r"(?:reports?|reported|reporting)\s+that\s+([^.!?]+)",
    r"(?:stated?|states?|stating)\s+that\s+([^.!?]+)",
    r"(?:announced?|announces?|announcing)\s+that\s+([^.!?]+)",
    r"(?:reveals?|revealed|revealing)\s+that\s+([^.!?]+)",
    r"(?:warns?|warned|warning)\s+that\s+([^.!?]+)",
    r"(?:discovered?|discovers?)\s+that\s+([^.!?]+)",
    r"(?:found?|finds?)\s+that\s+([^.!?]+)",
]

def extract_primary_claim(raw_text: str) -> Dict[str, Any]:
    if not raw_text or len(raw_text.strip()) < 20:
        return {
            "has_claim": False,
            "detected_claim": "Specific factual claim could not be confidently identified.",
            "confidence": 0.0,
            "method": "insufficient_text"
        }

    text = raw_text.strip()

    # 1. Pattern matching on reported assertions
    for pat in CLAIM_INTRO_PATTERNS:
        match = re.search(pat, text, re.IGNORECASE)
        if match:
            extracted = match.group(1).strip()
            # Clean punctuation
            extracted = re.sub(r"\s+", " ", extracted).rstrip(",;:-")
            if len(extracted.split()) >= 4:
                return {
                    "has_claim": True,
                    "detected_claim": extracted[0].upper() + extracted[1:] + (". " if not extracted.endswith(".") else ""),
                    "confidence": 0.85,
                    "method": "syntactic_assertion_pattern"
                }

    # 2. Extract quotes if present
    quotes = re.findall(r'["\u201c\u201d]([^"\u201c\u201d]{15,160})["\u201c\u201d]', text)
    if quotes:
        candidate = quotes[0].strip()
        if len(candidate.split()) >= 4:
            return {
                "has_claim": True,
                "detected_claim": candidate[0].upper() + candidate[1:] + (". " if not candidate.endswith(".") else ""),
                "confidence": 0.78,
                "method": "quoted_statement_extraction"
            }

    # 3. Leading declarative sentence
    sentences = re.split(r"(?<=[.!?])\s+", text)
    for s in sentences:
        s_clean = s.strip()
        # Remove exclamation headlines or boilerplate
        if len(s_clean.split()) >= 5 and not s_clean.isupper() and not s_clean.startswith("http"):
            return {
                "has_claim": True,
                "detected_claim": s_clean,
                "confidence": 0.65,
                "method": "lead_declarative_sentence"
            }

    return {
        "has_claim": False,
        "detected_claim": "Specific factual claim could not be confidently identified.",
        "confidence": 0.0,
        "method": "heuristic_fallback"
    }
