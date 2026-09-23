"""Exercise a fresh local CLI/API run and write evidence without private paths.

Outputs are kept for inspection. This runner never deletes a directory or stops a
process it did not start. Ctrl+C and interactive browser checks remain manual.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

try:
    from . import check_environment as preflight
except ImportError:
    import check_environment as preflight


ROOT = Path(__file__).resolve().parents[1]
INPUTS = ("nodes.parquet", "edges.parquet", "transactions.parquet")
OUTPUTS = ("nodes_roles.csv", "clusters.csv", "top_nodes.csv")
LLM_VARIABLES = {"LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY"}


class SmokeFailure(Exception):
    """A message safe to include in a shareable report."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def relative(path: Path, root: Path = ROOT) -> str:
    return path.relative_to(root).as_posix()


def prepare_output(root: Path, argument: Path) -> Path:
    root = root.resolve()
    candidate = argument if argument.is_absolute() else root / argument
    require(".." not in candidate.parts, "OUTPUT_PATH: parent traversal is not allowed.")
    current = candidate
    while current != root:
        require(current != current.parent, "OUTPUT_PATH: choose a fresh directory under out/.")
        require(not current.is_symlink() and not current.is_junction(), "OUTPUT_PATH: symlinks and junctions are not allowed.")
        current = current.parent
    output = candidate.resolve()
    require(output.is_relative_to(root / "out") and output != root / "out", "OUTPUT_PATH: choose a fresh subdirectory under out/.")
    require(not output.exists(), "OUTPUT_EXISTS: choose a new --out; existing files are preserved.")
    output.mkdir(parents=True, exist_ok=False)
    return output


def child_environment() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key.upper() not in LLM_VARIABLES | {"PATH"}}
    paths = [str(Path(sys.executable).parent), str(Path(sys.base_prefix))]
    if os.name == "nt":
        windows = Path(os.environ.get("SystemRoot", r"C:\Windows"))
        paths.extend((str(windows / "System32"), str(windows)))
    env.update(PATH=os.pathsep.join(paths), PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONNOUSERSITE="1")
    require(shutil.which("node", path=env["PATH"]) is None, "NODE_ON_PATH: the restricted runtime PATH still contains Node.")
    return env


def seconds_left(deadline: float, maximum: float) -> float:
    remaining = deadline - time.perf_counter()
    require(remaining > 0, "SMOKE_TIMEOUT: the overall smoke deadline expired.")
    return min(remaining, maximum)


def command_record(arguments: list[str]) -> dict:
    return {"argv": ["python", "-m", "moneygraph", *arguments], "cwd": ".", "exit_code": None}


def run_cli(arguments: list[str], output: Path, label: str, env: dict, deadline: float, report: dict, timeout: float = 60) -> dict:
    record = command_record(arguments)
    report["commands"].append(record)
    started = time.perf_counter()
    try:
        with (output / f"{label}.stdout.log").open("w", encoding="utf-8") as stdout, (output / f"{label}.stderr.log").open("w", encoding="utf-8") as stderr:
            process = subprocess.run([sys.executable, "-m", "moneygraph", *arguments], cwd=ROOT,
                                     env=env, stdout=stdout, stderr=stderr, timeout=seconds_left(deadline, timeout), check=False)
        record["exit_code"] = process.returncode
    except subprocess.TimeoutExpired:
        record["timed_out"] = True
        raise SmokeFailure(f"CHILD_TIMEOUT: {label}; inspect the local logs.") from None
    finally:
        record["wall_seconds"] = round(time.perf_counter() - started, 4)
    require(process.returncode == 0, f"CHILD_EXIT: {label} failed; inspect the local logs.")
    try:
        result = json.loads((output / f"{label}.stdout.log").read_text(encoding="utf-8"))
    except (ValueError, OSError):
        raise SmokeFailure(f"CHILD_OUTPUT: {label} did not produce a JSON result.") from None
    require(result.get("status") == "ok" and bool(result.get("analysis_id")), f"CHILD_OUTPUT: {label} did not report a verified analysis.")
    return result


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        if os.name == "nt":
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            # Match the POSIX server bind: completed connections in TIME_WAIT
            # must not look like a live listener. SO_REUSEPORT is not enabled.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def request(base: str, path: str, deadline: float, *, body: dict | None = None) -> tuple[bytes, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = Request(base + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    # A machine-wide proxy must not turn a loopback smoke check into a network request.
    with build_opener(ProxyHandler({})).open(req, timeout=seconds_left(deadline, 3)) as response:
        require(response.status == 200, "HTTP_STATUS: an expected endpoint did not return 200.")
        return response.read(), dict(response.headers)


def request_json(base: str, path: str, deadline: float, *, body: dict | None = None) -> dict:
    content, _ = request(base, path, deadline, body=body)
    return json.loads(content)


