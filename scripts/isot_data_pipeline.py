"""
TruthLens AI - ISOT Dataset Preparation Pipeline (Phase 2 of the ML upgrade)

This script performs DATA PREPARATION ONLY. It does not train a model and
does not touch data/saved_model_artifacts.json (the production runtime
artifact). Its job is to turn the raw ISOT CSVs into a validated,
documented, leakage-aware set of train/validation/test splits that a
future training script can consume with confidence.

Every number this script prints is measured directly from the input
files at run time. Nothing here is a fabricated or estimated statistic.

Inputs (not included in this repo due to size -- see docs/DATA_SOURCES.md):
    data/Fake.csv   (title, text, subject, date)
    data/True.csv   (title, text, subject, date)

Outputs (written to data/isot_prepared/):
    manifest.csv          - one row per input article with every computed
                             flag (duplicate group, near-dup group, dateline
                             flag, date-parse status, split assignment)
    stats.json            - every statistic this script computes, in one
                             machine-readable file
    splits/{split_name}_ids.txt - one article id per line, per split
"""

import csv
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

try:
    from datasketch import MinHash, MinHashLSH
except ImportError:
    print(
        "ERROR: this script requires the 'datasketch' package "
        "(pip install datasketch --break-system-packages).",
        file=sys.stderr,
    )
    sys.exit(1)

RANDOM_SEED = 42
MIN_TEXT_LENGTH = 60
NEAR_DUP_JACCARD_THRESHOLD = 0.7
NEAR_DUP_NUM_PERM = 128
NEAR_DUP_SHINGLE_SIZE = 5
TRAIN_FRACTION = 0.70
VAL_FRACTION = 0.15
TEST_FRACTION = 0.15
DATE_FORMATS = ["%B %d, %Y", "%b %d, %Y", "%m/%d/%Y", "%d-%b-%y"]

REUTERS_DATELINE_RE = re.compile(r"^[A-Z][A-Za-z\.\s,]{2,40}\(Reuters\)\s*-")
REUTERS_EARLY_RE = re.compile(r"\(reuters\)", re.IGNORECASE)

DATA_DIR = Path("data")
OUT_DIR = DATA_DIR / "isot_prepared"
SPLITS_DIR = OUT_DIR / "splits"


def normalize_text(s: str) -> str:
    """Unicode + whitespace normalization for derived clean fields."""
    if s is None:
        return ""
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"\s+", " ", s).strip()


def try_parse_date(date_str: str):
    date_str = (date_str or "").strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    return None


def normalize_for_shingle(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def get_shingles(text: str, k: int = NEAR_DUP_SHINGLE_SIZE):
    words = text.split(" ")
    if len(words) < k:
        return {" ".join(words)} if words else set()
    return {" ".join(words[i:i + k]) for i in range(len(words) - k + 1)}


def load_raw(path: Path, label: str):
    """Load one ISOT CSV and verify its exact expected schema."""
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. This script does not fabricate data -- "
            f"see docs/DATA_SOURCES.md for how to obtain the real ISOT CSVs."
        )

    rows = []
    with open(path, "r", encoding="utf-8", errors="strict") as f:
        reader = csv.DictReader(f)
        expected = ["title", "text", "subject", "date"]
        if reader.fieldnames != expected:
            raise ValueError(
                f"{path} has unexpected columns {reader.fieldnames}, "
                f"expected {expected}. Refusing to proceed silently -- "
                f"the pipeline's leakage assumptions are tied to this exact schema."
            )
        for i, row in enumerate(reader):
            row["_source_file"] = path.name
            row["_row_index"] = i
            row["_label"] = label
            row["_id"] = f"{label}-{i}"
            rows.append(row)
    return rows


def build_manifest(rows):
    """Attach derived flags to every record; never silently delete rows."""
    exact_key_counts = Counter()
    for r in rows:
        key = (r["title"].strip(), r["text"].strip())
        exact_key_counts[key] += 1

    seen_exact = {}
    for r in rows:
        title_clean = normalize_text(r["title"])
        text_clean = normalize_text(r["text"])
        key = (r["title"].strip(), r["text"].strip())

        r["title_clean"] = title_clean
        r["text_clean"] = text_clean
        r["text_length"] = len(text_clean)
        r["is_empty_text"] = text_clean == ""
        r["is_very_short_text"] = 0 < len(text_clean) < MIN_TEXT_LENGTH

        parsed_date = try_parse_date(r["date"])
        r["date_parsed"] = parsed_date.date().isoformat() if parsed_date else None
        r["is_date_valid"] = parsed_date is not None
        r["_parsed_date_obj"] = parsed_date

        r["is_exact_duplicate_group"] = exact_key_counts[key] > 1
        if key not in seen_exact:
            seen_exact[key] = r["_id"]
            r["is_first_occurrence"] = True
        else:
            r["is_first_occurrence"] = False
        r["exact_duplicate_of"] = (
            seen_exact[key] if not r["is_first_occurrence"] else None
        )

        r["is_reuters_dateline_strict"] = bool(
            REUTERS_DATELINE_RE.match(r["text"].strip())
        )
        r["is_reuters_mentioned_early"] = bool(
            REUTERS_EARLY_RE.search(r["text"][:100])
        )

    return rows


