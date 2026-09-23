"""Regression checks for the real Windows launch and output contract."""
import copy
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from moneygraph import server
from moneygraph.analysis import OUTPUTS, verify_outputs, write_outputs


ROOT = Path(__file__).resolve().parents[1]


def test_csv_bytes_match_canonical_manifest(outputs):
    reference = json.loads((ROOT / "results" / "manifest.json").read_text(encoding="utf-8"))
    for filename in OUTPUTS:
        content = (outputs / filename).read_bytes()
        assert b"\r\n" not in content
        assert hashlib.sha256(content).hexdigest() == reference["output_sha256"][filename]


def test_manifest_with_unicode_filename_is_verified(analysis, tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    for filename in ("nodes.parquet", "edges.parquet", "transactions.parquet"):
        shutil.copyfile(ROOT / "data" / filename, data / filename)
    extra = data / "қосымша.txt"
    extra.write_text("Tyuin", encoding="utf-8")
    result = copy.deepcopy(analysis)
    result["manifest"]["input_sha256"][extra.name] = hashlib.sha256(extra.read_bytes()).hexdigest()
    out = tmp_path / "out"
    write_outputs(result, out)
    assert verify_outputs(data, out)["status"] == "ok"


@pytest.mark.parametrize("port", ["0", "-1", "65536", "invalid"])
def test_invalid_port_is_rejected_before_analysis(port, tmp_path):
    out = tmp_path / "out"
    process = subprocess.run(
        [sys.executable, "-m", "moneygraph", "demo", "--port", port,
         "--data", str(tmp_path / "missing"), "--out", str(out)],
        cwd=ROOT, capture_output=True, timeout=30,
    )
    assert process.returncode == 2
    assert not out.exists()


def test_missing_frontend_is_not_successful_readiness(analysis, outputs, tmp_path, monkeypatch):
    monkeypatch.setattr(server, "__file__", str(tmp_path / "server.py"))
    client = TestClient(server.create_app(analysis, outputs))
    assert client.get("/api/health").status_code == 200
    assert client.get("/").status_code == 503


def test_unknown_urls_never_return_index(analysis, outputs):
    client = TestClient(server.create_app(analysis, outputs))
    for path in ("/api/unknown", "/assets/missing.js", "/api/nodes/unknown",
                 "/api/exports/manifest.json", "/assets/%2e%2e/%2e%2e/requirements.lock"):
        assert client.get(path).status_code == 404


def test_missing_data_has_nonzero_exit(tmp_path):
    out = tmp_path / "out"
    process = subprocess.run(
        [sys.executable, "-m", "moneygraph", "run", "--data", str(tmp_path / "missing"), "--out", str(out)],
        cwd=ROOT, capture_output=True, timeout=30,
    )
    assert process.returncode == 1
    assert process.stderr
    assert not out.exists()
