"""
TruthLens AI - Source Evaluator Module
Evaluates source URLs and domain metadata independently from text classification.
Never penalizes text solely for absent or unfamiliar source URLs.
"""

from urllib.parse import urlparse
from typing import Dict, Any, Optional

def evaluate_source(source_url: Optional[str]) -> Dict[str, Any]:
    if not source_url or not source_url.strip():
        return {
            "provided": False,
            "url": None,
            "domain": None,
            "source_status": "Not provided",
            "verification_status": "Not independently verified",
            "notes": "No source URL was supplied. The article was assessed solely on text content."
        }

    trimmed = source_url.strip()
    try:
        url_to_parse = trimmed if trimmed.startswith(("http://", "https://")) else f"https://{trimmed}"
        parsed = urlparse(url_to_parse)
        domain = parsed.netloc.lower() or trimmed

        return {
            "provided": True,
            "url": trimmed,
            "domain": domain,
            "source_status": domain,
            "verification_status": "Not independently verified",
            "notes": f"Origin domain '{domain}' extracted for provenance tracking. Independent external reputation verification is not performed."
        }
    except Exception:
        return {
            "provided": True,
            "url": trimmed,
            "domain": trimmed,
            "source_status": trimmed,
            "verification_status": "Not independently verified",
            "notes": "Unformatted source string provided. Model evaluated text independently."
        }
