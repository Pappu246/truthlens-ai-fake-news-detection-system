import os
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
MODELS_DIR = BASE_DIR / "backend" / "models"
DB_DIR = BASE_DIR / "backend" / "database"
DB_PATH = DB_DIR / "truthlens.db"

DATA_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)
DB_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_DATASET_PATH = DATA_DIR / "news.csv"
SAMPLE_DATASET_PATH = DATA_DIR / "sample_news.csv"

# Decision boundary thresholds for 3-level output
# Underlying model predicts probability of FAKE (label 1)
# Configurable via environment variables or runtime settings
DEFAULT_FAKE_THRESHOLD = float(os.getenv("FAKE_THRESHOLD", "0.65"))
DEFAULT_REAL_THRESHOLD = float(os.getenv("REAL_THRESHOLD", "0.35"))

FAKE_THRESHOLD = DEFAULT_FAKE_THRESHOLD
REAL_THRESHOLD = DEFAULT_REAL_THRESHOLD

def get_thresholds():
    return {
        "fake_threshold": FAKE_THRESHOLD,
        "real_threshold": REAL_THRESHOLD,
        "uncertainty_zone": f"{REAL_THRESHOLD:.2f} - {FAKE_THRESHOLD:.2f}"
    }

def update_thresholds(fake_threshold: float, real_threshold: float):
    global FAKE_THRESHOLD, REAL_THRESHOLD
    if real_threshold >= fake_threshold:
        raise ValueError(f"REAL_THRESHOLD ({real_threshold}) must be strictly less than FAKE_THRESHOLD ({fake_threshold})")
    if not (0.0 < real_threshold < 1.0) or not (0.0 < fake_threshold < 1.0):
        raise ValueError("Thresholds must be between 0.0 and 1.0 exclusive")
    REAL_THRESHOLD = round(real_threshold, 4)
    FAKE_THRESHOLD = round(fake_threshold, 4)
    return get_thresholds()

MODEL_ARTIFACT = MODELS_DIR / "best_model.joblib"
VECTORIZER_ARTIFACT = MODELS_DIR / "vectorizer.joblib"
METRICS_ARTIFACT = MODELS_DIR / "metrics.json"
