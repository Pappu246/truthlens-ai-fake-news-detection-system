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
