"""Failure-path coverage without rerunning the full financial analysis."""
import json
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.error import URLError

import pytest

from scripts import smoke_local_launch as smoke


@pytest.mark.parametrize("target", ["out", "data/fresh", "../outside", "out/../fresh"])
def test_output_guard_rejects_paths_outside_owned_subdirectory(tmp_path, target):
    with pytest.raises(smoke.SmokeFailure):
        smoke.prepare_output(tmp_path, Path(target))
    assert not (tmp_path / "data").exists()


def test_output_guard_preserves_existing_data_and_accepts_fresh_path(tmp_path):
    output = tmp_path / "out" / "existing"
    output.mkdir(parents=True)
    sentinel = output / "user.txt"
    sentinel.write_text("keep", encoding="utf-8")
    with pytest.raises(smoke.SmokeFailure, match="OUTPUT_EXISTS"):
        smoke.prepare_output(tmp_path, Path("out/existing"))
    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert smoke.prepare_output(tmp_path, Path("out/fresh")) == tmp_path / "out" / "fresh"


def test_output_guard_rejects_symlink_parent_without_writing(tmp_path, monkeypatch):
    linked = tmp_path / "out"
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda path: path == linked or original(path))
    with pytest.raises(smoke.SmokeFailure, match="symlinks"):
        smoke.prepare_output(tmp_path, Path("out/fresh"))
    assert not linked.exists()


def test_child_environment_removes_llm_and_node_without_mutating_parent(monkeypatch):
    for name in smoke.LLM_VARIABLES:
        monkeypatch.setenv(name, "private-value")
    monkeypatch.setenv("PATH", os.pathsep.join(("private-node-directory", "private-user-directory")))
    monkeypatch.setattr(smoke.shutil, "which", lambda *args, **kwargs: None)
    environment = smoke.child_environment()
    assert not smoke.LLM_VARIABLES.intersection(environment)
    assert "private-node-directory" not in environment["PATH"]
    assert environment["PYTHONIOENCODING"] == "utf-8"
    assert os.environ["LLM_API_KEY"] == "private-value"
    assert "private-node-directory" in os.environ["PATH"]


@pytest.mark.parametrize("failure", ["nonzero", "timeout", "invalid-json"])
def test_run_cli_rejects_child_failure_and_keeps_evidence(tmp_path, monkeypatch, failure):
    def run(argv, **kwargs):
        assert kwargs["env"] == {"test": "value"}
        assert not kwargs.get("shell", False)
        assert argv[:3] == [smoke.sys.executable, "-m", "moneygraph"]
        if failure == "timeout":
            raise subprocess.TimeoutExpired(argv, 1)
        kwargs["stdout"].write("not JSON")
        return SimpleNamespace(returncode=1 if failure == "nonzero" else 0)
    monkeypatch.setattr(smoke.subprocess, "run", run)
    report = {"commands": []}
    with pytest.raises(smoke.SmokeFailure):
        smoke.run_cli(["run", "--out", "out/test"], tmp_path, "run", {"test": "value"}, smoke.time.perf_counter() + 10, report)
    record = report["commands"][0]
    assert record["argv"][0] == "python" and record["cwd"] == "."
    assert record["exit_code"] == (None if failure == "timeout" else 1 if failure == "nonzero" else 0)
    assert record["wall_seconds"] >= 0
    assert record.get("timed_out", False) == (failure == "timeout")


def test_run_cli_accepts_utf8_verified_result(tmp_path, monkeypatch):
    def run(argv, **kwargs):
        kwargs["stdout"].write(json.dumps({"status": "ok", "analysis_id": "abc", "message": "Проверено"}, ensure_ascii=False))
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(smoke.subprocess, "run", run)
    result = smoke.run_cli(["verify"], tmp_path, "verify", {}, smoke.time.perf_counter() + 10, {"commands": []})
    assert result["message"] == "Проверено"


