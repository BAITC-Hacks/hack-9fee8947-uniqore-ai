from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .analysis import DataError, json_write, load_and_analyze, verify_outputs, write_outputs


def main():
    parser = argparse.ArgumentParser(description="Граф денег: локальный анализ и интерфейс расследования")
    parser.add_argument("command", choices=["run", "demo", "verify"])
    parser.add_argument("--data", type=Path, default=Path("data"))
    parser.add_argument("--out", type=Path, default=Path("out"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    try:
        if args.command == "verify":
            print(json.dumps(verify_outputs(args.data, args.out), ensure_ascii=False))
            return
        started = time.perf_counter()
        result = load_and_analyze(args.data)
        write_outputs(result, args.out)
        verification = verify_outputs(args.data, args.out)
        result["manifest"]["full_run_seconds"] = round(time.perf_counter() - started, 4)
        json_write(args.out / "manifest.json", result["manifest"])
        json_write(args.out / "analysis.json", result)
        print(json.dumps({**verification, "elapsed_seconds": result["manifest"]["full_run_seconds"], "out": str(args.out)}, ensure_ascii=False), flush=True)
        if args.command == "demo":
            import uvicorn
            from .server import create_app
            print(f"Откройте http://{args.host}:{args.port}", flush=True)
            uvicorn.run(create_app(result, args.out), host=args.host, port=args.port)
    except (DataError, FileNotFoundError, OSError, ValueError) as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
