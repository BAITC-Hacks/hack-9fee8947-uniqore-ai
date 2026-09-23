"""Measure a fresh CLI process, including imports, export and verification."""
import argparse
import json
import platform
import resource
import subprocess
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--data", default="data")
parser.add_argument("--out", default="out")
parser.add_argument("--report", default="out/benchmark.json")
args = parser.parse_args()
started = time.perf_counter()
process = subprocess.run([sys.executable, "-m", "moneygraph", "run", "--data", args.data, "--out", args.out],
                         capture_output=True, text=True, timeout=300)
elapsed = time.perf_counter() - started
if process.returncode:
    print(process.stderr, file=sys.stderr)
    raise SystemExit(process.returncode)
result = json.loads(process.stdout)
snapshot = json.loads((Path(args.out) / "analysis.json").read_text())
nodes = snapshot["nodes"]
naive_sinks = [n for n in nodes if n["observed_sink"]]
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
report = {
    "command": "python -m moneygraph run --data data --out out",
    "method": "Fresh Python process without a precomputed result; OS file cache not cleared. Includes imports, CSV export and verification; excludes dependency installation.",
    "wall_seconds": round(elapsed, 4), "pipeline_seconds": result["elapsed_seconds"],
    "peak_child_rss_mib": round(usage.ru_maxrss / (1024**2 if sys.platform == "darwin" else 1024), 2),
    "python": platform.python_version(), "system": platform.system(), "machine": platform.machine(),
    "analysis_id": result["analysis_id"], "input_sha256": snapshot["manifest"]["input_sha256"],
    "summary": snapshot["summary"],
    "boundary_comparison": {
        "baseline_rule": "in_degree > 0 and out_degree == 0 => terminal",
        "baseline_terminal": len(naive_sinks),
        "boundary_in_baseline_terminal": sum(n["boundary"] for n in naive_sinks),
        "boundary_assigned_terminal": sum(n["boundary"] and n["role"] == "terminal" for n in nodes),
        "boundary_unknown": sum(n["boundary"] and n["role"] == "unknown" for n in nodes),
        "boundary_partial_consolidator": sum(n["boundary"] and n["role"] == "consolidator" for n in nodes),
        "interpretation": "Structural comparison only; not an accuracy estimate without ground truth.",
    },
}
path = Path(args.report)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(report, ensure_ascii=False))
