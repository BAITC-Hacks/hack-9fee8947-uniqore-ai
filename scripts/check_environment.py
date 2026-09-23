"""Check the installed local runtime without starting an analysis or reading .env."""

from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_IMPORTS = ("fastapi", "uvicorn", "pandas", "pyarrow", "numpy", "scipy", "networkx", "httpx")
INSTALL_ACTION = "Run the venv Python with -m pip install -r requirements.lock, then -m pip check."
ASSET_ACTION = "Restore the bundled moneygraph/web files from the same checkout; Node is not needed."


class AssetParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references: list[str] = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if values.get("src"):
            self.references.append(values["src"])
        if tag == "link" and values.get("href"):
            self.references.append(values["href"])
        if values.get("srcset"):
            self.references.extend(part.strip().split()[0] for part in values["srcset"].split(",") if part.strip())


def check_python() -> list[str]:
    issues = []
    if sys.version_info[:2] < (3, 12):
        version = ".".join(map(str, sys.version_info[:3]))
        issues.append(f"PYTHON_VERSION: found {version}; Python 3.12 or newer is required. Create a fresh venv with a supported Python.")
    if sys.prefix == sys.base_prefix:
        issues.append("VENV_REQUIRED: use an isolated venv. Create it with Python 3.12+ -m venv .venv and invoke its Python directly.")
    else:
        config = Path(sys.prefix) / "pyvenv.cfg"
        try:
            settings = dict(line.lower().split("=", 1) for line in config.read_text(encoding="utf-8").splitlines() if "=" in line)
            isolated = any(key.strip() == "include-system-site-packages" and value.strip() == "false" for key, value in settings.items())
        except (OSError, UnicodeError):
            isolated = False
        if not isolated:
            issues.append("VENV_ISOLATION: cannot confirm include-system-site-packages=false. Recreate the venv without --system-site-packages.")
    return issues


def check_dependencies(root: Path) -> list[str]:
    issues = []
    try:
        lines = (root / "requirements.lock").read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return ["LOCK_MISSING: requirements.lock is missing or unreadable. Restore it from this checkout before installing dependencies."]
    try:
        from packaging.requirements import InvalidRequirement, Requirement
    except ImportError:
        return [f"DEPENDENCY_MISSING: packaging is needed to validate lock markers. {INSTALL_ACTION}"]
    pins = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            requirement = Requirement(line)
        except InvalidRequirement:
            issues.append("LOCK_FORMAT: requirements.lock must contain exact package==version pins. Restore the checked-in lock.")
            continue
        if requirement.marker and not requirement.marker.evaluate():
            continue
        specs = list(requirement.specifier)
        if len(specs) != 1 or specs[0].operator != "==" or "*" in specs[0].version or requirement.url or requirement.extras:
            issues.append("LOCK_FORMAT: requirements.lock must contain exact package==version pins. Restore the checked-in lock.")
            continue
        pins.append((requirement.name, specs[0].version))
    if not pins:
        issues.append("LOCK_EMPTY: requirements.lock contains no dependency pins. Restore the checked-in lock.")
    for name, expected in pins:
        try:
            actual = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            issues.append(f"DEPENDENCY_MISSING: {name}=={expected}. {INSTALL_ACTION}")
            continue
        if actual != expected:
            issues.append(f"DEPENDENCY_VERSION: {name} is {actual}; expected {expected}. {INSTALL_ACTION}")
    for module in RUNTIME_IMPORTS:
        try:
            importlib.import_module(module)
        except Exception as exc:
            # Import errors can contain private installation paths; report the type only.
            issues.append(f"DEPENDENCY_IMPORT: {module} failed ({type(exc).__name__}). {INSTALL_ACTION}")
    return issues


def check_inputs(data: Path) -> list[str]:
    issues = []
    for filename in ("nodes.parquet", "edges.parquet", "transactions.parquet"):
        try:
            with (data / filename).open("rb") as handle:
                content = handle.read(4)
                handle.seek(-4, 2)
                footer = handle.read(4)
            valid = content == b"PAR1" and footer == b"PAR1"
        except OSError:
            valid = False
        if not valid:
            issues.append(f"INPUT_MISSING_OR_INVALID: data/{filename} is missing, unreadable or not a Parquet file. Restore the supplied data files; do not use generated CSV in their place.")
    return issues


def asset_references(path: Path) -> list[str]:
    if path.suffix.lower() not in (".html", ".css", ".js"):
        return []
    content = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".html":
        parser = AssetParser()
        parser.feed(content)
        return parser.references
    if path.suffix.lower() == ".css":
        return [next(part for part in match if part) for match in re.findall(
            r"url\(\s*[\"']?([^\s)\"']+)[\"']?\s*\)|@import\s+[\"']([^\"']+)[\"']", content
        )]
    # Vite uses quoted filenames for both dynamic imports and public image URLs.
    return re.findall(r"[\"']([^\"'\s<>]+\.(?:js|css|png|jpe?g|svg|webp|gif|ico|woff2?|ttf)(?:[?#][^\"'\s]*)?)[\"']", content)


def check_frontend(web: Path) -> list[str]:
    web = web.resolve()
    issues = []
    queue = [web / "index.html"]
    visited = set()
    while queue:
        path = queue.pop()
        if path in visited:
            continue
        visited.add(path)
        name = path.relative_to(web).as_posix()
        if not path.is_file():
            issues.append(f"FRONTEND_MISSING: moneygraph/web/{name}. {ASSET_ACTION}")
            continue
        try:
            references = asset_references(path)
        except (OSError, UnicodeError):
            issues.append(f"FRONTEND_UNREADABLE: moneygraph/web/{name}. {ASSET_ACTION}")
            continue
        for reference in references:
            parsed = urlsplit(reference)
            if parsed.scheme in ("data", "blob") or not parsed.path and not parsed.netloc:
                continue
            if parsed.scheme or parsed.netloc:
                issues.append(f"FRONTEND_EXTERNAL: {name} references an external asset. Bundle the asset for offline runtime.")
                continue
            relative = unquote(parsed.path).replace("\\", "/")
            target = ((web / relative.lstrip("/")) if relative.startswith("/") else (path.parent / relative)).resolve()
            if not target.is_relative_to(web):
                issues.append(f"FRONTEND_PATH: {name} references a file outside moneygraph/web. Restore the bundled frontend.")
                continue
            queue.append(target)
    return issues


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check the Python 3.12+ local runtime; no Node or API keys required.")
    parser.add_argument("--profile", choices=("runtime",), default="runtime")
    parser.parse_args(argv)
    issues = check_python() + check_dependencies(ROOT) + check_inputs(ROOT / "data") + check_frontend(ROOT / "moneygraph" / "web")
    for issue in issues:
        print(f"FAIL {issue}")
    if issues:
        print(f"Runtime preflight failed: {len(issues)} issue(s). Follow the actions above and rerun this command.")
        return 1
    version = ".".join(map(str, sys.version_info[:3]))
    print(f"PASS Python {version} isolated venv, locked dependencies/imports, 3 Parquet inputs and bundled frontend assets.")
    print("Runtime is ready for python -m moneygraph demo --data data --out out; analysis has not been executed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
