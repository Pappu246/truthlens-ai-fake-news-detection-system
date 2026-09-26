#!/usr/bin/env python3
"""Shared, deterministic LIAR claim-model primitives.

This module is the single source of truth for:
  * the LIAR binary split policy (TRAIN / VALID / TEST),
  * the tokenizer (byte-for-byte mirrored by server/claimModel.ts),
  * the speaker-credit metadata feature block.

Nothing in here touches the TEST split beyond reading it for final
evaluation. No label is ever rewritten, no row is ever dropped from TEST.
"""
from __future__ import annotations

import csv
import hashlib
import re
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

# ---------------------------------------------------------------------------
# Split policy
# ---------------------------------------------------------------------------
# LIAR ships 6 ordinal labels. The claim model is a BINARY veracity model, so
# the two ambiguous middle classes (half-true, barely-true) are excluded
# entirely from every split -- they are neither clearly true nor clearly false
# and collapsing them into either pole injects label noise.
TRUE_LABELS = ("true", "mostly-true")
FALSE_LABELS = ("false", "pants-fire")
BINARY_LABELS = TRUE_LABELS + FALSE_LABELS

LIAR_COLUMNS = (
    "id", "label", "statement", "subjects", "speaker", "job_title", "state",
    "party", "barely_true_count", "false_count", "half_true_count",
    "mostly_true_count", "pants_on_fire_count", "context",
)

# Credit-history column -> the LIAR label that increments it. Used to remove
# the current statement's own contribution to its speaker credit history
# (otherwise the metadata block leaks the target label).
SELF_COUNT_COLUMN = {
    "barely-true": "barely_true_count",
    "false": "false_count",
    "half-true": "half_true_count",
    "mostly-true": "mostly_true_count",
    "pants-fire": "pants_on_fire_count",
}


def _norm_statement(s: str) -> str:
    return " ".join(s.split()).strip().lower()


def read_liar(split: str) -> List[Dict[str, str]]:
    """Read one raw LIAR split file and keep only the binary-label rows."""
    path = DATA / f"{split}.tsv"
    rows: List[Dict[str, str]] = []
    with open(path, encoding="utf-8", newline="") as fh:
        for raw in csv.reader(fh, delimiter="\t", quoting=csv.QUOTE_NONE):
            if len(raw) != len(LIAR_COLUMNS):
                continue
            rec = dict(zip(LIAR_COLUMNS, raw))
            if rec["label"] not in BINARY_LABELS:
                continue
            if not rec["statement"].strip():
                continue
            rec["y"] = 1 if rec["label"] in TRUE_LABELS else 0
            rows.append(rec)
    return rows


def build_splits() -> Dict[str, List[Dict[str, str]]]:
    """Apply the documented split policy.

    Rules (applied in this order, TRAIN only):
      1. binary label filter (above),
      2. de-duplicate identical statements inside TRAIN,
      3. drop TRAIN rows whose statement also appears in VALID or TEST
         (cross-split leakage guard).

    VALID and TEST are never filtered or trimmed. Every held-out row that
    survives the binary label filter is evaluated.
    """
    train = read_liar("train")
    valid = read_liar("valid")
    test = read_liar("test")

    held_out = {_norm_statement(r["statement"]) for r in valid}
    held_out |= {_norm_statement(r["statement"]) for r in test}

    seen: set[str] = set()
    deduped: List[Dict[str, str]] = []
    dropped_dupe = 0
    dropped_leak = 0
    for r in train:
        key = _norm_statement(r["statement"])
        if key in seen:
            dropped_dupe += 1
            continue
        if key in held_out:
            dropped_leak += 1
            continue
        seen.add(key)
        deduped.append(r)

    return {
        "train": deduped,
        "valid": valid,
        "test": test,
        "_policy": {  # type: ignore[dict-item]
            "train_duplicates_removed": dropped_dupe,
            "train_leakage_rows_removed": dropped_leak,
        },
    }


# ---------------------------------------------------------------------------
# Tokenizer -- mirrored exactly by server/claimModel.ts
# ---------------------------------------------------------------------------
STOPWORDS = {
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "aren't",
    "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can",
    "cannot", "could", "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down",
    "during", "each", "few", "for", "from", "further", "had", "hadn't", "has", "hasn't", "have", "haven't",
    "having", "he", "he'd", "he'll", "he's", "her", "here", "here's", "hers", "herself", "him", "himself",
    "his", "how", "how's", "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it",
    "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my", "myself", "no", "nor", "not",
    "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own",
    "same", "shan't", "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such",
    "than", "that", "that's", "the", "their", "theirs", "them", "themselves", "then", "there", "there's",
    "these", "they", "they'd", "they'll", "they're", "they've", "this", "those", "through", "to", "too",
    "under", "until", "up", "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've", "were",
    "weren't", "what", "what's", "when", "when's", "where", "where's", "which", "while", "who", "who's",
    "whom", "why", "why's", "with", "won't", "would", "wouldn't", "you", "you'd", "you'll", "you're",
    "you've", "your", "yours", "yourself", "yourselves",
}

