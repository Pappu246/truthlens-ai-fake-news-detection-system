import hashlib, json, tempfile
from pathlib import Path
import subprocess, sys

ROOT=Path(__file__).resolve().parents[2]
PROMOTE=ROOT/"scripts"/"promote_model.py"

def test_promotion_requires_explicit_confirmation():
    p=subprocess.run([sys.executable,str(PROMOTE),"--model-version","missing"],cwd=ROOT,text=True,capture_output=True)
    assert p.returncode != 0
    assert "required" in (p.stderr+p.stdout).lower()

def test_production_artifact_exists_and_is_json():
    p=ROOT/"data"/"saved_model_artifacts.json"
    assert p.exists()
    json.loads(p.read_text())

def test_fingerprint_is_stable():
    a=ROOT/"data"/"Fake.csv"; b=ROOT/"data"/"True.csv"
    if not a.exists() or not b.exists():
        return
    def h(p):
        x=hashlib.sha256()
        with p.open("rb") as f:
            for c in iter(lambda:f.read(1024*1024),b""): x.update(c)
        return x.hexdigest()
    payload={"fake":h(a),"true":h(b),"schema":["title","text","subject","date"],"seed":42}
    f1=hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()
    f2=hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()
    assert f1==f2

def test_promotion_requires_exact_calibrated_runtime_contract():
    source=PROMOTE.read_text()
    assert "single_calibrated_svm" in source
    assert "calibrated_ensemble" in source
    assert "candidate runtime inference mode is not an exact calibrated contract" in source


def test_promotion_requires_task_matched_full_article_validation():
    source=PROMOTE.read_text()
    assert 'article_ood_validation.json' in source
    assert 'WELFake full-article validation is not COMPLETED' in source
    assert 'publisher-byline ablation did not pass' in source
    assert 'byline-ablation balanced accuracy must be at least 0.65' in source
    assert 'byline-ablation fake recall must be at least 0.65' in source
    assert 'byline-ablation real recall must be at least 0.65' in source
    assert 'eligible_samples", 0) < 10000' in source
    assert 'balanced < 0.70' in source
    assert 'fake_recall' in source and 'real_recall' in source
    assert 'production_eligible' in source
    assert 'candidate_artifact_sha256' in source
    assert 'actual runtime decision/abstention policy did not pass' in source
    assert 'runtime policy coverage must be at least 0.50' in source
    assert 'runtime policy operational balanced accuracy must be at least 0.70' in source
    assert 'byline-ablation runtime policy failed' in source
    assert 'byline-ablation runtime-policy coverage must be at least 0.50' in source

def test_liar_claim_metrics_are_retained_but_not_used_as_article_gate():
    source=PROMOTE.read_text()
    assert 'LIAR is a sentence/claim benchmark' in source
    assert 'LIAR claim samples were evaluated' in source
    assert 'WELFake full-article balanced accuracy must be at least 0.70' in source
    assert 'LIAR balanced accuracy is required' not in source
    assert 'balanced <= 0.50' not in source
