# TruthLens AI - Dataset Directory

This directory contains the training and evaluation dataset for the Fake News Detection Machine Learning Pipeline.

## Default Dataset Location
Place your custom dataset here as:
- `data/news.csv` or `data/dataset.csv`

The training pipeline automatically checks for:
1. `data/news.csv`
2. `data/sample_news.csv` (provided by default for development and testing)

---

## Supported Dataset Schema

The system automatically detects columns intelligently. Supported variations include:

### Format A (Standard Kaggle / ISOT)
```csv
title,text,label
"Article Title","Full body text of the article...","FAKE"
"Another Title","Credible journalistic reporting...","REAL"
```

### Format B (Text Only)
```csv
text,label
"Full news story here...","FAKE"
"Official verified announcement...","REAL"
```

### Label Normalization
The dataset preprocessor automatically handles:
- Strings: `"FAKE"`, `"REAL"`, `"fake"`, `"real"`, `"False"`, `"True"`, `"0"`, `"1"`
- Binary numeric: `0` (Real) and `1` (Fake), or vice versa with column detection
- Unreliable/Reliable labels: `"reliable"`, `"unreliable"`

---

## Recommended Public Benchmarks for Production Training

For large-scale university or research benchmarks, you can download and drop in:

1. **WELFake Dataset** (~72,000 articles)
   - [WELFake Dataset on Kaggle](https://www.kaggle.com/datasets/saurabhshahane/fake-news-classification)
   - Balanced collection combining Kaggle, McIntire, Reuters, and BuzzFeed.
2. **ISOT Fake News Dataset** (~45,000 articles)
   - University of Victoria Information Security and Object Technology research lab.
3. **Kaggle Fake News Competition Dataset** (~20,000 articles)
   - Contains `id`, `title`, `author`, `text`, `label`.

---

## Retraining the Model

Once you place `data/news.csv`, execute:
```bash
python3 backend/ml/train.py
```
or trigger the training dynamically from the web interface using the **"Retrain ML Pipeline"** button in the Model Dashboard.
