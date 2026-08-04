#!/usr/bin/env python3


from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import urllib.request
import urllib.error
import zipfile
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent
MAIN_JS_PATH = APP_ROOT / "main.js"
ELECTRON_MAIN_PATH = APP_ROOT / "electron_main.cjs"
ELECTRON_PRELOAD_PATH = APP_ROOT / "electron_preload.cjs"
INDEX_PATH = APP_ROOT / "index.html"
MEMORY_MANAGER_PATH = APP_ROOT / "lifeline_memory_manager.py"
RUNTIME_DIR = APP_ROOT / ".lifeline_runtime"
ELECTRON_VERSION = "32.2.7"
ELECTRON_CACHE = APP_ROOT / ".lifeline_electron" / f"electron-v{ELECTRON_VERSION}"
WINDOWS_STATUS_DLL_NOT_FOUND = 0xC0000135


def _background_process_options(log_name: str) -> tuple[dict, object]:

    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    log = (RUNTIME_DIR / log_name).open("a", encoding="utf-8")
    options: dict = {
        "cwd": str(APP_ROOT),
        "stdin": subprocess.DEVNULL,
        "stdout": log,
        "stderr": subprocess.STDOUT,
        "close_fds": os.name != "nt",
    }
    if os.name == "nt":
        options["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    return options, log


def _spawn_background(command: list[str], log_name: str) -> subprocess.Popen:
    options, log = _background_process_options(log_name)
    try:
        return subprocess.Popen(command, **options)
    finally:

        log.close()


def _ollama_is_running() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=1) as response:
            return 200 <= response.status < 300
    except (OSError, urllib.error.URLError):
        return False


def _ollama_executable() -> Path | None:
    configured = os.environ.get("LIFELINE_OLLAMA_BINARY", "").strip()
    if configured:
        candidate = Path(configured).expanduser()
        if not candidate.exists():
            raise FileNotFoundError(f"Configured Ollama binary does not exist: {candidate}")
        return candidate

    on_path = shutil.which("ollama")
    if on_path:
        return Path(on_path)

    if os.name == "nt":
        roots = filter(None, (
            os.environ.get("LOCALAPPDATA"),
            str(Path(os.environ.get("USERPROFILE", "")) / "AppData" / "Local") if os.environ.get("USERPROFILE") else None,
            os.environ.get("PROGRAMFILES"),
            os.environ.get("PROGRAMFILES(X86)"),
        ))
        for root in roots:
            for relative in ("Programs/Ollama/ollama.exe", "Programs/Ollama/Ollama app.exe", "Ollama/ollama.exe"):
                candidate = Path(root) / relative
                if candidate.exists():
                    return candidate
    return None


def _launch_ollama() -> None:
    if _ollama_is_running():
        print("Ollama is already running.")
        return
    executable = _ollama_executable()
    if executable is None:
        print("[WARN] Ollama is not installed or was not found; the Memory Manager will retry it.", file=sys.stderr)
        return
    command = [str(executable)]
    if executable.name.lower() in {"ollama", "ollama.exe"}:
        command.append("serve")
    process = _spawn_background(command, "ollama.log")
    _verify_background_start(process, "Ollama", "ollama.log")
    print(f"Launched Ollama from {executable}.", flush=True)


def _launch_memory_manager() -> None:
    if not MEMORY_MANAGER_PATH.is_file():
        raise FileNotFoundError(f"Expected LIFELINE Memory Manager at {MEMORY_MANAGER_PATH}")
    process = _spawn_background([sys.executable, str(MEMORY_MANAGER_PATH)], "memory-manager.log")
    _verify_background_start(process, "LIFELINE Memory Manager", "memory-manager.log")
    print("Launched LIFELINE Memory Manager.", flush=True)


def _verify_background_start(process: subprocess.Popen, service_name: str, log_name: str) -> None:

    try:
        return_code = process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        return

    log_path = RUNTIME_DIR / log_name
    detail = ""
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        if lines:
            detail = f" Last log line: {lines[-1]}"
    except OSError:
        pass
    raise RuntimeError(
        f"{service_name} exited during startup with code {return_code}. "
        f"See {log_path}.{detail}"
    )


def _launch_support_services() -> None:

    failures = []
    for service_name, launcher in (
        ("Ollama", _launch_ollama),
        ("LIFELINE Memory Manager", _launch_memory_manager),
    ):
        try:
            launcher()
        except Exception as error:
            failures.append(f"{service_name}: {error}")
            print(f"[ERROR] Could not launch {service_name}: {error}", file=sys.stderr, flush=True)
    if failures:
        print(
            "[WARN] LIFELINE will still open; companion startup details are in "
            f"{RUNTIME_DIR}. Failures: {'; '.join(failures)}",
            file=sys.stderr,
            flush=True,
        )


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


def _run_electron(electron: Path) -> None:
    subprocess.check_call([str(electron), str(ELECTRON_MAIN_PATH)], cwd=APP_ROOT)


def _is_windows_dll_load_failure(error: subprocess.CalledProcessError) -> bool:
    return sys.platform == "win32" and error.returncode == WINDOWS_STATUS_DLL_NOT_FOUND


def main() -> None:
    _ensure_frontend_entrypoint()
    _launch_support_services()
    electron = _electron_executable()
    try:
        _run_electron(electron)
    except subprocess.CalledProcessError as error:
        if not _is_windows_dll_load_failure(error) or not str(electron).startswith(str(ELECTRON_CACHE)):
            raise
        print(
            "Cached Electron failed to start because a required Windows DLL was missing. "
            "Re-downloading the bundled Electron runtime and retrying once…",
            file=sys.stderr,
        )
        fresh_electron = _download_electron()
        _run_electron(fresh_electron)


if __name__ == "__main__":
    main()
