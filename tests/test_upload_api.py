"""Imports exercise the real pipeline while keeping sessions independent."""
import asyncio
import io
import threading
import time
from pathlib import Path

import pandas as pd
import pytest
import httpx
from fastapi.testclient import TestClient

from moneygraph import datasets
from moneygraph import server
from moneygraph.analysis import DataError
from moneygraph.server import create_app


@pytest.fixture
def client(analysis, outputs, monkeypatch):
    for name in ("LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    return TestClient(create_app(analysis, outputs))


def upload_files(base=9_000_000):
    frames = {
        "nodes": pd.DataFrame({"gid": [base, base + 1, base + 2], "depth": [0, 1, 2], "is_seed": [True, False, False]}),
        "edges": pd.DataFrame({"src": [base, base + 1], "dst": [base + 1, base + 2],
                               "sum_kzt": [12_000.0, 10_000.0], "n_tx": [1, 1], "depth": [1, 2]}),
        "transactions": pd.DataFrame({"src": [base, base + 1], "dst": [base + 1, base + 2],
                                      "date": pd.to_datetime(["2026-07-02", "2026-07-03"]), "sum_kzt": [12_000.0, 10_000.0]}),
    }
    return {name: (f"{name}.parquet", frame.to_parquet(index=False), "application/octet-stream")
            for name, frame in frames.items()}


def import_headers(client, files=None):
    response = client.post("/api/datasets", files=files or upload_files())
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    return {"X-Dataset-ID": response.json()["dataset_id"]}, response.json()["analysis_id"]


def test_upload_scopes_every_view_and_export_without_replacing_startup(client, analysis):
    startup_export = client.get("/api/exports/nodes_roles.csv").content
    headers, analysis_id = import_headers(client)
    assert analysis_id != analysis["analysis_id"]
    graph = client.get("/api/analysis", headers=headers).json()
    assert graph["analysis_id"] == analysis_id
    assert len(graph["nodes"]) == 3
    assert graph["dataset"]["source"] == "uploaded"
    assert graph["dataset"]["transient"] is True
    assert 0 < graph["dataset"]["expires_in_seconds"] <= 3600
    assert graph["dataset"]["verification"] == {"status": "passed"}
    assert graph["dataset"]["full_run_seconds"] >= graph["dataset"]["calculation_seconds"]
    assert all("/" not in file["name"] for file in graph["dataset"]["files"])
    assert client.get("/api/health", headers=headers).json()["analysis_id"] == analysis_id
    node = client.get("/api/nodes/9000001", headers=headers).json()
    assert node["analysis_id"] == analysis_id
    assert len(node["transactions"]) == 2
    assert {neighbor["gid"] for neighbor in node["neighbors"]} == {"9000000", "9000002"}
    assert client.get("/api/nodes/9000001").status_code == 404
    group = client.get(f'/api/clusters/{graph["clusters"][0]["cluster_id"]}', headers=headers).json()
    assert group["analysis_id"] == analysis_id
    explanation = client.post("/api/nodes/9000001/explain", headers=headers, json={"question": "role"}).json()
    assert explanation["analysis_id"] == analysis_id
    assert explanation["text"] == node["node"]["evidence"]
    for name in ("nodes_roles.csv", "clusters.csv", "top_nodes.csv"):
        response = client.get(f"/api/exports/{name}", headers=headers)
        assert response.headers["x-analysis-id"] == analysis_id
        assert response.headers["cache-control"] == "no-store"
        frame = pd.read_csv(io.BytesIO(response.content))
        if "gid" in frame:
            assert set(frame.gid) == {9000000, 9000001, 9000002}
    assert client.get("/api/analysis").json()["analysis_id"] == analysis["analysis_id"]
    assert client.get("/api/analysis").json()["dataset"]["source"] == "startup"
    assert client.get("/api/exports/nodes_roles.csv").content == startup_export


def test_two_uploaded_snapshots_are_isolated_and_delete_does_not_reset_others(client, analysis):
    first, first_id = import_headers(client)
    second, second_id = import_headers(client, upload_files(8_000_000))
    assert first["X-Dataset-ID"] != second["X-Dataset-ID"]
    assert first_id != second_id
    assert client.get("/api/nodes/9000001", headers=second).status_code == 404
    assert client.get("/api/analysis", headers=first).json()["analysis_id"] == first_id
    assert client.delete("/api/datasets/current", headers=first).status_code == 204
    assert client.get("/api/analysis", headers=first).status_code == 410
    assert client.get("/api/analysis", headers=second).json()["analysis_id"] == second_id
    assert client.delete("/api/datasets/current").status_code == 204
    assert client.get("/api/analysis").json()["analysis_id"] == analysis["analysis_id"]


def test_failed_replacement_keeps_active_upload_and_its_export(client):
    headers, analysis_id = import_headers(client)
    before = client.get("/api/exports/nodes_roles.csv", headers=headers).content
    files = upload_files(8_000_000)
    files["transactions"] = ("transactions.parquet", b"corrupt")
    assert client.post("/api/datasets", files=files).status_code == 422
    assert client.get("/api/analysis", headers=headers).json()["analysis_id"] == analysis_id
    assert client.get("/api/exports/nodes_roles.csv", headers=headers).content == before
    assert len(client.app.state.datasets.uploaded) == 1


@pytest.mark.parametrize("case", ["missing", "duplicate", "extra", "filename", "corrupt", "empty", "schema", "nested", "mismatch"])
def test_invalid_import_keeps_existing_snapshots(client, analysis, case):
    files = upload_files()
    if case == "missing":
        del files["edges"]
    elif case == "duplicate":
        files = [("nodes", files["nodes"]), ("nodes", files["nodes"]), ("transactions", files["transactions"])]
    elif case == "extra":
        files["unexpected"] = ("extra.txt", b"ignored")
    elif case == "filename":
        files["nodes"] = ("../nodes.parquet", files["nodes"][1])
    elif case in {"corrupt", "empty"}:
        files["nodes"] = ("nodes.parquet", b"invalid parquet" if case == "corrupt" else b"")
    elif case in {"schema", "nested"}:
        frame = pd.DataFrame({"gid": [[1]] if case == "nested" else [1], "depth": [0], "is_seed": [True]})
        if case == "schema":
            frame["extra"] = ["unbounded blob"]
        files["nodes"] = ("nodes.parquet", frame.to_parquet(index=False))
    elif case == "mismatch":
        frame = pd.read_parquet(io.BytesIO(files["edges"][1]))
        frame.loc[0, "sum_kzt"] = 90_000.0
        files["edges"] = ("edges.parquet", frame.to_parquet(index=False))
    response = client.post("/api/datasets", files=files)
    assert response.status_code == 422, response.text
    assert isinstance(response.json()["detail"], str)
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/api/analysis").json()["analysis_id"] == analysis["analysis_id"]
    assert not client.app.state.datasets.uploaded


def test_limits_are_checked_before_dataframe_decode(client, monkeypatch):
    def no_decode(*args, **kwargs):
        pytest.fail("Limit must be enforced before dataframe decode")

    monkeypatch.setattr(datasets, "load_and_analyze", no_decode)
    with monkeypatch.context() as limited:
        limited.setitem(datasets.MAX_ROWS, "nodes", 2)
        response = client.post("/api/datasets", files=upload_files())
        assert response.status_code == 413 and "строк" in response.json()["detail"]
    with monkeypatch.context() as limited:
        limited.setattr(datasets, "MAX_UNCOMPRESSED_BYTES", 1)
        response = client.post("/api/datasets", files=upload_files())
        assert response.status_code == 413 and "распаковки" in response.json()["detail"]
    with monkeypatch.context() as limited:
        limited.setattr(datasets, "MAX_FILE_BYTES", 20)
        response = client.post("/api/datasets", files=upload_files())
        assert response.status_code == 413 and "файла" in response.json()["detail"]
    assert not client.app.state.datasets.uploaded


@pytest.mark.parametrize("declared", [None, "1", "999999999"])
def test_request_body_limit_includes_multipart_and_handles_chunked_or_false_length(client, monkeypatch, declared):
    monkeypatch.setattr(datasets, "MAX_REQUEST_BYTES", 100)
    headers = {"content-type": "multipart/form-data; boundary=test"}
    if declared is not None:
        headers["content-length"] = declared
    response = client.post("/api/datasets", content=iter([b"a" * 60, b"b" * 60]), headers=headers)
    assert response.status_code == 413
    assert response.headers["cache-control"] == "no-store"
    assert not client.app.state.datasets.import_lock.locked()


def test_capacity_busy_expiry_and_no_store(client, monkeypatch):
    monkeypatch.setattr(datasets, "MAX_DATASETS", 1)
    store = client.app.state.datasets
    store.import_lock.acquire()
    try:
        assert client.post("/api/datasets", files=upload_files()).status_code == 429
    finally:
        store.import_lock.release()
    headers, _ = import_headers(client)
    assert client.post("/api/datasets", files=upload_files()).status_code == 429
    store.uploaded[headers["X-Dataset-ID"]].expires_at = time.monotonic() - 1
    for path in ("/api/analysis", "/api/nodes/9000000", "/api/clusters/1", "/api/exports/top_nodes.csv"):
        response = client.get(path, headers=headers)
        assert response.status_code == 410
        assert response.headers["cache-control"] == "no-store"
    assert client.post("/api/nodes/9000000/explain", headers=headers, json={"question": "role"}).status_code == 410
    assert not store.uploaded
    import_headers(client)  # Expired slot was released.


@pytest.mark.parametrize("failure", [None, "parquet", "verification"])
def test_temporary_files_removed_on_success_and_failure(client, monkeypatch, failure):
    created = []
    temporary_directory = datasets.tempfile.TemporaryDirectory

    def record_directory(*args, **kwargs):
        directory = temporary_directory(*args, **kwargs)
        created.append(Path(directory.name))
        return directory

    monkeypatch.setattr(datasets.tempfile, "TemporaryDirectory", record_directory)
    files = upload_files()
    if failure == "parquet":
        files["edges"] = ("edges.parquet", b"invalid")
    elif failure == "verification":
        def rejected(*args):
            raise DataError("CSV не прошли проверку.")
        monkeypatch.setattr(datasets, "verify_outputs", rejected)
    response = client.post("/api/datasets", files=files)
    assert response.status_code == (201 if failure is None else 422)
    assert created and all(not path.exists() for path in created)
    assert not client.app.state.datasets.import_lock.locked()
    assert len(client.app.state.datasets.uploaded) == (1 if failure is None else 0)


def test_unknown_token_and_malformed_multipart_are_readable(client):
    response = client.get("/api/analysis", headers={"X-Dataset-ID": "unavailable"})
    assert response.status_code == 410 and "недоступен" in response.json()["detail"]
    response = client.post("/api/datasets", content=b"invalid", headers={"content-type": "multipart/form-data"})
    assert response.status_code == 422
    assert client.post("/api/datasets", json={}).status_code == 415


def test_idle_expiry_and_shutdown_release_snapshots(analysis, outputs, monkeypatch):
    monkeypatch.setattr(server, "EXPIRY_SWEEP_SECONDS", .01)
    app = create_app(analysis, outputs)
    store = app.state.datasets
    expired = threading.Event()
    expire = store._expire

    def record_expiry():
        was_present = bool(store.uploaded)
        expire()
        if was_present and not store.uploaded:
            expired.set()

    monkeypatch.setattr(store, "_expire", record_expiry)
    with TestClient(app) as running:
        headers, _ = import_headers(running)
        with store.lock:
            store.uploaded[headers["X-Dataset-ID"]].expires_at = time.monotonic() - 1
        assert expired.wait(timeout=2), "Idle snapshots must expire without another API request"
        import_headers(running)
        assert store.uploaded
    assert not store.uploaded


def test_calculation_failure_keeps_startup_and_releases_import_lock(client, monkeypatch):
    def fail(*args):
        raise server.nx.PowerIterationFailedConvergence(500)

    monkeypatch.setattr(datasets, "load_and_analyze", fail)
    response = client.post("/api/datasets", files=upload_files())
    assert response.status_code == 422
    assert "расчёт" in response.json()["detail"]
    assert not client.app.state.datasets.uploaded
    assert not client.app.state.datasets.import_lock.locked()
    assert client.get("/api/analysis").status_code == 200


def test_disconnect_during_calculation_does_not_retain_unreachable_snapshot(client, monkeypatch):
    created = []
    temporary_directory = datasets.tempfile.TemporaryDirectory
    calculate = server.calculate_upload

    def record_directory(*args, **kwargs):
        directory = temporary_directory(*args, **kwargs)
        created.append(Path(directory.name))
        return directory

    monkeypatch.setattr(datasets.tempfile, "TemporaryDirectory", record_directory)
    monkeypatch.setattr(datasets, "MAX_DATASETS", 1)

    async def disconnected_request():
        request = httpx.Request("POST", "http://testserver/api/datasets", files=upload_files())
        body = request.read()
        messages = asyncio.Queue()
        messages.put_nowait({"type": "http.request", "body": body, "more_body": False})
        loop = asyncio.get_running_loop()

        def calculate_after_disconnect(files):
            loop.call_soon_threadsafe(messages.put_nowait, {"type": "http.disconnect"})
            return calculate(files)

        monkeypatch.setattr(server, "calculate_upload", calculate_after_disconnect)
        responses = []

        async def send(message):
            responses.append(message)

        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
                 "http_version": "1.1", "method": "POST", "scheme": "http",
                 "path": "/api/datasets", "raw_path": b"/api/datasets", "query_string": b"",
                 "root_path": "", "headers": [(name.lower(), value) for name, value in request.headers.raw],
                 "client": ("127.0.0.1", 12345), "server": ("testserver", 80)}
        await client.app(scope, messages.get, send)
        return responses

    responses = asyncio.run(disconnected_request())
    start = next(message for message in responses if message["type"] == "http.response.start")
    assert start["status"] == 499
    assert (b"cache-control", b"no-store") in start["headers"]
    assert created and all(not path.exists() for path in created)
    assert not client.app.state.datasets.uploaded
    assert not client.app.state.datasets.import_lock.locked()
    monkeypatch.setattr(server, "calculate_upload", calculate)
    import_headers(client)  # The only slot is still available for another request.