def near_duplicate_groups(rows):
    """MinHash/LSH near-duplicate detection without O(n^2) pairwise comparison."""
    lsh = MinHashLSH(
        threshold=NEAR_DUP_JACCARD_THRESHOLD,
        num_perm=NEAR_DUP_NUM_PERM,
    )
    minhashes = {}
    for r in rows:
        shingles = get_shingles(normalize_for_shingle(r["text"]))
        m = MinHash(num_perm=NEAR_DUP_NUM_PERM)
        for s in shingles:
            m.update(s.encode("utf8"))
        minhashes[r["_id"]] = m
        lsh.insert(r["_id"], m)

    parent = {r["_id"]: r["_id"] for r in rows}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        px, py = find(x), find(y)
        if px != py:
            parent[px] = py

    for r in rows:
        for other_id in lsh.query(minhashes[r["_id"]]):
            if other_id != r["_id"]:
                union(r["_id"], other_id)

    groups = defaultdict(list)
    for r in rows:
        groups[find(r["_id"])].append(r["_id"])

    id_to_group = {}
    for root, members in groups.items():
        for member in members:
            id_to_group[member] = root
    return id_to_group, groups


def stratified_group_split(rows, id_to_group, seed=RANDOM_SEED):
    """Split by near-duplicate group so no group straddles train/val/test."""
    import random

    rng = random.Random(seed)

    group_labels = defaultdict(Counter)
    group_members = defaultdict(list)
    for r in rows:
        g = id_to_group[r["_id"]]
        group_labels[g][r["_label"]] += 1
        group_members[g].append(r["_id"])

    groups_list = list(group_members.keys())
    rng.shuffle(groups_list)

    target = {
        "train": TRAIN_FRACTION,
        "val": VAL_FRACTION,
        "test": TEST_FRACTION,
    }
    counts = {"train": 0, "val": 0, "test": 0}
    total = len(rows)
    assignment = {}

    for g in groups_list:
        size = len(group_members[g])
        deficits = {
            name: target[name] - (counts[name] / total if total else 0)
            for name in counts
        }
        chosen = max(deficits, key=deficits.get)
        assignment[g] = chosen
        counts[chosen] += size

    split_ids = {"train": [], "val": [], "test": []}
    for r in rows:
        split_ids[assignment[id_to_group[r["_id"]]]].append(r["_id"])
    return split_ids


def temporal_split(rows, id_to_group):
    """Create a group-aware temporal train/test split with undated rows excluded."""
    dated = [r for r in rows if r["_parsed_date_obj"] is not None]
    undated = [r for r in rows if r["_parsed_date_obj"] is None]

    cutoff = datetime(2017, 1, 1)

    group_side_votes = defaultdict(Counter)
    for r in dated:
        g = id_to_group[r["_id"]]
        side = "train" if r["_parsed_date_obj"] < cutoff else "test"
        group_side_votes[g][side] += 1

    group_side = {
        g: votes.most_common(1)[0][0]
        for g, votes in group_side_votes.items()
    }

    temporal_ids = {"train": [], "test": []}
    for r in dated:
        g = id_to_group[r["_id"]]
        temporal_ids[group_side[g]].append(r["_id"])

    return temporal_ids, cutoff, len(undated)


