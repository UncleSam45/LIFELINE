#!/usr/bin/env python3
"""Electron launcher for the LIFELINE frontend."""
from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent
MAIN_JS_PATH = APP_ROOT / "main.js"
ELECTRON_MAIN_PATH = APP_ROOT / "electron_main.cjs"
ELECTRON_PRELOAD_PATH = APP_ROOT / "electron_preload.cjs"
INDEX_PATH = APP_ROOT / "index.html"


def _ensure_frontend_entrypoint() -> None:
    for path in (MAIN_JS_PATH, ELECTRON_MAIN_PATH, ELECTRON_PRELOAD_PATH, INDEX_PATH):
        if not path.is_file():
            raise FileNotFoundError(f"Expected Electron frontend file at {path}")


def _ensure_electron() -> None:
    if (APP_ROOT / "node_modules" / ".bin" / ("electron.cmd" if sys.platform == "win32" else "electron")).exists():
        return
    if not (APP_ROOT / "package.json").exists():
        subprocess.check_call(["npm", "init", "-y"], cwd=APP_ROOT)
    subprocess.check_call(["npm", "install", "--save-dev", "electron"], cwd=APP_ROOT)


def main() -> None:
    _ensure_frontend_entrypoint()
    _ensure_electron()
    subprocess.check_call(["npx", "electron", str(ELECTRON_MAIN_PATH)], cwd=APP_ROOT)


if __name__ == "__main__":
    main()