def wait_for_health(process: subprocess.Popen, base: str, expected_id: str, deadline: float) -> None:
    while time.perf_counter() < deadline:
        require(process.poll() is None, "DEMO_EARLY_EXIT: demo exited before becoming ready; inspect its local logs.")
        try:
            health = request_json(base, "/api/health", deadline)
        except (URLError, TimeoutError, ConnectionError, ValueError):
            time.sleep(min(0.2, max(0, deadline - time.perf_counter())))
            continue
        require(health.get("status") == "ok" and health.get("analysis_id") == expected_id, "HEALTH_SNAPSHOT: health does not match the fresh run.")
        return
    raise SmokeFailure("DEMO_TIMEOUT: demo did not become ready within its deadline.")


def stop_child(process: subprocess.Popen, port: int) -> dict:
    result = {"method": "already_exited", "exit_code": process.poll(), "port_released": False}
    timed_out = False
    if result["exit_code"] is None:
        result["method"] = "terminate"  # On Windows this is TerminateProcess, not Ctrl+C.
        process.terminate()
        try:
            result["exit_code"] = process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            timed_out = True
            result["method"] = "kill_after_terminate_timeout"
            process.kill()
            try:
                result["exit_code"] = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                result["exit_code"] = None
    deadline = time.perf_counter() + 5
    while time.perf_counter() < deadline:
        if port_is_free(port):
            result["port_released"] = True
            break
        time.sleep(0.1)
    result["ok"] = not timed_out and result["exit_code"] is not None and result["port_released"]
    return result


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def check_assets(base: str, deadline: float) -> list[str]:
    web = (ROOT / "moneygraph" / "web").resolve()
    queue = [web / "index.html"]
    visited: set[Path] = set()
    while queue:
        path = queue.pop()
        if path in visited:
            continue
        visited.add(path)
        name = path.relative_to(web).as_posix()
        content, _ = request(base, "/" if name == "index.html" else "/" + quote(name, safe="/"), deadline)
        require(content == path.read_bytes(), "STATIC_BYTES: a served frontend asset differs from this checkout.")
        for reference in preflight.asset_references(path):
            parsed = urlsplit(reference)
            if parsed.scheme in ("data", "blob") or not parsed.path and not parsed.netloc:
                continue
            require(not parsed.scheme and not parsed.netloc, "EXTERNAL_ASSET: frontend references an external asset.")
            asset = unquote(parsed.path).replace("\\", "/")
            target = (web / asset.lstrip("/") if asset.startswith("/") else path.parent / asset).resolve()
            require(target.is_relative_to(web), "STATIC_PATH: an asset escapes the bundled frontend.")
            queue.append(target)
    return sorted(path.relative_to(web).as_posix() for path in visited)


def check_api(base: str, expected_id: str, run_result: dict, demo_output: Path, deadline: float) -> dict:
    analysis = request_json(base, "/api/analysis", deadline)
    require(analysis.get("analysis_id") == expected_id and analysis.get("assistant_available") is False, "ANALYSIS_SNAPSHOT: wrong ID or unexpected external assistant availability.")
    nodes = analysis.get("nodes", [])
    require(len(nodes) == run_result["nodes"] and bool(nodes), "ANALYSIS_NODES: API node count differs from verified output.")
    selected = [min(nodes, key=lambda node: node["rank"])]
    for flag in ("isolated", "boundary"):
        candidate = next((node for node in nodes if node.get(flag)), None)
        if candidate is not None and candidate not in selected:
            selected.append(candidate)
    for node in selected:
        endpoint = "/api/nodes/" + quote(node["gid"], safe="")
        dossier = request_json(base, endpoint, deadline)
        require(dossier.get("analysis_id") == expected_id and dossier.get("node", {}).get("gid") == node["gid"], "DOSSIER_SNAPSHOT: dossier does not match the selected node.")
        explanation = request_json(base, endpoint + "/explain", deadline, body={"question": "role"})
        require(explanation.get("analysis_id") == expected_id and explanation.get("mode") == "local"
                and explanation.get("text") == node["evidence"], "LOCAL_EXPLANATION: explanation is not the local calculated evidence.")
    for filename in OUTPUTS:
        content, headers = request(base, "/api/exports/" + filename, deadline)
        headers = {key.lower(): value for key, value in headers.items()}
        require(headers.get("x-analysis-id") == expected_id and content == (demo_output / filename).read_bytes(), "EXPORT_SNAPSHOT: exported bytes or analysis ID differ from the demo snapshot.")
    for path in ("/api/nodes/__smoke_unknown__", "/api/exports/manifest.json", "/api/__smoke_unknown__", "/assets/__smoke_missing__.js"):
        try:
            request(base, path, deadline)
        except HTTPError as exc:
            require(exc.code == 404, "HTTP_NOT_FOUND: an unknown route did not return 404.")
        else:
            raise SmokeFailure("HTTP_NOT_FOUND: an unknown route unexpectedly succeeded.")
    return {"health": "pass", "analysis": "pass", "dossiers_checked": len(selected), "local_explanations_checked": len(selected),
            "exports_checked": list(OUTPUTS), "unknown_routes": "pass", "assets_checked": check_assets(base, deadline)}


