import csv
import json
import re
import math
from datetime import datetime
from pathlib import Path
from collections import Counter

def run_evaluation():
    # Load production runtime artifacts (Linear SVM Calibrated, 2,910 features)
    with open("data/saved_model_artifacts.json", "r", encoding="utf-8") as f:
        artifact = json.load(f)

    vocab = artifact["vocabulary"]
    idf = artifact["idf"]
    weights = artifact["selected_model"]["weights"]
    bias = artifact["selected_model"]["bias"]
    plattA = artifact["selected_model"]["plattA"]
    plattB = artifact["selected_model"]["plattB"]
    thresholds = artifact.get("thresholds", {"fake_threshold": 0.65, "real_threshold": 0.35, "min_text_length": 60})

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

    def vectorize(cleaned: str):
        words = cleaned.split(" ") if cleaned else []
        counts = {}
        for w in words:
            if len(w) >= 3:
                counts[w] = counts.get(w, 0) + 1
        for j in range(len(words) - 1):
            if len(words[j]) >= 3 and len(words[j+1]) >= 3:
                bi = f"{words[j]} {words[j+1]}"
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
        return [(idx, val / norm) for idx, val in vec]

    def predict_prob(cleaned: str):
        tfidf = vectorize(cleaned)
        z = bias
        for idx, val in tfidf:
            z += weights[idx] * val
        prob_fake = 1.0 / (1.0 + math.exp(plattA * z + plattB))
        prob_fake = min(max(prob_fake, 0.0001), 0.9999)
        return z, prob_fake

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

    tp, tn, fp, fn = 0, 0, 0, 0

    for idx, r in enumerate(rows):
        statement_id = r[0] if len(r) > 0 else f"row-{idx}"
        raw_label = r[1].strip().lower() if len(r) > 1 else ""
        statement = r[2].strip() if len(r) > 2 else ""

        if statement:
            valid_text_samples += 1

        if raw_label in excluded_labels:
            excluded_samples += 1
            continue

        if raw_label not in mapping:
            excluded_samples += 1
            continue

        eligible_samples += 1
        mapped_binary = mapping[raw_label]
        cleaned = clean_text(statement)
        z, fake_prob = predict_prob(cleaned)
        real_prob = round(1.0 - fake_prob, 4)
        fake_prob = round(fake_prob, 4)

        # Binary prediction using standard 0.5 decision boundary:
        # FAKE is class 1 (fake_prob >= 0.5), REAL is class 0 (fake_prob < 0.5)
        pred_label = "FAKE" if fake_prob >= 0.5 else "REAL"

        # TruthLens confidence calculation:
        # If fake_prob >= 0.5, confidence is fake_prob, else real_prob
        confidence = fake_prob if pred_label == "FAKE" else real_prob
        confidence_pct = round(confidence * 100, 1)

        is_correct = (pred_label == mapped_binary)

        if mapped_binary == "FAKE" and pred_label == "FAKE":
            tp += 1
        elif mapped_binary == "REAL" and pred_label == "REAL":
            tn += 1
        elif mapped_binary == "REAL" and pred_label == "FAKE":
            fp += 1
        elif mapped_binary == "FAKE" and pred_label == "REAL":
            fn += 1

        predictions_log.append({
            "id": statement_id,
            "statement": statement,
            "original_liar_label": raw_label,
            "mapped_binary_label": mapped_binary,
            "predicted_label": pred_label,
            "fake_probability": fake_prob,
            "real_probability": real_prob,
            "confidence": confidence_pct,
            "is_correct": is_correct
        })

    total_eval = tp + tn + fp + fn
    accuracy = (tp + tn) / total_eval if total_eval > 0 else 0
    fake_precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    fake_recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    fake_f1 = (2 * fake_precision * fake_recall / (fake_precision + fake_recall)) if (fake_precision + fake_recall) > 0 else 0

    real_precision = tn / (tn + fn) if (tn + fn) > 0 else 0
    real_recall = tn / (tn + fp) if (tn + fp) > 0 else 0
    real_f1 = (2 * real_precision * real_recall / (real_precision + real_recall)) if (real_precision + real_recall) > 0 else 0

    # Macro F1
    macro_f1 = (fake_f1 + real_f1) / 2.0
    # Balanced Accuracy = (Recall_fake + Recall_real) / 2
    balanced_accuracy = (fake_recall + real_recall) / 2.0

    eval_result = {
        "status": "COMPLETED",
        "evaluated_at": datetime.utcnow().isoformat() + "Z",
        "dataset_name": "LIAR Benchmark (PolitiFact)",
        "file_used": "test.tsv",
        "production_model": f"{model_name} (v{model_version})",
        "source_training_dataset": f"{src_label} — {dataset_status}",
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
            "accuracy": round(accuracy, 4),
            "precision": round(fake_precision, 4),
            "recall": round(fake_recall, 4),
            "f1_score": round(fake_f1, 4),
            "macro_f1": round(macro_f1, 4),
            "balanced_accuracy": round(balanced_accuracy, 4),
            "fake_class": {
                "label": "FAKE (1)",
                "precision": round(fake_precision, 4),
                "recall": round(fake_recall, 4),
                "f1_score": round(fake_f1, 4)
            },
            "real_class": {
                "label": "REAL (0)",
                "precision": round(real_precision, 4),
                "recall": round(real_recall, 4),
                "f1_score": round(real_f1, 4)
            }
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
                "mean_words": 18.40,
                "median_words": 16.0,
                "min_words": 2,
                "max_words": 431,
                "total_samples": 1267
            },
            "liar_eligible": {
                "mean_words": 18.03,
                "median_words": 16.0,
                "min_words": 2,
                "max_words": 205,
                "total_samples": 790
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
            "summary": "External validation measures how the production runtime model generalizes to a completely different dataset, genre, and text structure.",
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
            "conclusion": ("Lower performance on LIAR reflects substantial domain shift and structural differences "
                           "(isolated short claim without article context vs. full news article), rather than an algorithmic flaw in the production model. "
                           "The ISOT-trained classifier detects linguistic patterns characteristic of full news articles and is not a substitute for fact-checking short isolated claims.")
        },
        "sample_predictions": predictions_log[:30] # Save top 30 samples for UI inspection
    }

    # Save to data/external_validation.json
    out_path = Path("data/external_validation.json")
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
    print(f"  Total verified: {tp + tn + fp + fn:,} == {eligible_samples:,}")
    print("=" * 60)

if __name__ == "__main__":
    run_evaluation()
