"""
TruthLens AI - Full Verification Orchestrator
Coordinates the verification pipeline:
News Article -> Claim Extraction -> ML Risk Analysis -> Evidence Search -> Source Collection -> Evidence Comparison -> Verification Assessment
"""

from typing import Dict, Any, Optional
from backend.verification.claim_extractor import extract_primary_claim
from backend.verification.evidence_search import EvidenceSearchClient
from backend.verification.source_evaluator import evaluate_source

class VerificationPipeline:
    def __init__(self, search_client: Optional[EvidenceSearchClient] = None):
        self.search_client = search_client or EvidenceSearchClient()

    def verify(self, article_text: str, source_url: Optional[str] = None, ml_prediction: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        # 1. Claim Extraction
        claim_info = extract_primary_claim(article_text)

        # 2. Source Evaluation
        source_info = evaluate_source(source_url)

        # 3. Evidence Search (honest: reports unavailable if no search engine connected)
        evidence_info = self.search_client.search_claim(claim_info.get("detected_claim", ""))

        # 4. Assessment synthesis
        return {
            "claim": claim_info,
            "source": source_info,
            "evidence": evidence_info,
            "status": "COMPLETED",
            "verification_verdict": "UNVERIFIED_EXTERNALLY",
            "verification_note": "Evidence verification is not currently available. Assessment relies on statistical ML language patterns."
        }
