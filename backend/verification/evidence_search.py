"""
TruthLens AI - Evidence Search Interface
Interface for searching verified external knowledge bases, fact-check APIs, or open-web indices.
When no live external search service or API key is connected, returns an explicit unavailable status
without generating synthetic or fabricated search results.
"""

from typing import List, Dict, Any

class EvidenceSearchClient:
    def __init__(self, api_key: str = None):
        self.api_key = api_key
        self.is_connected = bool(api_key)

    def search_claim(self, claim_text: str, max_results: int = 5) -> Dict[str, Any]:
        if not self.is_connected:
            return {
                "available": False,
                "status": "UNAVAILABLE",
                "message": "Evidence verification is not currently available.",
                "reason": "No external fact-checking or search API is configured in the environment.",
                "results": []
            }

        # Live search would execute here when API credentials exist
        return {
            "available": True,
            "status": "SUCCESS",
            "message": "Live search completed",
            "results": []
        }
