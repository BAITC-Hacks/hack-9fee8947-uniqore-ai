import json

import httpx
import pytest
from fastapi.testclient import TestClient

from moneygraph.server import create_app


@pytest.fixture
def client(analysis, outputs, monkeypatch):
    for name in ("LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    return TestClient(create_app(analysis, outputs))


def test_shared_snapshot_and_all_exports(client, analysis, outputs):
    graph = client.get("/api/analysis").json()
    assert graph["analysis_id"] == analysis["analysis_id"]
    assert graph["assistant_available"] is False
    for n in [min(analysis["nodes"], key=lambda n: n["rank"]), next(n for n in analysis["nodes"] if n["isolated"]), next(n for n in analysis["nodes"] if n["boundary"])]:
        response = client.get(f'/api/nodes/{n["gid"]}')
        assert response.status_code == 200
        dossier = response.json()
        assert dossier["node"] == n and dossier["analysis_id"] == graph["analysis_id"]
        assert sum(t["amount"] for t in dossier["transactions"] if t["dst"] == n["gid"]) == pytest.approx(n["in_amount"])
    for filename in ("nodes_roles.csv", "clusters.csv", "top_nodes.csv"):
        response = client.get(f"/api/exports/{filename}")
        assert response.status_code == 200
        assert response.headers["X-Analysis-ID"] == graph["analysis_id"]
        assert response.content == (outputs / filename).read_bytes()
    assert client.get("/api/nodes/unknown").status_code == 404
    assert client.get("/api/clusters/-1").status_code == 404
    assert client.get("/api/exports/manifest.json").status_code == 404


def test_local_explanation_without_key(client, analysis):
    n = analysis["nodes"][0]
    response = client.post(f'/api/nodes/{n["gid"]}/explain', json={"question": "role"})
    assert response.json()["text"] == n["evidence"]
    assert response.json()["mode"] == "local"
    assert client.post(f'/api/nodes/{n["gid"]}/explain', json={"question": "invent"}).status_code == 422


@pytest.mark.parametrize("mode", ["valid", "unknown_evidence", "bad_json", "timeout"])
def test_optional_ai_contract_and_fallback(client, analysis, monkeypatch, mode):
    monkeypatch.setenv("LLM_BASE_URL", "https://example.invalid/v1")
    monkeypatch.setenv("LLM_MODEL", "test-model")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    n = analysis["nodes"][0]
    captured = []

    async def post(self, url, **kwargs):
        captured.append(kwargs["json"])
        if mode == "timeout":
            raise httpx.ReadTimeout("Test timeout")
        answer = json.dumps({"text": "Гипотеза требует проверки полноты данных.", "evidence_ids": ["role" if mode == "valid" else "invented"]})
        return httpx.Response(200, request=httpx.Request("POST", url), json={"choices": [{"message": {"content": "not-json" if mode == "bad_json" else answer}}]})

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    response = client.post(f'/api/nodes/{n["gid"]}/explain', json={"question": "role"}).json()
    assert response["mode"] == ("ai" if mode == "valid" else "local")
    sent = json.dumps(captured)
    assert n["gid"] not in sent and "transactions" not in sent
    assert response["analysis_id"] == analysis["analysis_id"]


def test_exports_stay_bound_to_loaded_snapshot(analysis, outputs, tmp_path):
    from moneygraph.analysis import OUTPUTS
    for filename in OUTPUTS:
        (tmp_path / filename).write_bytes((outputs / filename).read_bytes())
    snapshot = TestClient(create_app(analysis, tmp_path))
    (tmp_path / "top_nodes.csv").write_text("different analysis")
    assert snapshot.get("/api/exports/top_nodes.csv").content == (outputs / "top_nodes.csv").read_bytes()