def run_smoke(data: Path, output: Path, port: int, report: dict) -> None:
    deadline = time.perf_counter() + 690
    issues = preflight.check_python() + preflight.check_dependencies(ROOT) + preflight.check_inputs(data) + preflight.check_frontend(ROOT / "moneygraph" / "web")
    require(not issues, "PREFLIGHT_FAILED: run scripts/check_environment.py --profile runtime for recovery instructions.")
    env = child_environment()
    require(port_is_free(port), "PORT_BUSY: choose a free --port; the existing listener is preserved.")
    report["environment"] = {"python": platform.python_version(), "platform": platform.system(), "machine": platform.machine(),
                             "node_on_child_path": False, "child_llm_variables_present": False,
                             "dependency_versions": {name: importlib.metadata.version(name) for name in preflight.RUNTIME_IMPORTS}}
    report["input_sha256"] = {name: file_hash(data / name) for name in INPUTS}
    data_arg, output_arg = relative(data), relative(output)
    result = run_cli(["run", "--data", data_arg, "--out", output_arg], output, "run", env, deadline, report, timeout=300)
    report["full_run_wall_seconds"] = report["commands"][-1]["wall_seconds"]
    require(report["full_run_wall_seconds"] < 300, "RUN_BUDGET: the fresh full run took 300 seconds or longer.")
    report["analysis_id"] = result["analysis_id"]
    report["output_sha256"] = {name: file_hash(output / name) for name in OUTPUTS}
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    require(manifest["input_sha256"] == report["input_sha256"] and manifest["output_sha256"] == report["output_sha256"], "MANIFEST_HASHES: calculated files differ from the fresh manifest.")
    for label, target in (("verify-fresh", output_arg), ("verify-reference", "results")):
        verification = run_cli(["verify", "--data", data_arg, "--out", target], output, label, env, deadline, report)
        if label == "verify-fresh":
            require(verification["analysis_id"] == result["analysis_id"], "VERIFY_SNAPSHOT: fresh verification returned a different ID.")
        else:
            report["reference_analysis_id"] = verification["analysis_id"]
    demo_output = output / "demo"
    arguments = ["demo", "--data", data_arg, "--out", relative(demo_output), "--host", "127.0.0.1", "--port", str(port)]
    record = command_record(arguments)
    report["commands"].append(record)
    base = f"http://127.0.0.1:{port}"
    with ExitStack() as stack:
        stdout = stack.enter_context((output / "demo.stdout.log").open("w", encoding="utf-8"))
        stderr = stack.enter_context((output / "demo.stderr.log").open("w", encoding="utf-8"))
        started = time.perf_counter()
        process = subprocess.Popen([sys.executable, "-m", "moneygraph", *arguments], cwd=ROOT, env=env, stdout=stdout, stderr=stderr)
        try:
            wait_for_health(process, base, result["analysis_id"], min(deadline, time.perf_counter() + 300))
            report["http"] = check_api(base, result["analysis_id"], result, demo_output, deadline)
            require(process.poll() is None, "DEMO_EARLY_EXIT: demo exited during HTTP checks.")
            require({name: file_hash(demo_output / name) for name in OUTPUTS} == report["output_sha256"], "DEMO_HASHES: repeated analysis produced different CSV bytes.")
        finally:
            report["cleanup"] = stop_child(process, port)
            record["exit_code"] = report["cleanup"]["exit_code"]
            record["wall_seconds"] = round(time.perf_counter() - started, 4)
        require(report["cleanup"]["ok"], "CLEANUP_FAILED: child termination timed out or the port was not released.")
    require({name: file_hash(data / name) for name in INPUTS} == report["input_sha256"], "INPUT_CHANGED: input hashes changed during smoke.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data"))
    parser.add_argument("--out", type=Path, default=Path("out/local-launch"))
    parser.add_argument("--port", type=int, default=8876)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    report = {"status": "fail", "started_at": datetime.now(timezone.utc).isoformat(), "commands": [],
              "method": "Fresh Python child including imports, analysis, CSV writes and verification; OS file cache not cleared. Runtime PATH excludes Node; child has no LLM settings. No browser or Ctrl+C claim.",
              "peak_child_rss_mib": None, "manual_browser": "not_run", "manual_ctrl_c": "not_run"}
    output = None
    started = time.perf_counter()
    try:
        data = (ROOT / args.data).resolve()
        require(data.is_relative_to(ROOT), "DATA_PATH: use input files inside this checkout.")
        # Git output is captured; private installation paths and environment values
        # never become report fields. Only the immutable SHA and a boolean remain.
        git = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=10, check=True)
        report["checked_commit"] = git.stdout.strip()
        status = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=10, check=True)
        report["worktree_clean"] = not bool(status.stdout.strip())
        require(report["worktree_clean"], "UNCOMMITTED_CODE: use a clean checkout or commit/stash only your task changes before collecting evidence.")
        output = prepare_output(ROOT, args.out)
        run_smoke(data, output, args.port, report)
        report["status"] = "pass"
    except SmokeFailure as exc:
        report["failure"] = str(exc)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as exc:
        report["failure"] = f"SMOKE_ERROR: {type(exc).__name__}; inspect local logs and the preflight output."
    finally:
        report["wall_seconds"] = round(time.perf_counter() - started, 4)
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        if output is not None:
            (output / "smoke-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