_URL_RE = re.compile(r"https?://\S+|www\.\S+")
_HTML_RE = re.compile(r"<.*?>")
_PUNCT_RE = re.compile(r"[.,/#!$%\^&\*;:{}=\-_`~()?\"'\[\]]")
_WS_RE = re.compile(r"\s+")

MIN_TOKEN_LEN = 3


def clean_text(text: str) -> str:
    """Identical to cleanText(text, true) in server/mlEngine.ts."""
    if not text:
        return ""
    cleaned = text.lower()
    cleaned = _URL_RE.sub(" ", cleaned)
    cleaned = _HTML_RE.sub(" ", cleaned)
    cleaned = _PUNCT_RE.sub(" ", cleaned)
    cleaned = _WS_RE.sub(" ", cleaned).strip()
    if not cleaned:
        return ""
    tokens = [t for t in cleaned.split(" ") if t not in STOPWORDS and len(t) >= MIN_TOKEN_LEN]
    return " ".join(tokens)


def analyzer(text: str) -> List[str]:
    """Unigrams + adjacent bigrams over the cleaned token stream.

    Mirrors ClaimModel.vectorize() in server/claimModel.ts exactly.
    """
    cleaned = clean_text(text)
    if not cleaned:
        return []
    words = cleaned.split(" ")
    grams: List[str] = [w for w in words if len(w) >= MIN_TOKEN_LEN]
    for j in range(len(words) - 1):
        if len(words[j]) >= MIN_TOKEN_LEN and len(words[j + 1]) >= MIN_TOKEN_LEN:
            grams.append(f"{words[j]} {words[j + 1]}")
    return grams


# ---------------------------------------------------------------------------
# Speaker-credit metadata block
# ---------------------------------------------------------------------------
PARTIES = ("republican", "democrat", "none", "independent", "organization", "libertarian")
LOW_ACCOUNTABILITY_SPEAKERS = {
    "viral-image", "facebook-posts", "bloggers", "chain-email", "blog-posting",
    "email-viral", "social-media-posting", "tweets",
}

META_FEATURE_NAMES: Sequence[str] = (
    "history_available",
    "log1p_history_total",
    "ratio_barely_true",
    "ratio_false",
    "ratio_half_true",
    "ratio_mostly_true",
    "ratio_pants_on_fire",
    "ratio_false_leaning",
    "low_accountability_speaker",
    *[f"party_{p}" for p in PARTIES],
    "party_other",
)


def _int(v: str) -> int:
    v = (v or "").strip()
    return int(v) if v.isdigit() else 0


def credit_counts(rec: Dict[str, str], remove_self: bool) -> Dict[str, int]:
    counts = {
        "barely_true_count": _int(rec.get("barely_true_count", "")),
        "false_count": _int(rec.get("false_count", "")),
        "half_true_count": _int(rec.get("half_true_count", "")),
        "mostly_true_count": _int(rec.get("mostly_true_count", "")),
        "pants_on_fire_count": _int(rec.get("pants_on_fire_count", "")),
    }
    if remove_self:
        col = SELF_COUNT_COLUMN.get(rec.get("label", ""))
        if col and counts[col] > 0:
            counts[col] -= 1
    return counts


def meta_features(rec: Dict[str, str], remove_self: bool = True) -> List[float]:
    """Build the fixed-length metadata block. Same order as META_FEATURE_NAMES."""
    c = credit_counts(rec, remove_self)
    total = sum(c.values())
    denom = float(total) if total > 0 else 1.0
    import math

    falsey = c["barely_true_count"] + c["false_count"] + c["pants_on_fire_count"]
    party = (rec.get("party") or "").strip().lower()
    speaker = (rec.get("speaker") or "").strip().lower()

    feats = [
        1.0 if total > 0 else 0.0,
        math.log1p(total),
        c["barely_true_count"] / denom,
        c["false_count"] / denom,
        c["half_true_count"] / denom,
        c["mostly_true_count"] / denom,
        c["pants_on_fire_count"] / denom,
        falsey / denom,
        1.0 if speaker in LOW_ACCOUNTABILITY_SPEAKERS else 0.0,
    ]
    for p in PARTIES:
        feats.append(1.0 if party == p else 0.0)
    feats.append(1.0 if party and party not in PARTIES else 0.0)
    assert len(feats) == len(META_FEATURE_NAMES)
    return feats


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def dataset_fingerprint() -> str:
    payload = "|".join(sha256_file(DATA / f"{s}.tsv") for s in ("train", "valid", "test"))
    return hashlib.sha256(payload.encode()).hexdigest()
