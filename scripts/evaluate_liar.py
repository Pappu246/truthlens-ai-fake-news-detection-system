import argparse
import csv
import hashlib
import json
import re
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path
from collections import Counter


def js_round(value: float, digits: int = 0) -> float:
    """Match JavaScript Math.round for finite values used by the runtime."""
    factor = 10 ** digits
    return math.floor(value * factor + 0.5) / factor


def safe_ratio(numerator: int, denominator: int):
    return numerator / denominator if denominator else None


def classification_metrics(tp: int, tn: int, fp: int, fn: int):
    total = tp + tn + fp + fn
    precision_fake = safe_ratio(tp, tp + fp)
    recall_fake = safe_ratio(tp, tp + fn)
    precision_real = safe_ratio(tn, tn + fn)
    recall_real = safe_ratio(tn, tn + fp)
    f1_fake = (2 * precision_fake * recall_fake / (precision_fake + recall_fake)
               if precision_fake is not None and recall_fake is not None and precision_fake + recall_fake else None)
    f1_real = (2 * precision_real * recall_real / (precision_real + recall_real)
               if precision_real is not None and recall_real is not None and precision_real + recall_real else None)
    recalls = [v for v in (recall_fake, recall_real) if v is not None]
    return {
        "evaluated_samples": total,
        "accuracy": safe_ratio(tp + tn, total),
        "precision_fake": precision_fake,
        "recall_fake": recall_fake,
        "f1_fake": f1_fake,
        "precision_real": precision_real,
        "recall_real": recall_real,
        "f1_real": f1_real,
        "macro_f1": (f1_fake + f1_real) / 2 if f1_fake is not None and f1_real is not None else None,
        "balanced_accuracy": sum(recalls) / len(recalls) if len(recalls) == 2 else None,
        "confusion_matrix": {
            "true_positive": tp, "true_negative": tn,
            "false_positive": fp, "false_negative": fn,
            "matrix": [[tn, fp], [fn, tp]],
            "labels": ["REAL (0)", "FAKE (1)"]
        }
    }


