#!/usr/bin/env python3
"""NiceGUI launcher for the static LIFELINE frontend.

This bootstrap intentionally stays small: it verifies the current Python
virtual environment has the packages needed to run a NiceGUI server, then serves
``main.js`` as the modern frontend entrypoint.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent
MAIN_JS_PATH = APP_ROOT / "main.js"
REQUIRED_PIP_PACKAGES = {
    "nicegui": "nicegui",
}


def _missing_packages() -> list[str]:
    """Return pip package names whose import targets are not available."""
    return [package for import_name, package in REQUIRED_PIP_PACKAGES.items() if importlib.util.find_spec(import_name) is None]


def _ensure_dependencies() -> None:
    """Install required packages into the currently running Python environment."""
    missing = _missing_packages()
    if not missing:
        return

    print(f"Installing missing dependencies into {sys.executable}: {', '.join(missing)}")
    subprocess.check_call([sys.executable, "-m", "pip", "install", *missing])


def _ensure_frontend_entrypoint() -> None:
    """Fail early with a clear message when the JavaScript entrypoint is absent."""
    if MAIN_JS_PATH.is_file():
        return
    raise FileNotFoundError(f"Expected frontend entrypoint at {MAIN_JS_PATH}")


def main() -> None:
    """Start the NiceGUI server and load ``main.js`` in the browser."""
    _ensure_dependencies()
    _ensure_frontend_entrypoint()

    from nicegui import app, ui

    # Inline the JavaScript entrypoint instead of serving it through a static URL.
    # This guarantees users see the current login portal immediately, even when
    # a browser or proxy has cached an older `/static/main.js` placeholder.
    frontend_script = MAIN_JS_PATH.read_text(encoding="utf-8")

    ui.add_head_html('<meta name="viewport" content="width=device-width, initial-scale=1.0">')
    ui.add_body_html(
        f'<div id="lifeline-root" aria-live="polite">Loading LIFELINE access portal…</div>'
        f'<script type="module">\n{frontend_script}\n</script>'
    )

    ui.run(title="LIFELINE", reload=False, show=True)


if __name__ == "__main__":
    main()
