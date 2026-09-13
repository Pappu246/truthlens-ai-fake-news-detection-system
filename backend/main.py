import os
import json
from pathlib import Path
from typing import Optional, Dict, Any, List
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.config import (
    METRICS_ARTIFACT,
    DEFAULT_DATASET_PATH,
    SAMPLE_DATASET_PATH,
    get_thresholds,
    update_thresholds
)
from backend.ml.predict import analyze_news_article, reload_artifacts, load_artifacts
from backend.ml.train import train_and_evaluate
from backend.database.db import (
    get_all_history,
    get_history_by_id,
    delete_history_item,
    clear_all_history
)

app = FastAPI(
    title="TruthLens AI - Fake News Detection API",
    description="Machine Learning API for probabilistic Fake News risk analysis, feature attribution, and evaluation benchmarks.",
    version="1.0.0"
)

# Enable CORS for local Vite and preview containers
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Request Models
class AnalyzeRequest(BaseModel):
    text: str = Field(..., description="The news article headline and/or body text to analyze", min_length=1)
    source_url: Optional[str] = Field(default="", description="Optional URL of the publisher or publication source")
    fake_threshold: Optional[float] = Field(default=None, description="Custom probability threshold for FAKE classification")
    real_threshold: Optional[float] = Field(default=None, description="Custom probability threshold for REAL classification")

class ThresholdUpdateRequest(BaseModel):
    fake_threshold: float = Field(..., description="Probability threshold for FAKE (e.g. 0.65)")
    real_threshold: float = Field(..., description="Probability threshold for REAL (e.g. 0.35)")

@app.on_event("startup")
def startup_event():
    # Ensure model is ready and database initialized
    try:
        load_artifacts()
    except Exception as e:
        print(f"[Warning] Failed to preload artifacts during startup: {e}")

@app.get("/api/health")
def health_check():
    has_metrics = METRICS_ARTIFACT.exists()
    has_dataset = DEFAULT_DATASET_PATH.exists() or SAMPLE_DATASET_PATH.exists()
    thresholds = get_thresholds()
    
    return {
        "status": "healthy",
        "service": "TruthLens AI Detection Engine",
        "model_loaded": has_metrics,
        "dataset_available": has_dataset,
        "active_thresholds": thresholds
    }

@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="News article text cannot be empty.")
        
    text_stripped = req.text.strip()
    if len(text_stripped) < 15:
        raise HTTPException(status_code=400, detail="Article text is too short. Please provide at least 15 characters.")
        
    if len(text_stripped) > 50000:
        raise HTTPException(status_code=400, detail="Article text exceeds the maximum character limit (50,000 characters).")
        
    try:
        result = analyze_news_article(
            text_stripped,
            source_url=req.source_url,
            fake_threshold=req.fake_threshold,
            real_threshold=req.real_threshold
        )
        return result
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except RuntimeError as re:
        raise HTTPException(status_code=500, detail=str(re))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference error: {str(e)}")

@app.get("/api/model/diagnostics")
@app.get("/api/models/diagnostics")
def get_diagnostics():
    """
    Model diagnostics endpoint showing:
    - model type & calibration status
    - dataset size & split statistics
    - feature count (TF-IDF vocabulary)
    - label distribution (class counts & ratios)
    - evaluation metrics (accuracy, precision, recall, F1, confusion matrix)
    - active decision thresholds & uncertainty zone
    """
    if not METRICS_ARTIFACT.exists():
        try:
            train_and_evaluate()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to generate model diagnostics: {str(e)}")
            
    try:
        with open(METRICS_ARTIFACT, "r") as f:
            data = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read metrics artifact: {str(e)}")

    best_model_info = data.get("best_model", {})
    dataset_info = data.get("dataset_info", {})
    models_info = data.get("models", {})
    thresholds = get_thresholds()

    total_samples = dataset_info.get("total_samples", 0)
    real_samples = dataset_info.get("real_samples", 0)
    fake_samples = dataset_info.get("fake_samples", 0)

    return {
        "status": "operational",
        "model_type": best_model_info.get("name", "Linear SVM (Calibrated)"),
        "model_architecture": "CalibratedClassifierCV(LinearSVC) with Platt Scaling (Sigmoid)",
        "calibration": {
            "method": "sigmoid (Platt scaling)",
            "is_calibrated": True,
            "description": "Linear SVM decision margins are mapped to well-calibrated posterior probabilities via CalibratedClassifierCV."
        },
        "dataset_size": {
            "total_samples": total_samples,
            "train_samples": dataset_info.get("train_samples", 0),
            "test_samples": dataset_info.get("test_samples", 0),
            "source_path": dataset_info.get("source_path", "data/news.csv")
        },
        "feature_count": dataset_info.get("vocabulary_size", 0),
        "vectorizer": "TF-IDF (1-2 ngrams, sublinear tf)",
        "label_distribution": {
            "real_count": real_samples,
            "fake_count": fake_samples,
            "real_percentage": round((real_samples / total_samples * 100) if total_samples else 0, 2),
            "fake_percentage": round((fake_samples / total_samples * 100) if total_samples else 0, 2)
        },
        "evaluation_metrics": {
            "best_model_metrics": best_model_info.get("metrics", {}),
            "logistic_regression_metrics": models_info.get("logistic_regression", {}).get("metrics", {}),
            "linear_svm_metrics": models_info.get("linear_svm", {}).get("metrics", {})
        },
        "thresholds": thresholds,
        "trained_at": data.get("trained_at")
    }