def test_readiness_rejects_early_child_exit_without_using_other_listener(monkeypatch):
    child = Mock()
    child.poll.return_value = 1
    request = Mock()
    monkeypatch.setattr(smoke, "request_json", request)
    with pytest.raises(smoke.SmokeFailure, match="DEMO_EARLY_EXIT"):
        smoke.wait_for_health(child, "http://127.0.0.1:8876", "abc", smoke.time.perf_counter() + 10)
    request.assert_not_called()


def test_readiness_timeout_is_bounded(monkeypatch):
    child = Mock()
    child.poll.return_value = None
    clock = iter((0, 1, 3))
    monkeypatch.setattr(smoke.time, "perf_counter", lambda: next(clock))
    monkeypatch.setattr(smoke.time, "sleep", lambda _: None)
    monkeypatch.setattr(smoke, "request_json", Mock(side_effect=URLError("not ready")))
    with pytest.raises(smoke.SmokeFailure, match="DEMO_TIMEOUT"):
        smoke.wait_for_health(child, "http://127.0.0.1:8876", "abc", 2)


def test_readiness_rejects_wrong_analysis_id(monkeypatch):
    child = Mock()
    child.poll.return_value = None
    monkeypatch.setattr(smoke, "request_json", lambda *args: {"status": "ok", "analysis_id": "stale"})
    with pytest.raises(smoke.SmokeFailure, match="HEALTH_SNAPSHOT"):
        smoke.wait_for_health(child, "http://127.0.0.1:8876", "fresh", smoke.time.perf_counter() + 10)


def test_cleanup_terminates_only_owned_child_and_records_actual_method(monkeypatch):
    child, stranger = Mock(), Mock()
    child.poll.return_value = None
    child.wait.return_value = 1  # Windows TerminateProcess is not a graceful Ctrl+C.
    monkeypatch.setattr(smoke, "port_is_free", lambda port: True)
    result = smoke.stop_child(child, 8876)
    assert result == {"method": "terminate", "exit_code": 1, "port_released": True, "ok": True}
    child.terminate.assert_called_once()
    child.kill.assert_not_called()
    assert stranger.mock_calls == []


def test_cleanup_timeout_remains_failure_even_after_kill(monkeypatch):
    child = Mock()
    child.poll.return_value = None
    child.wait.side_effect = [subprocess.TimeoutExpired("demo", 10), 1]
    monkeypatch.setattr(smoke, "port_is_free", lambda port: True)
    result = smoke.stop_child(child, 8876)
    assert result["ok"] is False and result["method"] == "kill_after_terminate_timeout"
    child.kill.assert_called_once()


def test_cleanup_never_kills_new_listener_after_child_exited(monkeypatch):
    child = Mock()
    child.poll.return_value = 1
    monkeypatch.setattr(smoke, "port_is_free", lambda port: False)
    clock = iter((0, 1, 6))
    monkeypatch.setattr(smoke.time, "perf_counter", lambda: next(clock))
    monkeypatch.setattr(smoke.time, "sleep", lambda _: None)
    result = smoke.stop_child(child, 8876)
    assert result["port_released"] is False and result["ok"] is False
    child.terminate.assert_not_called()
    child.kill.assert_not_called()


@pytest.mark.parametrize("status", ["?? scripts/untracked_module.py\n", " M moneygraph/analysis.py\n"])
def test_main_rejects_uncommitted_files_before_output_or_child(monkeypatch, capsys, status):
    git = Mock(side_effect=[SimpleNamespace(stdout="a" * 40 + "\n"), SimpleNamespace(stdout=status)])
    prepare, run = Mock(), Mock()
    monkeypatch.setattr(smoke.subprocess, "run", git)
    monkeypatch.setattr(smoke, "prepare_output", prepare)
    monkeypatch.setattr(smoke, "run_smoke", run)
    assert smoke.main([]) == 1
    report = json.loads(capsys.readouterr().out)
    assert report["status"] == "fail" and report["worktree_clean"] is False
    assert report["failure"].startswith("UNCOMMITTED_CODE:")
    assert "--untracked-files=all" in git.call_args_list[1].args[0]
    prepare.assert_not_called()
    run.assert_not_called()
