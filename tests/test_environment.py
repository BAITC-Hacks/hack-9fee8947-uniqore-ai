import importlib.util
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "check_environment.py"
MODULE_SPEC = importlib.util.spec_from_file_location("check_environment", MODULE_PATH)
environment = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(environment)


def test_python_target_and_venv_are_actionable(monkeypatch):
    monkeypatch.setattr(environment.sys, "version_info", (3, 11, 9))
    monkeypatch.setattr(environment.sys, "prefix", "same")
    monkeypatch.setattr(environment.sys, "base_prefix", "same")
    issues = environment.check_python()
    assert any("PYTHON_VERSION" in issue and "Python 3.12" in issue for issue in issues)
    assert any("VENV_REQUIRED" in issue and "-m venv" in issue for issue in issues)


@pytest.mark.parametrize("version", [(3, 12, 14), (3, 13, 0), (3, 14, 5)])
def test_system_site_packages_are_rejected(tmp_path, monkeypatch, version):
    monkeypatch.setattr(environment.sys, "version_info", version)
    monkeypatch.setattr(environment.sys, "prefix", str(tmp_path))
    monkeypatch.setattr(environment.sys, "base_prefix", "base")
    (tmp_path / "pyvenv.cfg").write_text("include-system-site-packages = true\n", encoding="utf-8")
    assert "VENV_ISOLATION" in environment.check_python()[0]
    (tmp_path / "pyvenv.cfg").write_text("include-system-site-packages = false\n", encoding="utf-8")
    assert environment.check_python() == []


def test_missing_and_wrong_dependency_pins(tmp_path, monkeypatch):
    (tmp_path / "requirements.lock").write_text("fastapi==1.0\nhttpx==2.0\n", encoding="utf-8")
    monkeypatch.setattr(environment, "RUNTIME_IMPORTS", ())

    def version(name):
        if name == "fastapi":
            raise environment.importlib.metadata.PackageNotFoundError(name)
        return "1.0"

    monkeypatch.setattr(environment.importlib.metadata, "version", version)
    issues = environment.check_dependencies(tmp_path)
    assert any("DEPENDENCY_MISSING: fastapi==1.0" in issue for issue in issues)
    assert any("DEPENDENCY_VERSION: httpx is 1.0; expected 2.0" in issue for issue in issues)
    assert all("pip install -r requirements.lock" in issue for issue in issues)


def test_import_failure_hides_private_path(tmp_path, monkeypatch):
    (tmp_path / "requirements.lock").write_text("numpy==1.0\n", encoding="utf-8")
    monkeypatch.setattr(environment, "RUNTIME_IMPORTS", ("numpy",))
    monkeypatch.setattr(environment.importlib.metadata, "version", lambda name: "1.0")

    def fail_import(name):
        raise OSError("private installation path")

    monkeypatch.setattr(environment.importlib, "import_module", fail_import)
    issues = environment.check_dependencies(tmp_path)
    assert "DEPENDENCY_IMPORT: numpy failed (OSError)" in issues[0]
    assert "private installation path" not in issues[0]


def test_nonmatching_lock_marker_is_skipped(tmp_path, monkeypatch):
    (tmp_path / "requirements.lock").write_text('fastapi==1.0\nunavailable==2.0 ; sys_platform == "not-a-platform"\n', encoding="utf-8")
    monkeypatch.setattr(environment, "RUNTIME_IMPORTS", ())
    checked = []

    def version(name):
        checked.append(name)
        return "1.0"

    monkeypatch.setattr(environment.importlib.metadata, "version", version)
    assert environment.check_dependencies(tmp_path) == []
    assert checked == ["fastapi"]


def test_missing_lock_is_diagnostic(tmp_path):
    assert "LOCK_MISSING" in environment.check_dependencies(tmp_path)[0]


def test_missing_or_corrupt_input_is_not_ready(tmp_path):
    (tmp_path / "nodes.parquet").write_bytes(b"PAR1payloadPAR1")
    (tmp_path / "edges.parquet").write_bytes(b"not parquet")
    issues = environment.check_inputs(tmp_path)
    assert len(issues) == 2
    assert any("edges.parquet" in issue for issue in issues)
    assert any("transactions.parquet" in issue for issue in issues)


def test_missing_index_is_diagnostic(tmp_path):
    issues = environment.check_frontend(tmp_path)
    assert len(issues) == 1
    assert "FRONTEND_MISSING: moneygraph/web/index.html" in issues[0]


def test_nested_assets_and_public_images_are_checked(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text('<script src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">', encoding="utf-8")
    (tmp_path / "assets" / "app.js").write_text('import("./graph.js"); const logo="/logo.png";', encoding="utf-8")
    (tmp_path / "assets" / "graph.js").write_text('import "./app.js";', encoding="utf-8")
    (tmp_path / "assets" / "app.css").write_text('body { background:url("../background.png?v=1") }', encoding="utf-8")
    issues = environment.check_frontend(tmp_path)
    assert len(issues) == 2
    assert any("logo.png" in issue for issue in issues)
    assert any("background.png" in issue for issue in issues)
    (tmp_path / "logo.png").write_bytes(b"image")
    (tmp_path / "background.png").write_bytes(b"image")
    assert environment.check_frontend(tmp_path) == []


@pytest.mark.parametrize("reference, code", [("../private.png", "FRONTEND_PATH"), ("https://example.com/font.css", "FRONTEND_EXTERNAL")])
def test_frontend_must_be_self_contained(tmp_path, reference, code):
    (tmp_path / "index.html").write_text(f'<link rel="stylesheet" href="{reference}">', encoding="utf-8")
    assert code in environment.check_frontend(tmp_path)[0]


def test_cli_failure_has_nonzero_exit_and_recovery(monkeypatch, capsys):
    monkeypatch.setattr(environment, "check_python", lambda: ["PYTHON_VERSION: install Python 3.12."])
    monkeypatch.setattr(environment, "check_dependencies", lambda root: [])
    monkeypatch.setattr(environment, "check_inputs", lambda data: [])
    monkeypatch.setattr(environment, "check_frontend", lambda web: [])
    assert environment.main(["--profile", "runtime"]) == 1
    assert "install Python 3.12" in capsys.readouterr().out