@app.get("/api/model/thresholds")
def get_threshold_config():
    return get_thresholds()

@app.post("/api/model/thresholds")
def set_threshold_config(req: ThresholdUpdateRequest):
    try:
        updated = update_thresholds(req.fake_threshold, req.real_threshold)
        return {
            "message": "Decision thresholds successfully updated.",
            "thresholds": updated
        }
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))

@app.get("/api/models/metrics")
def get_metrics():
    """
    Returns actual generated model evaluation metrics comparing Logistic Regression & Linear SVM.
    Never hardcoded or fabricated.
    """
    if not METRICS_ARTIFACT.exists():
        # Trigger initial training if metrics file doesn't exist yet
        try:
            results = train_and_evaluate()
            return results
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Model metrics not available and training failed: {str(e)}")
            
    try:
        with open(METRICS_ARTIFACT, "r") as f:
            data = json.load(f)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read model evaluation file: {str(e)}")

@app.post("/api/train")
def trigger_training():
    """
    Triggers the ML training pipeline on the current dataset,
    re-evaluates both models, selects the best model, and reloads memory cache.
    """
    try:
        results = train_and_evaluate()
        reload_artifacts()
        return {
            "message": "Model training pipeline successfully completed.",
            "results": results
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Training pipeline execution failed: {str(e)}")

@app.get("/api/history")
def list_history(limit: int = Query(default=50, ge=1, le=100)):
    try:
        return get_all_history(limit=limit)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load history: {str(e)}")

@app.get("/api/history/{record_id}")
def get_history_detail(record_id: int):
    item = get_history_by_id(record_id)
    if not item:
        raise HTTPException(status_code=404, detail="History record not found.")
    return item

@app.delete("/api/history/{record_id}")
def delete_history(record_id: int):
    success = delete_history_item(record_id)
    if not success:
        raise HTTPException(status_code=404, detail="History record not found or already deleted.")
    return {"message": f"Record {record_id} successfully deleted."}

@app.delete("/api/history")
def clear_history():
    count = clear_all_history()
    return {"message": f"Cleared {count} history record(s)."}

@app.get("/api/dataset/info")
def get_dataset_info():
    target = DEFAULT_DATASET_PATH if DEFAULT_DATASET_PATH.exists() else SAMPLE_DATASET_PATH
    if not target.exists():
        return {
            "found": False,
            "message": "No dataset file found in data/."
        }
        
    import pandas as pd
    try:
        df = pd.read_csv(target)
        columns = list(df.columns)
        total_rows = len(df)
        return {
            "found": True,
            "path": str(target.name),
            "total_records": total_rows,
            "columns": columns,
            "sample_preview": df.head(3).to_dict(orient="records")
        }
    except Exception as e:
        return {
            "found": True,
            "path": str(target.name),
            "error": str(e)
        }

@app.get("/api/examples")
def get_demo_examples():
    return [
        {
            "id": "real-1",
            "title": "Example: Likely Real (Peer-Reviewed Science)",
            "category": "Science / Astrophysics",
            "expected_outcome": "LIKELY REAL",
            "source_url": "https://www.nasa.gov/press-release/james-webb-star-formation",
            "text": "Astronomers utilizing the James Webb Space Telescope have captured unprecedented infrared observations of star-forming regions in the nearby NGC 346 cluster. According to peer-reviewed findings published this week in the Astrophysical Journal, spectroscopic data confirms molecular hydrogen density variations consistent with theoretical models of stellar nurseries. Lead astrophysicists stated that the observations provide critical calibration measurements for understanding galactic evolution during the cosmic noon epoch. Further telemetry data have been archived at the Space Telescope Science Institute for open academic inquiry."
        },
        {
            "id": "fake-1",
            "title": "Example: Likely Fake (Sensational Conspiracy)",
            "category": "Clickbait / Misinformation",
            "expected_outcome": "LIKELY FAKE",
            "source_url": "",
            "text": "SHOCKING SECRET EXPOSED BY MILITARY WHISTLEBLOWER! Alien mothership cloaked behind the moon has been detected! The mainstream corrupt media and globalist elites are frantically censoring this unbelievable miracle video! Top insiders confirm that world leaders signed a secret treaty allowing deep-state extraction operations in exchange for zero-point energy weapons! Share this emergency alert immediately before they delete the internet! Wake up people!"
        },
        {
            "id": "ambiguous-1",
            "title": "Example: Ambiguous / Suspicious (Unattributed Press Claim)",
            "category": "Commercial PR / Unverified Rumor",
            "expected_outcome": "SUSPICIOUS",
            "source_url": "https://unverified-tech-leaks.blog",
            "text": "Insiders claim that a groundbreaking quantum computing processor may launch ahead of schedule next month, according to unconfirmed supply chain rumors circulating in Asian markets. Early reports suggest performance improvements of up to 400 percent over existing silicon architectures, though independent benchmarks have not yet been made public. Company representatives declined to comment on future product roadmaps or verify specifications."
        }
    ]
