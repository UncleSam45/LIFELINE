#!/usr/bin/env python3
"""Electron launcher for the LIFELINE frontend.

The launcher intentionally does not require Node/npm.  If an Electron binary is
not already available, it downloads the official Electron zip for the current
platform into ``.lifeline_electron`` and launches the local Electron app shell.
"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent
MAIN_JS_PATH = APP_ROOT / "main.js"
ELECTRON_MAIN_PATH = APP_ROOT / "electron_main.cjs"
ELECTRON_PRELOAD_PATH = APP_ROOT / "electron_preload.cjs"
INDEX_PATH = APP_ROOT / "index.html"
ELECTRON_VERSION = "32.2.7"
ELECTRON_CACHE = APP_ROOT / ".lifeline_electron" / f"electron-v{ELECTRON_VERSION}"


def _ensure_frontend_entrypoint() -> None:
    for path in (MAIN_JS_PATH, ELECTRON_MAIN_PATH, ELECTRON_PRELOAD_PATH, INDEX_PATH):
        if not path.is_file():
            raise FileNotFoundError(f"Expected Electron frontend file at {path}")


def _node_modules_electron() -> Path | None:
    binary = APP_ROOT / "node_modules" / ".bin" / ("electron.cmd" if sys.platform == "win32" else "electron")
    return binary if binary.exists() else None


def _env_electron() -> Path | None:
    raw_path = os.environ.get("LIFELINE_ELECTRON_BINARY", "").strip() or os.environ.get("ELECTRON_BINARY", "").strip()
    if not raw_path:
        return None
    binary = Path(raw_path).expanduser()
    if not binary.exists():
        raise FileNotFoundError(f"Configured Electron binary does not exist: {binary}")
    return binary


def _electron_platform_name() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "windows":
        os_name = "win32"
    elif system == "darwin":
        os_name = "darwin"
    elif system == "linux":
        os_name = "linux"
    else:
        raise RuntimeError(f"Unsupported platform for bundled Electron download: {platform.system()}")

    if machine in {"amd64", "x86_64"}:
        arch = "x64"
    elif machine in {"arm64", "aarch64"}:
        arch = "arm64"
    elif machine in {"i386", "i686", "x86"}:
        arch = "ia32"
    else:
        raise RuntimeError(f"Unsupported CPU architecture for bundled Electron download: {platform.machine()}")
    return f"{os_name}-{arch}"


def _cached_electron_executable() -> Path | None:
    if sys.platform == "win32":
        candidate = ELECTRON_CACHE / "electron.exe"
    elif sys.platform == "darwin":
        candidate = ELECTRON_CACHE / "Electron.app" / "Contents" / "MacOS" / "Electron"
    else:
        candidate = ELECTRON_CACHE / "electron"
    return candidate if candidate.exists() else None


def _download_electron() -> Path:
    platform_name = _electron_platform_name()
    archive_url = f"https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}/electron-v{ELECTRON_VERSION}-{platform_name}.zip"
    archive_path = ELECTRON_CACHE.parent / f"electron-v{ELECTRON_VERSION}-{platform_name}.zip"
    ELECTRON_CACHE.parent.mkdir(parents=True, exist_ok=True)
    if ELECTRON_CACHE.exists():
        shutil.rmtree(ELECTRON_CACHE)
    print(f"Downloading Electron v{ELECTRON_VERSION} for {platform_name}…")
    urllib.request.urlretrieve(archive_url, archive_path)
    ELECTRON_CACHE.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        archive.extractall(ELECTRON_CACHE)
    archive_path.unlink(missing_ok=True)
    binary = _cached_electron_executable()
    if binary is None:
        raise FileNotFoundError(f"Downloaded Electron archive did not contain a runnable binary in {ELECTRON_CACHE}")
    if sys.platform != "win32":
        binary.chmod(binary.stat().st_mode | 0o111)
    return binary


def _electron_executable() -> Path:
    return _env_electron() or _node_modules_electron() or _cached_electron_executable() or _download_electron()


def main() -> None:
    _ensure_frontend_entrypoint()
    electron = _electron_executable()
    subprocess.check_call([str(electron), str(ELECTRON_MAIN_PATH)], cwd=APP_ROOT)


if __name__ == "__main__":
    main()