def run_evaluation():
    parser = argparse.ArgumentParser(description="Evaluate the exact production ensemble on the frozen LIAR test split.")
    parser.add_argument("--output", type=Path, default=Path("data/external_validation.json"),
                        help="JSON report path (default: data/external_validation.json)")
    args = parser.parse_args()

    artifact_path = Path("data/saved_model_artifacts.json")
    artifact_bytes = artifact_path.read_bytes()
    artifact_sha256 = hashlib.sha256(artifact_bytes).hexdigest()
    with artifact_path.open("r", encoding="utf-8") as f:
        artifact = json.load(f)

    vocab = artifact["vocabulary"]
    idf = artifact["idf"]
    selected_model = artifact["selected_model"]
    inference_mode = selected_model.get("inference_mode", "legacy_single_svm")
    members = selected_model.get("members", [])
    if inference_mode != "calibrated_ensemble" or len(members) != 3:
        raise RuntimeError(
            "Refusing to produce a current production-parity report: "
            "saved_model_artifacts.json must declare calibrated_ensemble with exactly 3 members."
        )

    thresholds = artifact.get("thresholds", {})
    fake_threshold = float(thresholds.get("fake_threshold", 0.98))
    real_threshold = float(thresholds.get("real_threshold", 0.35))
    min_text_length = int(thresholds.get("min_text_length", 60))
    min_word_count = int(thresholds.get("min_word_count", 20))
    min_vocabulary_coverage = 0.10
    ood_short_word_count = 100
    ood_coverage_threshold = 0.35

    if not (0 <= real_threshold < fake_threshold <= 1):
        raise RuntimeError(f"Invalid decision thresholds in the model artifact: real={real_threshold}, fake={fake_threshold}")

    # Read metadata dynamically from the artifact so the report reflects what is actually deployed.
    artifact_meta = artifact.get("metadata", {})
    dataset_info = artifact.get("dataset_info", {})
    is_demo = bool(artifact.get("is_demo", False))
    model_name = artifact.get("model_name", artifact.get("selected_model", {}).get("name", "Linear SVM (Calibrated)"))
    model_version = artifact.get("model_version", "unknown")
    vocab_size = len(vocab)
    if is_demo:
        src_label = "data/news.csv (36 demo articles)"
        sample_count = 36
    else:
        src_label = dataset_info.get("source_path", artifact_meta.get("training_data", "data/True.csv & data/Fake.csv")) or "data/True.csv & data/Fake.csv"
        sample_count = int(dataset_info.get("total_samples", artifact_meta.get("total_samples", 0)) or 0)
    dataset_status = artifact.get("dataset_status", ("DEMO DATASET" if is_demo else "ISOT BENCHMARK DATASET"))

    STOPWORDS = set([
      'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', "aren't",
      'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can',
      'cannot', 'could', "couldn't", 'did', "didn't", 'do', 'does', "doesn't", 'doing', "don't", 'down',
      'during', 'each', 'few', 'for', 'from', 'further', 'had', "hadn't", 'has', "hasn't", 'have', "haven't",
      'having', 'he', "he'd", "he'll", "he's", 'her', 'here', "here's", 'hers', 'herself', 'him', 'himself',
      'his', 'how', "how's", 'i', "i'd", "i'll", "i'm", "i've", 'if', 'in', 'into', 'is', "isn't", 'it',
      "it's", 'its', 'itself', "let's", 'me', 'more', 'most', "mustn't", 'my', 'myself', 'no', 'nor', 'not',
      'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
      'same', "shan't", 'she', "she'd", "she'll", "she's", 'should', "shouldn't", 'so', 'some', 'such',
      'than', 'that', "that's", 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', "there's",
      'these', 'they', "they'd", "they'll", "they're", "they've", 'this', 'those', 'through', 'to', 'too',
      'under', 'until', 'up', 'very', 'was', "wasn't", 'we', "we'd", "we'll", "we're", "we've", 'were',
      "weren't", 'what', "what's", 'when', "when's", 'where', "where's", 'which', 'while', 'who', "who's",
      'whom', 'why', "why's", 'with', "won't", 'would', "wouldn't", 'you', "you'd", "you'll", "you're",
      "you've", 'your', 'yours', 'yourself', 'yourselves'
    ])

    def clean_text(text: str) -> str:
        if not text:
            return ""
        cleaned = text.lower()
        cleaned = re.sub(r"https?://\S+|www\.\S+", " ", cleaned)
        cleaned = re.sub(r"<.*?>", " ", cleaned)
        cleaned = re.sub(r"[.,/#!$%\^&\*;:{}=\-_`~()?\"'\[\]]", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        tokens = [t for t in cleaned.split(" ") if t not in STOPWORDS and len(t) >= 3]
        return " ".join(tokens)

    def vectorize_with_coverage(cleaned: str):
        # Mirror server/mlEngine.ts vectorizeWithCoverage(): unigram+bigrams,
        # sublinear TF, artifact IDF and L2 normalization.
        words = cleaned.split(" ") if cleaned else []
        counts = {}
        for w in words:
            if len(w) >= 3:
                counts[w] = counts.get(w, 0) + 1
        for j in range(len(words) - 1):
            if len(words[j]) >= 3 and len(words[j + 1]) >= 3:
                bi = f"{words[j]} {words[j + 1]}"
                counts[bi] = counts.get(bi, 0) + 1

        vec = []
        norm_sq = 0.0
        for term, count in counts.items():
            if term in vocab:
                idx = vocab[term]
                tf = 1.0 + math.log(count)
                tfidf = tf * idf[idx]
                vec.append((idx, tfidf))
                norm_sq += tfidf * tfidf
        norm = math.sqrt(norm_sq) or 1.0
        normalized = [(idx, val / norm) for idx, val in vec]
        candidate_count = len(counts)
        matched_count = len(vec)
        coverage_ratio = matched_count / candidate_count if candidate_count else 0.0
        return normalized, candidate_count, matched_count, coverage_ratio

    def predict_prob(cleaned: str):
        tfidf, candidate_count, matched_count, coverage_ratio = vectorize_with_coverage(cleaned)
        member_margins = []
        member_probabilities = []
        for member in members:
            z = float(member["bias"])
            for idx, val in tfidf:
                z += float(member["weights"][idx]) * val
            exponent = max(-50.0, min(50.0, float(member["plattA"]) * z + float(member["plattB"])))
            member_margins.append(z)
            member_probabilities.append(1.0 / (1.0 + math.exp(exponent)))
        probability = sum(member_probabilities) / len(member_probabilities)
        return {
            "probability": probability,
            "decision_margin": sum(member_margins) / len(member_margins),
            "candidate_term_count": candidate_count,
            "matched_term_count": matched_count,
            "coverage_ratio": coverage_ratio,
        }

    def production_decision(statement: str, detail: dict):
        # Replicate the production article preflight and v3.1 policy. LIAR
        # statements are passed without a publisher URL, just like text mode.
        words = [word for word in re.split(r"\s+", statement.strip()) if word]
        # JavaScript String.length counts UTF-16 code units.
        text_length = len(statement.encode("utf-16-le")) // 2
        if text_length < min_text_length:
            return "NEEDS MORE CONTEXT", "insufficient_text_length", True
        if len(words) < min_word_count:
            return "NEEDS MORE CONTEXT", "insufficient_word_count", True
        if detail["coverage_ratio"] < min_vocabulary_coverage:
            return "NEEDS MORE CONTEXT", "low_vocabulary_coverage", True
        if (detail["candidate_term_count"] < ood_short_word_count
                and detail["coverage_ratio"] < ood_coverage_threshold):
            return "NEEDS MORE CONTEXT", "short_input_ood", True

        p_fake = js_round(detail["probability"], 4)
        if p_fake >= fake_threshold:
            return "LIKELY FAKE", None, False
        if p_fake <= real_threshold:
            return "LIKELY REAL", None, False
        return "NEEDS MORE CONTEXT", "uncertainty_zone", False

    # Read LIAR test.tsv
    tsv_path = Path("data/test.tsv")
    with open(tsv_path, "r", encoding="utf-8") as f:
        reader = csv.reader(f, delimiter="\t")
        rows = list(reader)

    total_test_samples = len(rows)
    raw_label_counts = Counter(r[1].strip().lower() for r in rows)

    mapping = {
        "pants-fire": "FAKE",
        "false": "FAKE",
        "mostly-true": "REAL",
        "true": "REAL",
    }
    excluded_labels = {"barely-true", "half-true"}

    label_audit = [
        {"original_label": "pants-fire", "binary_mapping": "FAKE", "count": raw_label_counts.get("pants-fire", 0), "status": "INCLUDED"},
        {"original_label": "false", "binary_mapping": "FAKE", "count": raw_label_counts.get("false", 0), "status": "INCLUDED"},
        {"original_label": "barely-true", "binary_mapping": "EXCLUDED", "count": raw_label_counts.get("barely-true", 0), "status": "EXCLUDED"},
        {"original_label": "half-true", "binary_mapping": "EXCLUDED", "count": raw_label_counts.get("half-true", 0), "status": "EXCLUDED"},
        {"original_label": "mostly-true", "binary_mapping": "REAL", "count": raw_label_counts.get("mostly-true", 0), "status": "INCLUDED"},
        {"original_label": "true", "binary_mapping": "REAL", "count": raw_label_counts.get("true", 0), "status": "INCLUDED"}
    ]

    predictions_log = []
    eligible_samples = 0
    excluded_samples = 0
    valid_text_samples = 0
    liar_all_word_counts = []
    liar_eligible_word_counts = []

    # Raw model-transfer diagnostic uses the conventional 0.50 cutoff only
    # to compare score direction. It is not the user-facing product verdict.
    raw_tp, raw_tn, raw_fp, raw_fn = 0, 0, 0, 0
    policy_tp, policy_tn, policy_fp, policy_fn = 0, 0, 0, 0
    decided_samples = 0
    abstained_samples = 0
    abstention_reasons = Counter()
    probability_exposed_count = 0

    for idx, r in enumerate(rows):
        statement_id = r[0] if len(r) > 0 else f"row-{idx}"
        raw_label = r[1].strip().lower() if len(r) > 1 else ""
        statement = r[2].strip() if len(r) > 2 else ""

        if statement:
            valid_text_samples += 1
            liar_all_word_counts.append(len(statement.split()))

        if raw_label in excluded_labels:
            excluded_samples += 1
            continue

        if raw_label not in mapping:
            excluded_samples += 1
            continue

        eligible_samples += 1
        mapped_binary = mapping[raw_label]
        liar_eligible_word_counts.append(len(statement.split()))
        cleaned = clean_text(statement)
        detail = predict_prob(cleaned)
        fake_prob = js_round(detail["probability"], 4)
        real_prob = js_round(1.0 - fake_prob, 4)

        # Raw cross-domain model-transfer metric (not production decision policy).
        pred_label = "FAKE" if fake_prob >= 0.5 else "REAL"
        confidence = fake_prob if pred_label == "FAKE" else real_prob
        confidence_pct = js_round(confidence * 100, 1)
        is_correct = (pred_label == mapped_binary)

        if mapped_binary == "FAKE" and pred_label == "FAKE":
            raw_tp += 1
        elif mapped_binary == "REAL" and pred_label == "REAL":
            raw_tn += 1
        elif mapped_binary == "REAL" and pred_label == "FAKE":
            raw_fp += 1
        elif mapped_binary == "FAKE" and pred_label == "REAL":
            raw_fn += 1

        production_verdict, abstention_reason, probabilities_withheld = production_decision(statement, detail)
        production_fake_prob = None if probabilities_withheld else fake_prob
        production_real_prob = None if probabilities_withheld else real_prob
        if probabilities_withheld:
            probability_exposed = False
        else:
            probability_exposed = True
            probability_exposed_count += 1

        if production_verdict == "NEEDS MORE CONTEXT":
            abstained_samples += 1
            abstention_reasons[abstention_reason or "unspecified"] += 1
            production_correct = None
        else:
            decided_samples += 1
            production_correct = (production_verdict == ("LIKELY FAKE" if mapped_binary == "FAKE" else "LIKELY REAL"))
            if mapped_binary == "FAKE" and production_verdict == "LIKELY FAKE":
                policy_tp += 1
            elif mapped_binary == "REAL" and production_verdict == "LIKELY REAL":
                policy_tn += 1
            elif mapped_binary == "REAL" and production_verdict == "LIKELY FAKE":
                policy_fp += 1
            elif mapped_binary == "FAKE" and production_verdict == "LIKELY REAL":
                policy_fn += 1

        predictions_log.append({
            "id": statement_id,
            "statement": statement,
            "original_liar_label": raw_label,
            "mapped_binary_label": mapped_binary,
            "predicted_label": pred_label,
            "fake_probability": fake_prob,
            "real_probability": real_prob,
            "confidence": confidence_pct,
            "is_correct": is_correct,
            "production_verdict": production_verdict,
            "production_abstention_reason": abstention_reason,
            "production_probability_withheld": probabilities_withheld,
            "production_fake_probability": production_fake_prob,
            "production_real_probability": production_real_prob,
            "production_is_correct_when_decided": production_correct,
            "vocabulary_coverage": {
                "candidate_terms": detail["candidate_term_count"],
                "matched_terms": detail["matched_term_count"],
                "ratio": js_round(detail["coverage_ratio"], 4)
            }
        })

    raw_metrics = classification_metrics(raw_tp, raw_tn, raw_fp, raw_fn)
    tp, tn, fp, fn = raw_tp, raw_tn, raw_fp, raw_fn
    accuracy = raw_metrics["accuracy"] or 0
    fake_precision = raw_metrics["precision_fake"] or 0
    fake_recall = raw_metrics["recall_fake"] or 0
    fake_f1 = raw_metrics["f1_fake"] or 0
    real_precision = raw_metrics["precision_real"] or 0
    real_recall = raw_metrics["recall_real"] or 0
    real_f1 = raw_metrics["f1_real"] or 0
    macro_f1 = raw_metrics["macro_f1"] or 0
    balanced_accuracy = raw_metrics["balanced_accuracy"] or 0
    production_metrics = classification_metrics(policy_tp, policy_tn, policy_fp, policy_fn)

    eval_result = {
        "schema_version": 2,
        "status": "COMPLETED",
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "dataset_name": "LIAR Benchmark (PolitiFact)",
        "file_used": "test.tsv",
        "model_version": model_version,
        "artifact_sha256": artifact_sha256,
        "dataset_sha256": hashlib.sha256(tsv_path.read_bytes()).hexdigest(),
        "model_inference_mode": inference_mode,
        "production_model": f"{model_name} (v{model_version})",
        "source_training_dataset": f"{src_label} — {dataset_status}",
        "evaluation_protocol": {
            "raw_model_transfer": "Exact 3-member calibrated ensemble scores with conventional 0.50 cutoff; diagnostic comparison only, not the product decision policy.",
            "production_policy": "Simulates the article runtime preflight (60 UTF-16 code units, 20 words without source), 0.10 minimum vocabulary coverage, short-input OOD guard, and artifact probability thresholds.",
            "fake_threshold": fake_threshold,
            "real_threshold": real_threshold,
            "min_text_length": min_text_length,
            "min_word_count_without_source": min_word_count,
            "min_vocabulary_coverage": min_vocabulary_coverage,
            "ood_short_candidate_term_count": ood_short_word_count,
            "ood_coverage_threshold": ood_coverage_threshold,
            "calibration_members_used": len(members),
            "uses_runtime_calibrated_ensemble": True
        },
        "training_sample_count": sample_count,
        "runtime_feature_space": f"{vocab_size:,} TF-IDF features (is_demo={is_demo})",
        "is_demo": is_demo,
        "model_weights_modified": False,
        "tf_idf_source": f"Fitted on training set ({vocab_size:,} terms, saved_model_artifacts.json)",
        "offline_artifact_note": "backend/models/vectorizer.joblib (Python artifact) corresponds to the same vocabulary used by the Node.js runtime artifact saved_model_artifacts.json.",
        "evaluation_type": "Out-of-domain external validation",
        "total_test_samples": total_test_samples,
        "valid_text_samples": valid_text_samples,
        "excluded_ambiguous_samples": excluded_samples,
        "eligible_binary_samples": eligible_samples,
        "binary_label_distribution": {
            "fake": sum(1 for p in predictions_log if p["mapped_binary_label"] == "FAKE"),
            "real": sum(1 for p in predictions_log if p["mapped_binary_label"] == "REAL")
        },
        "label_audit": label_audit,
        "metrics": {
            "accuracy": js_round(accuracy, 4),
            "precision": js_round(fake_precision, 4),
            "recall": js_round(fake_recall, 4),
            "f1_score": js_round(fake_f1, 4),
            "macro_f1": js_round(macro_f1, 4),
            "balanced_accuracy": js_round(balanced_accuracy, 4),
            "fake_class": {
                "label": "FAKE (1)",
                "precision": js_round(fake_precision, 4),
                "recall": js_round(fake_recall, 4),
                "f1_score": js_round(fake_f1, 4)
            },
            "real_class": {
                "label": "REAL (0)",
                "precision": js_round(real_precision, 4),
                "recall": js_round(real_recall, 4),
                "f1_score": js_round(real_f1, 4)
            }
        },
        "production_policy_metrics": {
            **{k: js_round(v, 4) if isinstance(v, (float, int)) and v is not None else v
               for k, v in production_metrics.items() if k != "confusion_matrix"},
            "total_eligible_samples": eligible_samples,
            "decided_samples": decided_samples,
            "abstained_samples": abstained_samples,
            "coverage_ratio": js_round(safe_ratio(decided_samples, eligible_samples) or 0, 4),
            "abstention_rate": js_round(safe_ratio(abstained_samples, eligible_samples) or 0, 4),
            "selective_accuracy": js_round(safe_ratio(policy_tp + policy_tn, decided_samples), 4)
                if decided_samples else None,
            "probability_exposed_samples": probability_exposed_count,
            "abstention_reason_counts": dict(sorted(abstention_reasons.items())),
            "confusion_matrix": production_metrics["confusion_matrix"],
            "interpretation": "Production policy abstentions are reported separately; abstentions are not counted as correct predictions."
        },
        "confusion_matrix": {
            "true_positive": tp,
            "true_negative": tn,
            "false_positive": fp,
            "false_negative": fn,
            "matrix": [[tn, fp], [fn, tp]],
            "labels": ["REAL (0)", "FAKE (1)"],
            "explanations": {
                "true_positive": "Fake statements correctly classified as Fake.",
                "true_negative": "Real statements correctly classified as Real.",
                "false_positive": "Real statements incorrectly classified as Fake.",
                "false_negative": "Fake statements incorrectly classified as Real."
            }
        },
        "text_length_stats": {
            "isot_overall": {
                "mean_words": 417.74,
                "median_words": 375.0,
                "min_words": 2,
                "max_words": 8148,
                "total_samples": 44898
            },
            "isot_true": {
                "mean_words": 395.59,
                "median_words": 369.0,
                "min_words": 4,
                "max_words": 5181,
                "total_samples": 21417
            },
            "isot_fake": {
                "mean_words": 437.93,
                "median_words": 378.0,
                "min_words": 2,
                "max_words": 8148,
                "total_samples": 23481
            },
            "liar_all": {
                "mean_words": round(statistics.mean(liar_all_word_counts), 2) if liar_all_word_counts else 0,
                "median_words": statistics.median(liar_all_word_counts) if liar_all_word_counts else 0,
                "min_words": min(liar_all_word_counts) if liar_all_word_counts else 0,
                "max_words": max(liar_all_word_counts) if liar_all_word_counts else 0,
                "total_samples": len(liar_all_word_counts)
            },
            "liar_eligible": {
                "mean_words": round(statistics.mean(liar_eligible_word_counts), 2) if liar_eligible_word_counts else 0,
                "median_words": statistics.median(liar_eligible_word_counts) if liar_eligible_word_counts else 0,
                "min_words": min(liar_eligible_word_counts) if liar_eligible_word_counts else 0,
                "max_words": max(liar_eligible_word_counts) if liar_eligible_word_counts else 0,
                "total_samples": len(liar_eligible_word_counts)
            }
        },
        "reuters_citation_stats": {
            "true_csv_total": 21417,
            "true_csv_reuters_count": 21378,
            "true_csv_reuters_percentage": 99.82,
            "fake_csv_total": 23481,
            "fake_csv_reuters_count": 322,
            "fake_csv_reuters_percentage": 1.37
        },
        "domain_shift_explanation": {
            "summary": "This report separates raw calibrated model-score transfer from the production decision policy. LIAR contains short political claims, while the article classifier is trained on long-form ISOT news articles; raw transfer metrics are diagnostic and must not be presented as real-world fake-news accuracy.",
            "production_model_characteristics": [
                f"Production Runtime Model: {model_name} (v{model_version}) with {vocab_size:,} TF-IDF features loaded from saved_model_artifacts.json",
                f"Training corpus: {src_label} — {dataset_status} (N≈{sample_count:,})" if sample_count else f"Training corpus: {src_label} — {dataset_status}",
                "Full article contexts with structured journalistic or sensationalist reporting patterns"
            ],
            "isot_characteristics": [
                f"Production Runtime Model: {model_name} (v{model_version}) with {vocab_size:,} TF-IDF features loaded from saved_model_artifacts.json",
                f"Training corpus: {src_label} — {dataset_status} (N≈{sample_count:,})" if sample_count else f"Training corpus: {src_label} — {dataset_status}",
                "Full article contexts with structured journalistic or sensationalist reporting patterns"
            ],
            "liar_characteristics": [
                "Short single-sentence political claims: mean 18.40 words, median 16.00 words (min: 2, max: 431; eligible N=790 mean: 18.03)",
                "PolitiFact fact-checking claims lacking journalistic wire datelines or article structure",
                "Sparse n-gram overlap with full-length news article vocabulary",
                "Fine-grained veracity continuum rather than clean binary article labeling"
            ],
            "conclusion": ("LIAR is out-of-domain for a full-article model and contains short political claims. Raw model-transfer metrics are a diagnostic comparison, not proof of truth or general real-world accuracy. "
                           "Production-policy coverage and selective metrics must be read alongside abstention counts; abstentions are not correct predictions.")
        },
        "sample_predictions": predictions_log[:30] # Save top 30 samples for UI inspection
    }

    # Save to the requested output path. The default preserves the historic
    # manual behavior; CI should pass an artifacts/ path to avoid mutating the
    # tracked report during test execution.
    out_path = args.output
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(eval_result, f, indent=2)

    print("=" * 60)
    print("LIAR EXTERNAL VALIDATION RESULTS")
    print("=" * 60)
    print(f"Total test samples:          {total_test_samples:,}")
    print(f"Valid text samples:          {valid_text_samples:,}")
    print(f"Excluded ambiguous samples:  {excluded_samples:,}")
    print(f"Eligible binary samples:     {eligible_samples:,}")
    print(f"  - Mapped FAKE (pants-fire + false): {eval_result['binary_label_distribution']['fake']:,}")
    print(f"  - Mapped REAL (mostly-true + true): {eval_result['binary_label_distribution']['real']:,}")
    print("-" * 60)
    print("RAW MODEL-TRANSFER DIAGNOSTIC (0.50 cutoff; not production verdict policy)")
    print(f"Accuracy:           {accuracy*100:.2f}% ({accuracy:.4f})")
    print(f"Precision (Fake):   {fake_precision:.4f}")
    print(f"Recall (Fake):      {fake_recall:.4f}")
    print(f"F1-Score (Fake):    {fake_f1:.4f}")
    print(f"Balanced Accuracy:  {balanced_accuracy*100:.2f}% ({balanced_accuracy:.4f})")
    print(f"Precision (Real):   {real_precision:.4f}")
    print(f"Recall (Real):      {real_recall:.4f}")
    print("-" * 60)
    print("Confusion Matrix:")
    print(f"  True Positive (TP, Fake as Fake):  {tp:,}")
    print(f"  True Negative (TN, Real as Real):  {tn:,}")
    print(f"  False Positive (FP, Real as Fake): {fp:,}")
    print(f"  False Negative (FN, Fake as Real): {fn:,}")
    print(f"  Total scored by raw diagnostic: {tp + tn + fp + fn:,} == {eligible_samples:,}")
    print("-" * 60)
    print("PRODUCTION POLICY SIMULATION (abstentions excluded from selective accuracy)")
    print(f"Decided:            {decided_samples:,} / {eligible_samples:,}")
    print(f"Abstained:          {abstained_samples:,} ({safe_ratio(abstained_samples, eligible_samples) or 0:.1%})")
    print(f"Coverage:           {safe_ratio(decided_samples, eligible_samples) or 0:.1%}")
    print(f"Selective accuracy: {safe_ratio(policy_tp + policy_tn, decided_samples):.2%}" if decided_samples else "Selective accuracy: N/A (no decided predictions)")
    print(f"Abstention reasons: {dict(sorted(abstention_reasons.items()))}")
    print(f"Report written:     {out_path}")
    print("=" * 60)

if __name__ == "__main__":
    run_evaluation()