def main():
    print("=" * 78)
    print("TRUTHLENS AI - ISOT DATA PREPARATION PIPELINE (Phase 2)")
    print("=" * 78)

    fake_path = DATA_DIR / "Fake.csv"
    true_path = DATA_DIR / "True.csv"

    print("\n[1/6] Loading raw CSVs and verifying schema...")
    fake_rows = load_raw(fake_path, "FAKE")
    true_rows = load_raw(true_path, "REAL")
    all_rows = fake_rows + true_rows
    print(
        f"  FAKE.csv: {len(fake_rows):,} rows | True.csv: {len(true_rows):,} rows | "
        f"Total: {len(all_rows):,} rows"
    )

    print("\n[2/6] Building manifest (cleaning, dedup flags, dateline flags, date parsing)...")
    all_rows = build_manifest(all_rows)

    empty_text = sum(1 for r in all_rows if r["is_empty_text"])
    very_short = sum(1 for r in all_rows if r["is_very_short_text"])
    exact_dup_extra = sum(
        1 for r in all_rows
        if r["is_exact_duplicate_group"] and not r["is_first_occurrence"]
    )
    invalid_dates = sum(1 for r in all_rows if not r["is_date_valid"])
    reuters_strict = sum(1 for r in all_rows if r["is_reuters_dateline_strict"])
    reuters_early = sum(1 for r in all_rows if r["is_reuters_mentioned_early"])

    print(f"  Empty text: {empty_text} | Very short text (<{MIN_TEXT_LENGTH} chars): {very_short}")
    print(f"  Exact-duplicate extra rows (beyond first occurrence): {exact_dup_extra}")
    print(f"  Rows with unparseable dates: {invalid_dates}")
    print(f"  Rows matching strict Reuters dateline pattern: {reuters_strict}")
    print(f"  Rows mentioning '(Reuters)' in first 100 chars: {reuters_early}")

    subject_by_label = defaultdict(Counter)
    for r in all_rows:
        subject_by_label[r["_label"]][r["subject"].strip()] += 1
    fake_subjects = set(subject_by_label["FAKE"].keys())
    real_subjects = set(subject_by_label["REAL"].keys())
    subject_overlap = fake_subjects & real_subjects
    print(
        f"  Subject values -- FAKE: {sorted(fake_subjects)} | "
        f"REAL: {sorted(real_subjects)}"
    )
    print(
        f"  Subject overlap between labels: "
        f"{subject_overlap if subject_overlap else 'NONE (fully disjoint)'}"
    )

    print("\n[3/6] Near-duplicate detection (MinHash/LSH, this takes a few minutes)...")
    id_to_group, groups = near_duplicate_groups(all_rows)
    near_dup_groups_gt1 = {g: m for g, m in groups.items() if len(m) > 1}
    group_sizes = [len(m) for m in near_dup_groups_gt1.values()]
    cross_label_groups = 0
    id_to_label = {r["_id"]: r["_label"] for r in all_rows}
    for members in near_dup_groups_gt1.values():
        if len({id_to_label[m] for m in members}) > 1:
            cross_label_groups += 1

    print(f"  Near-duplicate groups (size>1): {len(near_dup_groups_gt1)}")
    print(f"  Articles involved in near-dup groups: {sum(group_sizes)}")
    print(f"  Largest group size: {max(group_sizes) if group_sizes else 0}")
    print(
        f"  Cross-label near-dup groups: {cross_label_groups} "
        f"(manual review required for interpretation)"
    )

    print("\n[4/6] Building leakage-safe (near-dup-group-aware) train/val/test split...")
    split_ids = stratified_group_split(all_rows, id_to_group)
    for name in ("train", "val", "test"):
        labels_in_split = Counter(id_to_label[i] for i in split_ids[name])
        print(
            f"  {name}: {len(split_ids[name]):,} rows "
            f"(REAL={labels_in_split['REAL']:,}, FAKE={labels_in_split['FAKE']:,})"
        )

    split_of_id = {}
    for name, ids in split_ids.items():
        for i in ids:
            split_of_id[i] = name
    straddling = 0
    for members in groups.values():
        if len(members) > 1:
            sides = {split_of_id[m] for m in members}
            if len(sides) > 1:
                straddling += 1
    print(
        f"  Near-dup groups straddling multiple splits: {straddling} "
        f"(must be 0 for the split to be leakage-safe)"
    )

    print("\n[5/6] Building temporal split (train=earlier, test=later, group-aware)...")
    temporal_ids, cutoff, undated_count = temporal_split(all_rows, id_to_group)
    for name in ("train", "test"):
        labels_in_split = Counter(id_to_label[i] for i in temporal_ids[name])
        print(
            f"  temporal_{name} (cutoff {cutoff.date()}): {len(temporal_ids[name]):,} rows "
            f"(REAL={labels_in_split['REAL']:,}, FAKE={labels_in_split['FAKE']:,})"
        )
    print(f"  Rows excluded from temporal split (unparseable date): {undated_count}")

    print("\n[6/6] Writing outputs...")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    SPLITS_DIR.mkdir(parents=True, exist_ok=True)

    manifest_path = OUT_DIR / "manifest.csv"
    fieldnames = [
        "_id", "_label", "_source_file", "_row_index", "title_clean", "text_length",
        "is_empty_text", "is_very_short_text", "date_parsed", "is_date_valid",
        "is_exact_duplicate_group", "is_first_occurrence", "exact_duplicate_of",
        "near_duplicate_group", "is_reuters_dateline_strict",
        "is_reuters_mentioned_early", "subject",
    ]
    with open(manifest_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in all_rows:
            writer.writerow({
                "_id": r["_id"], "_label": r["_label"], "_source_file": r["_source_file"],
                "_row_index": r["_row_index"], "title_clean": r["title_clean"],
                "text_length": r["text_length"], "is_empty_text": r["is_empty_text"],
                "is_very_short_text": r["is_very_short_text"], "date_parsed": r["date_parsed"],
                "is_date_valid": r["is_date_valid"],
                "is_exact_duplicate_group": r["is_exact_duplicate_group"],
                "is_first_occurrence": r["is_first_occurrence"],
                "exact_duplicate_of": r["exact_duplicate_of"],
                "near_duplicate_group": id_to_group[r["_id"]],
                "is_reuters_dateline_strict": r["is_reuters_dateline_strict"],
                "is_reuters_mentioned_early": r["is_reuters_mentioned_early"],
                "subject": r["subject"].strip(),
            })

    for name, ids in split_ids.items():
        with open(SPLITS_DIR / f"{name}_ids.txt", "w", encoding="utf-8") as f:
            f.write("\n".join(ids))
    for name, ids in temporal_ids.items():
        with open(SPLITS_DIR / f"temporal_{name}_ids.txt", "w", encoding="utf-8") as f:
            f.write("\n".join(ids))

    stats = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "config": {
            "random_seed": RANDOM_SEED,
            "min_text_length": MIN_TEXT_LENGTH,
            "near_dup_jaccard_threshold": NEAR_DUP_JACCARD_THRESHOLD,
            "near_dup_num_perm": NEAR_DUP_NUM_PERM,
            "near_dup_shingle_size": NEAR_DUP_SHINGLE_SIZE,
            "train_fraction": TRAIN_FRACTION,
            "val_fraction": VAL_FRACTION,
            "test_fraction": TEST_FRACTION,
            "date_formats_tried": DATE_FORMATS,
            "temporal_cutoff": cutoff.date().isoformat(),
        },
        "raw_counts": {
            "fake": len(fake_rows), "real": len(true_rows), "total": len(all_rows)
        },
        "quality": {
            "empty_text": empty_text,
            "very_short_text": very_short,
            "exact_duplicate_extra_rows": exact_dup_extra,
            "invalid_dates": invalid_dates,
        },
        "subject_leakage": {
            "fake_subjects": sorted(fake_subjects),
            "real_subjects": sorted(real_subjects),
            "overlap": sorted(subject_overlap),
            "fully_disjoint": len(subject_overlap) == 0,
        },
        "reuters_dateline_leakage": {
            "strict_dateline_matches": reuters_strict,
            "early_mention_matches": reuters_early,
            "strict_dateline_pct_of_real": round(
                sum(1 for r in true_rows if REUTERS_DATELINE_RE.match(r["text"].strip()))
                / len(true_rows) * 100,
                2,
            ),
            "strict_dateline_pct_of_fake": round(
                sum(1 for r in fake_rows if REUTERS_DATELINE_RE.match(r["text"].strip()))
                / len(fake_rows) * 100,
                2,
            ),
        },
        "near_duplicates": {
            "groups_size_gt1": len(near_dup_groups_gt1),
            "articles_involved": sum(group_sizes),
            "largest_group_size": max(group_sizes) if group_sizes else 0,
            "cross_label_groups": cross_label_groups,
        },
        "split": {
            name: {
                "count": len(ids),
                "real": Counter(id_to_label[i] for i in ids)["REAL"],
                "fake": Counter(id_to_label[i] for i in ids)["FAKE"],
            }
            for name, ids in split_ids.items()
        },
        "split_leakage_check": {"groups_straddling_splits": straddling},
        "temporal_split": {
            "cutoff_date": cutoff.date().isoformat(),
            "excluded_undated_rows": undated_count,
            **{
                f"temporal_{name}": {
                    "count": len(ids),
                    "real": Counter(id_to_label[i] for i in ids)["REAL"],
                    "fake": Counter(id_to_label[i] for i in ids)["FAKE"],
                }
                for name, ids in temporal_ids.items()
            },
        },
    }

    with open(OUT_DIR / "stats.json", "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)

    print(f"\nWrote: {manifest_path}")
    print(f"Wrote: {OUT_DIR / 'stats.json'}")
    print(f"Wrote split id files under: {SPLITS_DIR}/")
    print(
        "\nPHASE 2 DATA PIPELINE COMPLETE. No model was trained. "
        "data/saved_model_artifacts.json was not touched."
    )


if __name__ == "__main__":
    main()
