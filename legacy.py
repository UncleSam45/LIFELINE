#!/usr/bin/env python3
"""KINDROIDXL desktop companion app.

Features:
- Auto-installs required PySide6 dependency in the active virtual environment.
- Embeds https://kindroid.ai/home/ in a Qt WebEngine view.
- Adds a weekly world schedule tab with API-powered reminders.
- Persists browser profile data (cookies, local storage, etc.) in a local folder.
- Lets the user choose whether to remember the last connected account.
- Injects JavaScript files from ./javascripts into loaded pages.
- Provides a tabbed UI scaffold with placeholders for future tools.
"""

from __future__ import annotations

import importlib
import importlib.util
import ctypes
import hashlib
import base64
import json
import mimetypes
import os
import sqlite3
import warnings
from datetime import date, datetime
import random
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from modules.app_logging import configure_logging

REQUIRED_PIP_PACKAGES = {
    "PySide6": "PySide6",
    "PySide6.QtWebEngineWidgets": "PySide6-Addons",
    "requests": "requests",
    "psutil": "psutil",
    "numpy": "numpy",
    "soundcard": "soundcard",
}
TARGET_URL = "https://kindroid.ai/home/"
APP_ROOT = Path(__file__).resolve().parent
DEBUG_CONSOLE_OUTPUT = os.environ.get("KXL_DEBUG_CONSOLE", "").strip().lower() in {"1", "true", "yes", "on"}
os.environ.setdefault("QT_LOGGING_RULES", "qt.multimedia.ffmpeg=false")


def _configure_qt_webengine_stability_flags() -> None:
    """Apply Chromium switches before Qt WebEngine starts.

    Windows Media Foundation hardware encoding can intermittently reject the
    output format selected by Chromium during WebRTC calls, producing
    ``mf_video_encoder_util.cc:552 Set output type failed (0x80070057)`` and
    leaving Kindroid calls stalled after initially working.  Prefer software
    video encoding while leaving normal GPU compositing/rendering enabled.
    """
    stability_flags = (
        "--disable-accelerated-video-encode",
        "--disable-features=MediaFoundationVideoEncoder",
    )
    existing = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "").strip()
    tokens = existing.split() if existing else []
    for flag in stability_flags:
        if flag not in tokens:
            tokens.append(flag)
    os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = " ".join(tokens)


_configure_qt_webengine_stability_flags()

CALL_SFX_TARGETS = [
    {
        "key": "ringtone.mp3",
        "label": "Incoming Ring",
        "description": "Plays while waiting for the call to connect.",
    },
    {
        "key": "call-en.mp3",
        "label": "Connect Prompt",
        "description": "Language prompt that plays right before connection.",
    },
    {
        "key": "call-end.mp3",
        "label": "Call End Cue",
        "description": "Sound played when the call is ended.",
    },
    {
        "key": "call-begin.mp3",
        "label": "Begin Cue",
        "description": "Sound played when the call actually begins.",
    },
]
CALL_SFX_RUNTIME_DISABLED_SCRIPT_NAME = "Kindroid Call Custom SFX Menu-0.1.user.js"


def _default_documents_dir() -> Path:
    """Return the KINDROIDXL storage root, preferring the dedicated D: drive."""
    d_drive = Path("D:/")
    if (d_drive / "KINDROIDXL").exists() or d_drive.exists():
        return d_drive

    home = Path.home()

    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        documents = Path(user_profile) / "Documents"
        if documents.exists():
            return documents

    home_documents = home / "Documents"
    if home_documents.exists():
        return home_documents

    return home


APP_DATA_DIR = _default_documents_dir() / "KINDROIDXL" / "kindroidxl_data"
LOGGER = configure_logging(APP_DATA_DIR, debug=DEBUG_CONSOLE_OUTPUT)
DOCUMENTS_KINDROID_DIR = _default_documents_dir() / "KINDROIDXL"
DOCUMENTS_KINDROID_BACKUPS_DIR = _default_documents_dir() / "KINDROIDXL-backups"
PROFILE_DIR = APP_DATA_DIR / "web_profile"
CONFIG_PATH = APP_DATA_DIR / "config.json"
CONFIG_BACKUP_PATH = APP_DATA_DIR / "config.backup.json"
LAUNCHER_COMMAND_PATH = APP_DATA_DIR / "launcher_command.json"
LIFELINE_MEMORY_DB_PATH = APP_DATA_DIR / "lifeline_memory.db"
LEGACY_LIFELINE_MEMORY_DB_PATH = APP_ROOT / "lifeline_memory.db"
DIRECTORY_MINDSET_DB_PATH = APP_DATA_DIR / "directory_mindset.db"
DIRECTORY_VOICE_SAMPLES_DIR = APP_DATA_DIR / "directory_voice_samples"
SQLITE_BACKUP_SUFFIXES = {".db", ".sqlite", ".sqlite3"}


def _legacy_documents_kindroid_dir() -> Path:
    """Return the previous Documents-based KINDROIDXL root for path recovery."""
    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        return Path(user_profile) / "Documents" / "KINDROIDXL"
    return Path.home() / "Documents" / "KINDROIDXL"


def _remap_legacy_kindroid_path(value: str) -> tuple[str, bool]:
    r"""Map old Documents\KINDROIDXL absolute paths to the active KINDROIDXL root."""
    text = str(value)
    if not text:
        return text, False

    active_root = DOCUMENTS_KINDROID_DIR
    legacy_root = _legacy_documents_kindroid_dir()
    if active_root == legacy_root:
        return text, False

    active_variants = [str(active_root), str(active_root).replace("/", "\\")]
    legacy_variants = [str(legacy_root), str(legacy_root).replace("/", "\\")]
    for legacy_prefix in legacy_variants:
        if text.casefold().startswith(legacy_prefix.casefold()):
            suffix = text[len(legacy_prefix):].lstrip("\\/")
            separator = "\\" if "\\" in text else "/"
            active_prefix = active_variants[1] if separator == "\\" else active_variants[0]
            return active_prefix + (separator + suffix if suffix else ""), True
    return text, False


def _remap_legacy_kindroid_paths(payload: object) -> tuple[object, bool]:
    """Recursively repair stored media/config paths after moving KINDROIDXL to D:."""
    if isinstance(payload, dict):
        changed = False
        repaired: dict[object, object] = {}
        for key, value in payload.items():
            repaired_value, value_changed = _remap_legacy_kindroid_paths(value)
            repaired[key] = repaired_value
            changed = changed or value_changed
        return repaired, changed
    if isinstance(payload, list):
        changed = False
        repaired_items: list[object] = []
        for item in payload:
            repaired_item, item_changed = _remap_legacy_kindroid_paths(item)
            repaired_items.append(repaired_item)
            changed = changed or item_changed
        return repaired_items, changed
    if isinstance(payload, str):
        return _remap_legacy_kindroid_path(payload)
    return payload, False
JAVASCRIPTS_DIR = APP_ROOT / "javascripts"
ADDONS_PATH = APP_ROOT / "addons.json"
_INSTANCE_GUARD = None


def _lifeline_memory_manager_script() -> Path:
    return APP_ROOT / "lifeline_memory_manager.py"


def _is_lifeline_memory_manager_running(script_path: Path) -> bool:
    script_text = str(script_path.resolve())
    for process in psutil.process_iter(["pid", "cmdline"]):
        try:
            cmdline = process.info.get("cmdline") or []
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue
        for part in cmdline:
            try:
                if str(Path(part).resolve()) == script_text:
                    return True
            except (OSError, RuntimeError):
                if str(part) == script_text:
                    return True
    return False


def _python_executable_for_child_process() -> str:
    """Return a Python interpreter that can run helper scripts beside main.py."""
    if not getattr(sys, "frozen", False):
        return sys.executable

    base_executable = getattr(sys, "_base_executable", "")
    if base_executable and Path(base_executable).exists():
        return str(base_executable)

    executable_path = Path(sys.executable)
    candidates = []
    if sys.platform.startswith("win"):
        candidates.extend([executable_path.with_name("pythonw.exe"), executable_path.with_name("python.exe")])
    candidates.append(executable_path)
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return sys.executable


def _launch_lifeline_memory_manager() -> subprocess.Popen | None:
    """Start the LIFELINE memory manager with folder watching enabled."""
    script_path = _lifeline_memory_manager_script()
    if not script_path.exists():
        print(f"[WARN] LIFELINE Memory Manager not found: {script_path}")
        return None
    if _is_lifeline_memory_manager_running(script_path):
        print("[INFO] LIFELINE Memory Manager is already running.")
        return None

    creationflags = 0
    popen_kwargs: dict[str, object] = {}
    if sys.platform.startswith("win"):
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        popen_kwargs["start_new_session"] = True

    log_path = APP_DATA_DIR / "lifeline_memory_manager.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("a", encoding="utf-8")
    print(f"[LIFELINE DB] launching manager with --db-path: {LIFELINE_MEMORY_DB_PATH}")
    print(f"[INFO] Starting LIFELINE Memory Manager: {script_path}")
    try:
        process = subprocess.Popen(
            [
                _python_executable_for_child_process(),
                str(script_path),
                "--auto-start",
                "--main-pid",
                str(os.getpid()),
                "--main-script",
                str(Path(__file__).resolve()),
                "--db-path",
                str(LIFELINE_MEMORY_DB_PATH),
                "--backup-root",
                str(DOCUMENTS_KINDROID_BACKUPS_DIR),
            ],
            cwd=str(APP_ROOT),
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            close_fds=not sys.platform.startswith("win"),
            creationflags=creationflags,
            **popen_kwargs,
        )
        return process
    finally:
        log_file.close()


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Atomically write JSON to disk to avoid truncated files on abrupt exits."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.tmp")
    try:
        with temp_path.open("w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        temp_path.replace(path)
    except OSError:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def ensure_dependencies() -> None:
    """Install missing dependencies into the current Python environment.

    The checks are module-based so we can guarantee runtime imports work.
    Each missing module maps to the pip package to install in the active venv.
    """
    missing_packages: list[str] = []
    for import_name, package_name in REQUIRED_PIP_PACKAGES.items():
        if importlib.util.find_spec(import_name) is None:
            if package_name not in missing_packages:
                missing_packages.append(package_name)

    if not missing_packages:
        return

    print(f"Installing missing packages into active environment: {', '.join(missing_packages)}")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--upgrade", *missing_packages])


ensure_dependencies()

import requests
import psutil
from PySide6.QtCore import QByteArray, QEvent, QObject, QRect, QSize, QSharedMemory, Qt, QThread, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QAction, QColor, QCursor, QFont, QGuiApplication, QIcon, QLinearGradient, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QColorDialog,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QMenu,
    QInputDialog,
    QScrollArea,
    QSplitter,
    QStyle,
    QSystemTrayIcon,
    QTextEdit,
    QTabWidget,
    QToolButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineScript, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView

import modules.addons as addons
import modules.calendar_tab as calendar_tab
import modules.feeder as feeder
import modules.journal as journal
import modules.podcast_tab as podcast_tab
import modules.home_tab as home_tab
import modules.groupmaker as groupmaker
import modules.house_council as house_council
import modules.generations as generations
import modules.houses as houses
from modules.communication_avatar import DEFAULTS as COMMUNICATION_AVATAR_DEFAULTS
from modules.communication_avatar import CommunicationAvatarPanel
from modules.bloodlines import build_house_context, family_from_name, normalize_family_name
from modules.name_outline_delegate import NAME_OUTLINE_COLOR_ROLE, NameOutlineDelegate


class KindroidWebPage(QWebEnginePage):
    """Web page that suppresses noisy Kindroid/KXL JavaScript console output by default."""

    def acceptNavigationRequest(self, url: QUrl, nav_type, is_main_frame: bool) -> bool:  # type: ignore[override]
        if url.scheme().casefold() == "kindroidxl" and url.host().casefold() == "groupmaker":
            if url.path().strip("/") == "sync-now":
                self._request_groupmaker_sync_now()
            return False
        return super().acceptNavigationRequest(url, nav_type, is_main_frame)

    def javaScriptConsoleMessage(self, level, message: str, line_number: int, source_id: str) -> None:  # type: ignore[override]
        text = str(message or "")
        if text.strip() == "__KXL_GROUPMAKER_SYNC_NOW__":
            self._request_groupmaker_sync_now()
            return
        if not DEBUG_CONSOLE_OUTPUT:
            return
        print(f"[KINDROID JS] {text} ({source_id}:{line_number})")

    def _request_groupmaker_sync_now(self) -> None:
        # Startup can still be building GROUPMAKER while the Kindroid userscript
        # already sees mic audio. Keep the first request alive long enough for
        # the tab and Sync Now handler to finish initializing instead of making
        # the user manually warm it up once.
        self._groupmaker_sync_now_pending_until_ms = int(time.monotonic() * 1000) + 120000
        self._retry_groupmaker_sync_now()

    def _retry_groupmaker_sync_now(self) -> None:
        if self._click_groupmaker_sync_now():
            self._groupmaker_sync_now_retry_scheduled = False
            return

        now_ms = int(time.monotonic() * 1000)
        pending_until_ms = int(getattr(self, "_groupmaker_sync_now_pending_until_ms", 0) or 0)
        if now_ms >= pending_until_ms:
            self._groupmaker_sync_now_retry_scheduled = False
            return

        if getattr(self, "_groupmaker_sync_now_retry_scheduled", False):
            return
        self._groupmaker_sync_now_retry_scheduled = True

        def retry() -> None:
            self._groupmaker_sync_now_retry_scheduled = False
            self._retry_groupmaker_sync_now()

        QTimer.singleShot(250, retry)

    def _groupmaker_sync_ready(self, group_tab) -> bool:
        status_box = getattr(group_tab, "status_box", None)
        names_box = getattr(group_tab, "names_box", None)
        context = status_box.toPlainText().strip() if status_box is not None and hasattr(status_box, "toPlainText") else ""
        names = names_box.toPlainText().strip() if names_box is not None and hasattr(names_box, "toPlainText") else ""
        if not context or not names:
            return False
        root = getattr(group_tab, "_root", None)
        if root is None or not hasattr(root, "get_default_api_key"):
            return False
        return str(root.get_default_api_key()).strip().startswith("kn_")

    def _click_groupmaker_sync_now(self) -> bool:
        now_ms = int(time.monotonic() * 1000)
        if now_ms - int(getattr(self, "_last_groupmaker_sync_now_click_ms", 0) or 0) < 1500:
            return True

        candidates = []
        seen = set()

        def add_candidate(candidate) -> None:
            if candidate is None:
                return
            marker = id(candidate)
            if marker in seen:
                return
            seen.add(marker)
            candidates.append(candidate)
            light_main = getattr(candidate, "main_window", None)
            if light_main is not None:
                add_candidate(light_main)

        parent = self.parent()
        while parent is not None:
            add_candidate(parent)
            parent = parent.parent()

        app = QApplication.instance()
        if app is not None:
            add_candidate(app.activeWindow())
            for widget in app.topLevelWidgets():
                add_candidate(widget)

        for candidate in candidates:
            group_tab = getattr(candidate, "groupmaker_tab", None)
            if group_tab is None:
                continue
            if getattr(group_tab, "_api_thread", None) is not None:
                return True
            if not self._groupmaker_sync_ready(group_tab):
                continue

            sync_btn = getattr(group_tab, "sync_btn", None)
            if sync_btn is not None and hasattr(sync_btn, "click"):
                if hasattr(sync_btn, "isEnabled") and not sync_btn.isEnabled():
                    continue
                self._last_groupmaker_sync_now_click_ms = now_ms
                QTimer.singleShot(0, sync_btn.click)
                return True

            sync_handler = getattr(group_tab, "_sync_from_text_safely", None)
            if callable(sync_handler):
                self._last_groupmaker_sync_now_click_ms = now_ms
                QTimer.singleShot(0, sync_handler)
                return True
        return False


class FetchSendWorker(QObject):
    finished = Signal(int, int, list)

    def __init__(self, jobs: list[dict[str, object]]) -> None:
        super().__init__()
        self._jobs = jobs

    @Slot()
    def run(self) -> None:
        sent = 0
        failed = 0
        successes: list[object] = []
        for job in self._jobs:
            ok, _status, _detail = feeder.execute_api_request(
                tool_key="send_message",
                api_key=str(job.get("api_key", "")),
                payload=job.get("payload", {}),
                requester=str(job.get("requester", "KINDROIDXL-FETCHER")),
            )
            if ok:
                sent += 1
                successes.append(job.get("success_token"))
            else:
                failed += 1
        self.finished.emit(sent, failed, successes)


class DirectoryGlobalUpdateWorker(QObject):
    finished = Signal(int, int)

    def __init__(self, jobs: list[dict[str, object]]) -> None:
        super().__init__()
        self._jobs = jobs

    @Slot()
    def run(self) -> None:
        attempted = 0
        failed = 0
        for job in self._jobs:
            payload = job.get("payload", {})
            if not isinstance(payload, dict) or not payload:
                continue
            attempted += 1
            ok, _status, _response = feeder.execute_api_request(
                tool_key="update_kin",
                api_key=str(job.get("api_key", "")),
                payload=payload,
                requester="KINDROIDXL-DIRECTORY-GLOBAL-UPDATE",
            )
            if not ok:
                failed += 1
        self.finished.emit(attempted, failed)


class DirectoryMindsetWorker(QObject):
    finished = Signal(str)
    failed = Signal(str)
    progress = Signal(str)

    def __init__(self, base_url: str, model: str, system_prompt: str, user_input: str, timeout_seconds: int = 180) -> None:
        super().__init__()
        self.base_url = self._normalize_base_url(base_url)
        self.model = model.strip()
        self.system_prompt = system_prompt.strip()
        self.user_input = user_input.strip()
        self.timeout_seconds = max(15, timeout_seconds)

    @staticmethod
    def _normalize_base_url(base_url: str) -> str:
        cleaned = str(base_url or "").strip().rstrip("/")
        for suffix in ("/api", "/api/chat", "/api/generate", "/v1/chat/completions"):
            if cleaned.endswith(suffix):
                return cleaned[: -len(suffix)]
        return cleaned

    @Slot()
    def run(self) -> None:
        def _extract_text(event: dict) -> str:
            token = str(event.get("response", "")).strip()
            if token:
                return token
            message_obj = event.get("message", {})
            if isinstance(message_obj, dict):
                content = str(message_obj.get("content", "")).strip()
                if content:
                    return content
            content = str(event.get("content", "")).strip()
            return content

        if not self.model:
            self.failed.emit("No Ollama model configured.")
            return
        self.progress.emit("[connecting]")
        self.progress.emit("[stream /api/generate]")
        chunks: list[str] = []
        saw_done = False
        try:
            response = requests.post(
                f"{self.base_url}/api/generate",
                headers={"Content-Type": "application/json"},
                json={
                    "model": self.model,
                    "prompt": self.user_input,
                    "system": self.system_prompt,
                    "stream": True,
                    "keep_alive": "30m",
                },
                stream=True,
                timeout=(self.timeout_seconds, max(20, min(60, self.timeout_seconds // 2))),
            )
            response.raise_for_status()
            for raw_line in response.iter_lines(decode_unicode=True):
                if not raw_line:
                    continue
                try:
                    event = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                err = str(event.get("error", "")).strip()
                if err:
                    self.failed.emit(err)
                    return
                token = _extract_text(event)
                if token:
                    chunks.append(token)
                    self.progress.emit(token)
                if event.get("done"):
                    saw_done = True
                    break
        except requests.RequestException as exc:
            self.failed.emit(str(exc))
            return
        except Exception as exc:
            self.failed.emit(str(exc))
            return

        if not saw_done:
            self.failed.emit("No done=true event received from Ollama stream.")
            return
        final_text = "".join(chunks).strip()
        if not final_text:
            self.failed.emit("Ollama returned no response text.")
            return
        self.finished.emit(final_text)


class DirectoryPromptDialog(QDialog):
    def __init__(self, title: str, text: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(640, 420)
        layout = QVBoxLayout(self)
        self.editor = QTextEdit(self)
        self.editor.setPlainText(text)
        layout.addWidget(self.editor, 1)
        actions = QHBoxLayout()
        save_btn = QPushButton("Save", self)
        cancel_btn = QPushButton("Cancel", self)
        save_btn.clicked.connect(self.accept)
        cancel_btn.clicked.connect(self.reject)
        actions.addStretch(1)
        actions.addWidget(save_btn)
        actions.addWidget(cancel_btn)
        layout.addLayout(actions)

    def prompt_text(self) -> str:
        return self.editor.toPlainText().strip()


class AdditionalContextPresetsDialog(QDialog):
    def __init__(self, presets: list[dict[str, str]], current_text: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Additional Context Presets")
        self.resize(760, 520)
        self._selected_text = ""
        self._presets: list[dict[str, str]] = []
        for row in presets:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name", "")).strip()
            text = str(row.get("text", "")).strip()
            if not name or not text:
                continue
            self._presets.append({"name": name, "text": text})

        layout = QVBoxLayout(self)
        top = QHBoxLayout()
        self.preset_name_input = QLineEdit(self)
        self.preset_name_input.setPlaceholderText("Preset name")
        top.addWidget(self.preset_name_input, 1)
        self.save_btn = QPushButton("Save Current as Preset", self)
        self.save_btn.clicked.connect(lambda: self._save_current_preset(current_text))
        top.addWidget(self.save_btn)
        layout.addLayout(top)

        self.presets_list = QListWidget(self)
        self.presets_list.itemSelectionChanged.connect(self._sync_editor_from_selection)
        layout.addWidget(self.presets_list, 1)

        self.editor = QTextEdit(self)
        self.editor.setPlaceholderText("Preset content")
        layout.addWidget(self.editor, 2)

        actions = QHBoxLayout()
        self.rename_btn = QPushButton("Rename", self)
        self.rename_btn.clicked.connect(self._rename_selected)
        self.delete_btn = QPushButton("Delete", self)
        self.delete_btn.clicked.connect(self._delete_selected)
        self.apply_btn = QPushButton("Load + Replace Field", self)
        self.apply_btn.clicked.connect(self._apply_selected)
        cancel_btn = QPushButton("Cancel", self)
        cancel_btn.clicked.connect(self.reject)
        actions.addWidget(self.rename_btn)
        actions.addWidget(self.delete_btn)
        actions.addStretch(1)
        actions.addWidget(self.apply_btn)
        actions.addWidget(cancel_btn)
        layout.addLayout(actions)

        self._refresh_list()

    def presets(self) -> list[dict[str, str]]:
        return list(self._presets)

    def selected_text(self) -> str:
        return self._selected_text

    def _refresh_list(self) -> None:
        selected_name = ""
        current = self.presets_list.currentItem()
        if current is not None:
            selected_name = str(current.data(Qt.ItemDataRole.UserRole) or "").strip()
        self.presets_list.blockSignals(True)
        self.presets_list.clear()
        for row in self._presets:
            item = QListWidgetItem(str(row.get("name", "")).strip())
            item.setData(Qt.ItemDataRole.UserRole, str(row.get("name", "")).strip())
            item.setData(Qt.ItemDataRole.UserRole + 1, str(row.get("text", "")).strip())
            self.presets_list.addItem(item)
        self.presets_list.blockSignals(False)
        if self.presets_list.count() == 0:
            self.editor.clear()
            return
        selected_row = 0
        if selected_name:
            for idx in range(self.presets_list.count()):
                item = self.presets_list.item(idx)
                if item is not None and str(item.data(Qt.ItemDataRole.UserRole) or "").strip() == selected_name:
                    selected_row = idx
                    break
        self.presets_list.setCurrentRow(selected_row)
        self._sync_editor_from_selection()

    def _find_index_by_name(self, name: str) -> int:
        clean = str(name).strip().casefold()
        for idx, row in enumerate(self._presets):
            if str(row.get("name", "")).strip().casefold() == clean:
                return idx
        return -1

    def _save_current_preset(self, text: str) -> None:
        content = str(text).strip()
        if not content:
            QMessageBox.warning(self, "Preset", "Additional Context is empty; nothing to save.")
            return
        name = self.preset_name_input.text().strip() or f"Preset {len(self._presets) + 1}"
        idx = self._find_index_by_name(name)
        if idx >= 0:
            self._presets[idx] = {"name": name, "text": content}
        else:
            self._presets.append({"name": name, "text": content})
        self._refresh_list()

    def _sync_editor_from_selection(self) -> None:
        item = self.presets_list.currentItem()
        if item is None:
            self.editor.clear()
            return
        self.editor.setPlainText(str(item.data(Qt.ItemDataRole.UserRole + 1) or "").strip())
        self.preset_name_input.setText(str(item.data(Qt.ItemDataRole.UserRole) or "").strip())

    def _rename_selected(self) -> None:
        item = self.presets_list.currentItem()
        if item is None:
            return
        old_name = str(item.data(Qt.ItemDataRole.UserRole) or "").strip()
        new_name = self.preset_name_input.text().strip()
        if not new_name:
            QMessageBox.warning(self, "Rename Preset", "Enter a new preset name first.")
            return
        idx = self._find_index_by_name(old_name)
        if idx < 0:
            return
        self._presets[idx]["name"] = new_name
        self._presets[idx]["text"] = self.editor.toPlainText().strip()
        self._refresh_list()

    def _delete_selected(self) -> None:
        item = self.presets_list.currentItem()
        if item is None:
            return
        name = str(item.data(Qt.ItemDataRole.UserRole) or "").strip()
        self._presets = [row for row in self._presets if str(row.get("name", "")).strip() != name]
        self._refresh_list()

    def _apply_selected(self) -> None:
        item = self.presets_list.currentItem()
        if item is None:
            QMessageBox.warning(self, "Load Preset", "Select a preset first.")
            return
        self._selected_text = str(self.editor.toPlainText()).strip()
        if not self._selected_text:
            QMessageBox.warning(self, "Load Preset", "Selected preset is empty.")
            return
        self.accept()


class DirectoryMindsetDialog(QDialog):
    DEFAULT_PROMPTS = {
        "collector": "Collector system role: Track and preserve raw profile text exactly as entered.",
        "condenser": (
            "You are CONDENSER. Condense the source into a compact but information-dense summary. Preserve all key "
            "facts, names, relationships, timeline anchors, motivations, and constraints. Remove fluff/repetition only."
        ),
        "generator": (
            "You are GENERATOR. Take the condensed source and produce an improved, richer final profile text for a "
            "DIRECTORY field. Keep all true facts and constraints from the input, improve prose quality, and expand "
            "with nuance/clarity without inventing contradictions. Target 2100-2450 characters when possible. Hard max 2500."
        ),
        "formatter": "You are FORMATTER. Return strict JSON only, no prose.",
        "executor": "Executor monitors formatter output and prepares downstream actions.",
    }
    MODULE_ORDER = ["collector", "condenser", "generator", "formatter", "executor"]
    COLLECTOR_FIELDS = [
        "backstory",
        "ai_memory",
        "greeting",
        "directive",
        "additional_context",
        "avatar_description",
    ]

    def __init__(self, root: "KindroidMainWindow", person_snapshot: dict[str, str], parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._root = root
        self._person_snapshot = person_snapshot
        self._worker_thread: QThread | None = None
        self._worker: DirectoryMindsetWorker | None = None
        self._active_module = ""
        self._pipeline_active = False
        self._pending_source_id: int | None = None
        self._pending_meta: dict[str, str] = {}
        self._live_buffer = ""
        self._db_path = DIRECTORY_MINDSET_DB_PATH
        self._module_widgets: dict[str, dict[str, QWidget]] = {}
        self._ensure_db()
        self._build_ui()
        self._load_prompts()

    def _ensure_db(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS prompts (module_name TEXT PRIMARY KEY, prompt_text TEXT NOT NULL)"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS outputs (id INTEGER PRIMARY KEY AUTOINCREMENT, module_name TEXT, output_text TEXT, created_at TEXT)"
            )
            conn.execute("CREATE TABLE IF NOT EXISTS module_state (state_key TEXT PRIMARY KEY, state_value TEXT NOT NULL)")
            try:
                conn.execute("ALTER TABLE outputs ADD COLUMN source_output_id INTEGER")
            except sqlite3.OperationalError:
                pass
            try:
                conn.execute("ALTER TABLE outputs ADD COLUMN metadata_json TEXT")
            except sqlite3.OperationalError:
                pass

    def _build_ui(self) -> None:
        self.setWindowTitle("DIRECTORY • AI ENGINE")
        self.resize(1120, 760)
        self.setStyleSheet(
            "QDialog{background:#070b16;color:#deebff;} QFrame{background:#101a2f;border:1px solid #2f4a78;border-radius:12px;}"
            "QLineEdit,QTextEdit{background:#0d162a;border:1px solid #39598f;border-radius:8px;color:#eaf2ff;padding:6px;}"
            "QPushButton{background:#1a3566;border:1px solid #5f86c9;border-radius:8px;color:white;font-weight:700;padding:6px 10px;}"
        )
        outer = QVBoxLayout(self)
        top = QHBoxLayout()
        self.base_url_input = QLineEdit(self)
        self.base_url_input.setText(str(self._root.config.get("directory_ai_base_url", "http://127.0.0.1:11434")).strip())
        self.model_input = QLineEdit(self)
        self.model_input.setText(str(self._root.config.get("directory_ai_model", "qwen3.5:9b")).strip())
        self.status_label = QLabel("Ready", self)
        run_all_btn = QPushButton("Run Pipeline", self)
        run_all_btn.clicked.connect(self._run_pipeline)
        top.addWidget(QLabel("Ollama URL", self))
        top.addWidget(self.base_url_input, 2)
        top.addWidget(QLabel("Model", self))
        top.addWidget(self.model_input, 1)
        top.addWidget(run_all_btn)
        top.addWidget(self.status_label)
        outer.addLayout(top)
        self.live_reflection_box = QTextEdit(self)
        self.live_reflection_box.setReadOnly(True)
        self.live_reflection_box.setMinimumHeight(92)
        self.live_reflection_box.setPlaceholderText("Live AI reflection appears here while modules run...")
        outer.addWidget(self.live_reflection_box)

        self.seed_input = QTextEdit(self)
        self.seed_input.setMinimumHeight(120)
        self.seed_input.setPlainText(self._seed_text())
        collector_row = QHBoxLayout()
        collector_row.addWidget(QLabel("Collector Field", self))
        self.collector_field_combo = QComboBox(self)
        for field_name in self.COLLECTOR_FIELDS:
            self.collector_field_combo.addItem(field_name, field_name)
        self.collector_field_combo.currentIndexChanged.connect(self._refresh_collector_preview)
        collector_row.addWidget(self.collector_field_combo, 1)
        collector_row.addStretch(1)
        outer.addLayout(collector_row)
        outer.addWidget(QLabel("Collector Preview", self))
        outer.addWidget(self.seed_input)

        cards_row = QHBoxLayout()
        for key in self.MODULE_ORDER:
            card = QFrame(self)
            card_layout = QVBoxLayout(card)
            title = QLabel(key.upper(), card)
            title.setStyleSheet("font-size:16px;font-weight:900;color:#9bc6ff;")
            output = QTextEdit(card)
            output.setReadOnly(True)
            output.setMinimumHeight(140)
            meta = QLabel("Idle", card)
            btns = QHBoxLayout()
            prompt_btn = QPushButton("PROMPT", card)
            run_btn = QPushButton("RUN AI", card)
            prompt_btn.clicked.connect(lambda _=False, module=key: self._edit_prompt(module))
            run_btn.clicked.connect(lambda _=False, module=key: self._run_module(module))
            btns.addWidget(prompt_btn)
            btns.addWidget(run_btn)
            card_layout.addWidget(title)
            card_layout.addLayout(btns)
            card_layout.addWidget(output, 1)
            card_layout.addWidget(meta)
            cards_row.addWidget(card, 1)
            self._module_widgets[key] = {"output": output, "meta": meta}
        outer.addLayout(cards_row, 1)
        self._refresh_collector_preview()

    def _seed_text(self) -> str:
        person = self._person_snapshot or {}
        return (
            f"Name: {person.get('name','')}\n"
            f"AI ID: {person.get('ai_id','')}\n"
            f"Location: {person.get('location','')}\n\n"
            f"Backstory:\n{person.get('backstory','')}\n\n"
            f"Directive:\n{person.get('directive','')}\n\n"
            f"Memory:\n{person.get('ai_memory','')}\n"
        ).strip()

    def _current_entry(self) -> dict[str, str]:
        snapshot = dict(self._person_snapshot) if isinstance(self._person_snapshot, dict) else {}
        ai_id = str(snapshot.get("ai_id", "")).strip()
        name = str(snapshot.get("name", "")).strip().casefold()
        for entry in self._directory_entries_raw():
            if ai_id and str(entry.get("ai_id", "")).strip() == ai_id:
                merged = {str(k): str(v) for k, v in entry.items()}
                merged.update({str(k): str(v) for k, v in snapshot.items()})
                return merged
            if name and str(entry.get("name", "")).strip().casefold() == name:
                merged = {str(k): str(v) for k, v in entry.items()}
                merged.update({str(k): str(v) for k, v in snapshot.items()})
                return merged
        return {str(k): str(v) for k, v in snapshot.items()}

    def update_person_snapshot(self, person_snapshot: dict[str, str]) -> None:
        self._person_snapshot = dict(person_snapshot or {})
        self._refresh_collector_preview()

    def _directory_entries_raw(self) -> list[dict[str, object]]:
        raw = self._root.config.get("directory_entries", [])
        if not isinstance(raw, list):
            return []
        return [item for item in raw if isinstance(item, dict)]

    def _refresh_collector_preview(self) -> None:
        field = self.collector_field_combo.currentData()
        entry = self._current_entry()
        self.seed_input.setPlainText(str(entry.get(str(field), "")).strip())

    def run_pipeline_for_field(self, field_name: str) -> bool:
        return self.select_field(field_name)

    def select_field(self, field_name: str) -> bool:
        clean = str(field_name).strip()
        if not clean:
            return False
        idx = self.collector_field_combo.findData(clean)
        if idx < 0:
            return False
        self.collector_field_combo.setCurrentIndex(idx)
        self._refresh_collector_preview()
        return True

    def _save_settings(self) -> None:
        self._root.config["directory_ai_base_url"] = self.base_url_input.text().strip()
        self._root.config["directory_ai_model"] = self.model_input.text().strip()
        self._root._save_config(self._root.config)

    def _prompt_for(self, module: str) -> str:
        with sqlite3.connect(self._db_path) as conn:
            row = conn.execute("SELECT prompt_text FROM prompts WHERE module_name = ?", (module,)).fetchone()
        return str(row[0]) if row else self.DEFAULT_PROMPTS[module]

    def _set_prompt_for(self, module: str, text: str) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                "INSERT INTO prompts (module_name, prompt_text) VALUES (?, ?) ON CONFLICT(module_name) DO UPDATE SET prompt_text=excluded.prompt_text",
                (module, text),
            )

    def _latest_output(self, module: str) -> str:
        record = self._latest_output_record(module)
        return record["text"] if record else ""

    def _latest_output_record(self, module: str) -> dict[str, object] | None:
        with sqlite3.connect(self._db_path) as conn:
            row = conn.execute(
                "SELECT id, output_text, source_output_id, metadata_json FROM outputs WHERE module_name=? ORDER BY id DESC LIMIT 1",
                (module,),
            ).fetchone()
        if not row:
            return None
        meta_raw = str(row[3] or "").strip()
        meta: dict[str, str] = {}
        if meta_raw:
            try:
                parsed = json.loads(meta_raw)
                if isinstance(parsed, dict):
                    meta = {str(k): str(v) for k, v in parsed.items()}
            except json.JSONDecodeError:
                meta = {}
        return {"id": int(row[0]), "text": str(row[1] or ""), "source_id": int(row[2] or 0), "meta": meta}

    def _save_output(self, module: str, text: str, *, source_output_id: int = 0, meta: dict[str, str] | None = None) -> int:
        metadata_json = json.dumps(meta or {})
        with sqlite3.connect(self._db_path) as conn:
            cursor = conn.execute(
                "INSERT INTO outputs (module_name, output_text, created_at, source_output_id, metadata_json) VALUES (?, ?, ?, ?, ?)",
                (module, text, datetime.utcnow().isoformat(), int(source_output_id or 0), metadata_json),
            )
            return int(cursor.lastrowid)

    def _state(self, key: str, default: str = "0") -> str:
        with sqlite3.connect(self._db_path) as conn:
            row = conn.execute("SELECT state_value FROM module_state WHERE state_key = ?", (key,)).fetchone()
        return str(row[0]) if row else default

    def _set_state(self, key: str, value: str) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                "INSERT INTO module_state (state_key, state_value) VALUES (?, ?) ON CONFLICT(state_key) DO UPDATE SET state_value=excluded.state_value",
                (key, value),
            )

    def _load_prompts(self) -> None:
        self._upgrade_legacy_prompts()
        for module in self.MODULE_ORDER:
            _ = self._prompt_for(module)

    def _upgrade_legacy_prompts(self) -> None:
        legacy_prompts = {
            "condenser": "You are CONDENSER. Condense the source while preserving names, timeline, facts, and key actions.",
            "generator": "You are GENERATOR. Improve and enrich the story with better clarity, flow, and emotional detail while staying faithful to the source and keeping output under 2500 characters.",
        }
        wrong_recent_prompts = {
            "condenser": (
                "You are CONDENSER. Do NOT summarize. Rewrite and amplify the source into a richer, more vivid profile "
                "while preserving all concrete facts, names, timeline details, and intent. Expand weak phrasing, deepen "
                "emotional texture, and improve readability. Target 1400-2200 characters unless source is very short."
            ),
            "generator": (
                "You are GENERATOR. Produce a polished final field text suitable for DIRECTORY storage. Keep every true "
                "fact from the input, improve structure and cadence, and add meaningful nuance without inventing lore. "
                "Length target: 1800-2450 characters. Hard maximum: 2500 characters."
            ),
        }
        with sqlite3.connect(self._db_path) as conn:
            for module, legacy in legacy_prompts.items():
                row = conn.execute("SELECT prompt_text FROM prompts WHERE module_name = ?", (module,)).fetchone()
                if not row:
                    continue
                current = str(row[0] or "").strip()
                if current == legacy or current == wrong_recent_prompts[module]:
                    conn.execute(
                        "UPDATE prompts SET prompt_text = ? WHERE module_name = ?",
                        (self.DEFAULT_PROMPTS[module], module),
                    )

    def _edit_prompt(self, module: str) -> None:
        dialog = DirectoryPromptDialog(f"Edit prompt: {module}", self._prompt_for(module), self)
        if dialog.exec() == QDialog.DialogCode.Accepted and dialog.prompt_text():
            self._set_prompt_for(module, dialog.prompt_text())
            meta = self._module_widgets[module]["meta"]
            assert isinstance(meta, QLabel)
            meta.setText("Prompt saved")

    def _input_for_module(self, module: str) -> str:
        if module == "collector":
            return self.seed_input.toPlainText().strip()
        idx = self.MODULE_ORDER.index(module)
        prev = self.MODULE_ORDER[idx - 1]
        return self._latest_output(prev)

    def _run_pipeline(self) -> None:
        self._pipeline_active = True
        self._run_module("collector", pipeline_mode=True)
        self._tick_pipeline()

    def _run_module(self, module: str, pipeline_mode: bool = False) -> None:
        if self._is_worker_active():
            if not pipeline_mode:
                QMessageBox.information(self, "AI Busy", "Another module is still running.")
            return
        self._save_settings()
        if module == "collector":
            self._run_collector()
            return
        if module == "condenser":
            self._run_condenser()
            return
        if module == "generator":
            self._run_generator()
            return
        if module == "formatter":
            self._run_formatter()
            return
        if module == "executor":
            self._run_executor()
            return

    def _run_collector(self) -> None:
        entry = self._current_entry()
        field = str(self.collector_field_combo.currentData() or "").strip()
        if not field:
            QMessageBox.warning(self, "Collector", "Choose a field to collect.")
            return
        preview_text = self.seed_input.toPlainText().strip()
        text = preview_text if preview_text else str(entry.get(field, "")).strip()
        if preview_text != text:
            self.seed_input.setPlainText(text)
        meta = {
            "field": field,
            "person_ai_id": str(entry.get("ai_id", "")).strip(),
            "person_name": str(entry.get("name", "")).strip(),
        }
        row_id = self._save_output("collector", text, meta=meta)
        self._set_state("collector_latest_id", str(row_id))
        self._set_card_output("collector", text, "Collected from DIRECTORY field")

    def _run_condenser(self) -> None:
        collector = self._latest_output_record("collector")
        if not collector:
            return
        collector_id = int(collector["id"])
        prompt = self._prompt_for("condenser")
        self._start_ai_job("condenser", str(collector["text"]), prompt, collector_id, collector.get("meta", {}))

    def _run_generator(self) -> None:
        condenser = self._latest_output_record("condenser")
        if not condenser:
            return
        condenser_id = int(condenser["id"])
        prompt = self._prompt_for("generator")
        self._start_ai_job("generator", str(condenser["text"]), prompt, condenser_id, condenser.get("meta", {}))

    def _run_formatter(self) -> None:
        generator = self._latest_output_record("generator")
        if not generator:
            return
        generator_id = int(generator["id"])
        source_text = str(generator["text"]).strip()
        if len(source_text) <= 2500:
            clean_text = source_text
        else:
            clean_text = self._compress_for_field_limit(source_text, 2500)
        row_id = self._save_output(
            "formatter",
            clean_text,
            source_output_id=generator_id,
            meta=generator.get("meta", {}) if isinstance(generator.get("meta", {}), dict) else {},
        )
        self._set_state("formatter_last_source_id", str(generator_id))
        self._set_state("formatter_latest_id", str(row_id))
        self._set_card_output("formatter", clean_text, "Completed (local formatter)")
        self.live_reflection_box.append(f"[FORMATTER] Applied local length normalizer ({len(clean_text)} chars).")
        if self._pipeline_active:
            QTimer.singleShot(25, self._tick_pipeline)

    @staticmethod
    def _compress_for_field_limit(text: str, limit: int) -> str:
        raw = " ".join(str(text).split())
        if len(raw) <= limit:
            return raw
        sentences = re.split(r"(?<=[.!?])\s+", raw)
        kept: list[str] = []
        current_len = 0
        for sentence in sentences:
            segment = sentence.strip()
            if not segment:
                continue
            add_len = len(segment) + (1 if kept else 0)
            if current_len + add_len > limit:
                break
            kept.append(segment)
            current_len += add_len
        if kept:
            return " ".join(kept)[:limit].rstrip()
        return raw[:limit].rstrip()

    def _run_executor(self) -> None:
        formatter = self._latest_output_record("formatter")
        if not formatter:
            return
        formatter_id = int(formatter["id"])
        meta = formatter.get("meta", {})
        if not isinstance(meta, dict):
            meta = {}
        target_field = str(meta.get("field", "")).strip()
        if not target_field:
            self._set_card_output("executor", "", "Missing target field metadata")
            return
        final_text = str(formatter["text"]).strip()
        if len(final_text) > 2500:
            final_text = final_text[:2500]
        ai_id = str(meta.get("person_ai_id", "")).strip()
        name = str(meta.get("person_name", "")).strip().casefold()
        entries = self._directory_entries_raw()
        updated = False
        for entry in entries:
            if ai_id and str(entry.get("ai_id", "")).strip() == ai_id:
                entry[target_field] = final_text
                updated = True
                break
            if not ai_id and name and str(entry.get("name", "")).strip().casefold() == name:
                entry[target_field] = final_text
                updated = True
                break
        if updated:
            self._root.save_directory_entries(entries)
            self._set_state("executor_last_source_id", str(formatter_id))
            self._set_card_output("executor", final_text, f"Updated DIRECTORY field: {target_field}")
        else:
            self._set_card_output("executor", "", "Could not find matching DIRECTORY person")

    def _set_card_output(self, module: str, text: str, status: str) -> None:
        widgets = self._module_widgets.get(module, {})
        out = widgets.get("output")
        meta = widgets.get("meta")
        if isinstance(out, QTextEdit):
            out.setPlainText(text)
        if isinstance(meta, QLabel):
            meta.setText(status)

    def _start_ai_job(
        self,
        module: str,
        user_input: str,
        system_prompt: str,
        source_id: int,
        meta: dict[str, str] | object,
    ) -> None:
        self._active_module = module
        self._pending_source_id = source_id
        self._pending_meta = dict(meta) if isinstance(meta, dict) else {}
        self.status_label.setText(f"Running {module.upper()}...")
        prompt_preview = " ".join(system_prompt.split())[:220]
        input_preview = " ".join(user_input.split())[:220]
        self.live_reflection_box.setPlainText(
            f"[{module.upper()} START]\nPrompt: {prompt_preview or '(empty)'}\nInput: {input_preview or '(empty)'}"
        )
        self._worker_thread = QThread(self)
        self._worker = DirectoryMindsetWorker(
            base_url=self.base_url_input.text().strip() or "http://127.0.0.1:11434",
            model=self.model_input.text().strip(),
            system_prompt=system_prompt,
            user_input=user_input,
        )
        self._worker.moveToThread(self._worker_thread)
        self._worker_thread.started.connect(self._worker.run)
        self._worker.progress.connect(self._on_worker_progress)
        self._worker.finished.connect(self._on_worker_success)
        self._worker.failed.connect(self._on_worker_failed)
        self._worker.finished.connect(self._worker_thread.quit)
        self._worker.failed.connect(self._worker_thread.quit)
        self._worker.finished.connect(self._worker.deleteLater)
        self._worker.failed.connect(self._worker.deleteLater)
        self._worker_thread.finished.connect(self._on_worker_thread_finished)
        self._worker_thread.start()

    def _tick_pipeline(self) -> None:
        if not self._pipeline_active:
            return
        if self._is_worker_active():
            return
        self._run_condenser()
        if self._is_worker_active():
            return
        self._run_generator()
        if self._is_worker_active():
            return
        self._run_formatter()
        if self._is_worker_active():
            return
        self._run_executor()
        self._pipeline_active = False
        self.status_label.setText("Pipeline complete")

    def _is_worker_active(self) -> bool:
        thread = self._worker_thread
        if thread is None:
            return False
        if thread.isRunning():
            return True
        self._worker_thread = None
        self._worker = None
        self._active_module = ""
        self._pending_source_id = None
        self._pending_meta = {}
        return False

    def _on_worker_success(self, text: str) -> None:
        module = self._active_module
        clean_text = text[:2500] if module in {"generator", "formatter"} else text
        row_id = self._save_output(
            module,
            clean_text,
            source_output_id=int(self._pending_source_id or 0),
            meta=self._pending_meta,
        )
        self._set_state(f"{module}_last_source_id", str(int(self._pending_source_id or 0)))
        self._set_state(f"{module}_latest_id", str(row_id))
        self._set_card_output(module, clean_text, "Completed")
        self.status_label.setText(f"{module.upper()} done")
        self._live_buffer = ""
        if self._pipeline_active:
            QTimer.singleShot(25, self._tick_pipeline)

    def _on_worker_progress(self, delta_text: str) -> None:
        module = self._active_module or "module"
        self._live_buffer += delta_text
        normalized = " ".join(self._live_buffer.split())
        preview = normalized[-240:] if len(normalized) > 240 else normalized
        meta = self._module_widgets.get(module, {}).get("meta")
        if isinstance(meta, QLabel):
            meta.setText(f"Running... {len(normalized)} chars")
        self.live_reflection_box.setPlainText(f"[{module.upper()}]\n{preview}")

    def _on_worker_failed(self, error_text: str) -> None:
        module = self._active_module or "module"
        meta = self._module_widgets.get(module, {}).get("meta")
        if isinstance(meta, QLabel):
            meta.setText(f"Failed: {error_text}")
        self.live_reflection_box.append(f"[{module.upper()}] Failed: {error_text}")
        self.status_label.setText("Failed")
        self._pipeline_active = False

    def _on_worker_thread_finished(self) -> None:
        self._worker_thread = None
        self._worker = None
        self._active_module = ""
        self._pending_source_id = None
        self._pending_meta = {}


class FamilyTreeCanvas(QWidget):
    """Simple painted family tree surface for the DIRECTORY → TREE subtab."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._rows: list[list[dict[str, object]]] = []
        self._edges: list[tuple[str, str]] = []
        self._title = "Select a person in DIRECTORY to view their bloodline."
        self._subtitle = "TREE uses relationships saved in GENERATIONS."
        self._zoom = 1.0
        self.setMinimumHeight(520)

    def set_zoom(self, zoom: float) -> None:
        self._zoom = max(0.6, min(2.2, float(zoom)))
        self.update()

    def zoom_percent_text(self) -> str:
        return f"{int(round(self._zoom * 100.0))}%"

    def set_tree_data(
        self,
        *,
        rows: list[list[dict[str, object]]],
        edges: list[tuple[str, str]],
        title: str,
        subtitle: str,
    ) -> None:
        self._rows = rows
        self._edges = edges
        self._title = title
        self._subtitle = subtitle
        self.update()

    def paintEvent(self, event) -> None:  # type: ignore[override]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.fillRect(self.rect(), QColor("#0a1221"))

        header_rect = self.rect().adjusted(14, 12, -14, -12)
        painter.setPen(QColor("#e7f0ff"))
        header_font = QFont("Segoe UI", 13, QFont.Weight.Bold)
        painter.setFont(header_font)
        painter.drawText(header_rect.left(), header_rect.top() + 20, self._title)

        painter.setPen(QColor("#9db1d8"))
        painter.setFont(QFont("Segoe UI", 10))
        painter.drawText(header_rect.left(), header_rect.top() + 40, self._subtitle)

        if not self._rows:
            painter.setPen(QColor("#8fa6d2"))
            painter.setFont(QFont("Segoe UI", 11, QFont.Weight.DemiBold))
            painter.drawText(
                self.rect().adjusted(0, 80, 0, 0),
                Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignHCenter,
                "No linked family tree found yet.\nOpen GENERATIONS and link parents/children first.",
            )
            return

        top_y = 76
        content_w = max(1, self.width() - 30)
        content_h = max(1, self.height() - top_y - 20)
        row_count = len(self._rows)
        zoom = max(0.6, min(2.2, self._zoom))
        row_slot = (content_h / max(1, row_count)) * zoom
        max_cards_per_row = max((len(row) for row in self._rows), default=1)
        card_w = min(300.0, max(110.0, ((content_w / max(1, max_cards_per_row)) - 18.0) * zoom))
        card_h = 86.0 * zoom

        node_rects: dict[str, tuple[float, float, float, float]] = {}
        for row_idx, row in enumerate(self._rows):
            if not row:
                continue
            row_y = top_y + row_slot * row_idx + ((row_slot - card_h) / 2.0)
            row_total_w = len(row) * card_w + (len(row) - 1) * (14.0 * zoom)
            start_x = (self.width() - row_total_w) / 2.0
            for col_idx, node in enumerate(row):
                key = str(node.get("id", "")).strip()
                if not key:
                    continue
                x = start_x + col_idx * (card_w + (14.0 * zoom))
                node_rects[key] = (x, row_y, card_w, card_h)

        edge_pen = QPen(QColor("#4c76bd"), 2.0)
        painter.setPen(edge_pen)
        for parent_id, child_id in self._edges:
            parent_rect = node_rects.get(parent_id)
            child_rect = node_rects.get(child_id)
            if parent_rect is None or child_rect is None:
                continue
            px, py, pw, ph = parent_rect
            cx, cy, cw, _ = child_rect
            painter.drawLine(px + pw / 2.0, py + ph, cx + cw / 2.0, cy)

        for row in self._rows:
            for node in row:
                key = str(node.get("id", "")).strip()
                rect_data = node_rects.get(key)
                if rect_data is None:
                    continue
                x, y, w, h = rect_data
                is_focus = bool(node.get("focus", False))
                base_color = QColor(str(node.get("color", "#1b2d47")))
                if not base_color.isValid():
                    base_color = QColor("#1b2d47")
                if is_focus:
                    top_color = base_color.lighter(145)
                    bottom_color = base_color.darker(120)
                else:
                    top_color = base_color.lighter(138)
                    bottom_color = base_color.darker(135)
                grad = QLinearGradient(x, y, x + w, y + h)
                grad.setColorAt(0.0, top_color)
                grad.setColorAt(1.0, bottom_color)
                painter.setPen(QPen(QColor("#8fc1ff") if is_focus else QColor("#496793"), max(1.2, 1.4 * zoom)))
                painter.setBrush(grad)
                painter.drawRoundedRect(x, y, w, h, 12, 12)

                name = str(node.get("name", "Unknown")).strip() or "Unknown"
                subtitle = str(node.get("subtitle", "")).strip()
                flags = Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop
                painter.setPen(QColor("#ffffff"))
                painter.setFont(QFont("Segoe UI", max(8, int(round(10 * zoom))), QFont.Weight.Bold))
                painter.drawText(
                    int(x + (9 * zoom)),
                    int(y + (10 * zoom)),
                    int(w - (18 * zoom)),
                    int(36 * zoom),
                    flags | Qt.TextFlag.TextWordWrap,
                    name,
                )
                painter.setPen(QColor("#d6e3ff"))
                painter.setFont(QFont("Segoe UI", max(7, int(round(8 * zoom)))))
                painter.drawText(
                    int(x + (9 * zoom)),
                    int(y + (46 * zoom)),
                    int(w - (18 * zoom)),
                    int(28 * zoom),
                    Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop | Qt.TextFlag.TextWordWrap,
                    subtitle,
                )


class DirectoryTab(QWidget):
    AGE_OPTIONS = ("BABY", "TODDLER", "CHILD", "TEEN", "YOUNG ADULT", "ADULT")
    DEFAULT_AGE = "ADULT"

    DEFAULT_EMPTY_VALUES = {
        "age": DEFAULT_AGE,
        "temperature": "1.15",
        "reasoning_effort": "xhigh",
        "llm_flair": "roleplay",
        "avatar_preset": "1",
        "additional_context": "",
    }

    DIRECTORY_FIELDS = (
        ("name", "NAME", "line"),
        ...   # rest of tuple
    )

    DIRECTORY_FIELDS = (
        ("name", "NAME", "line"),
        ("gender", "GENDER", "line"),
        ("age", "AGE", "age_combo"),
        ("ai_id", "ID", "line"),
        ("location", "ACTIVITY", "line"),
        ("position", "POSITION", "line"),
        ("rank", "RANK", "rank_line"),
        ("responsibilities", "RESPONSIBILITIES", "text"),
        ("backstory", "BACKSTORY 1", "text"),
        ("ai_memory", "MEMORY", "text"),
        ("greeting", "GREETING", "text"),
        ("directive", "DIRECTIVE", "text"),
        ("additional_context", "ADDITIONAL CONTEXT", "text"),
        ("temperature", "TEMPERATURE", "line"),
        ("reasoning_effort", "REASONING EFFORT", "line"),
        ("llm_flair", "LLM FLAIR", "line"),
        ("avatar_preset", "AVATAR PRESET", "line"),
        ("avatar_description", "AVATAR DESCRIPTION", "text"),
    )
    AUDIO_SAMPLE_EXTENSIONS = {".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac", ".wma"}
    ALBUM_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
    GOOGLE_PHOTOS_ALBUMS_API = "https://photoslibrary.googleapis.com/v1/albums"
    GOOGLE_PHOTOS_SEARCH_API = "https://photoslibrary.googleapis.com/v1/mediaItems:search"
    GOOGLE_PHOTOS_TOKEN_FILENAME = "google_photos_token.json"
    GOOGLE_PHOTOS_SCOPES = [
        "https://www.googleapis.com/auth/photoslibrary.readonly",
        *calendar_tab.GOOGLE_CALENDAR_SCOPES,
    ]
    DIRECTORY_SOURCE_INDEX_ROLE = Qt.ItemDataRole.UserRole
    DIRECTORY_UID_ROLE = Qt.ItemDataRole.UserRole + 1

    def __init__(self, parent: "KindroidMainWindow") -> None:
        super().__init__(parent)
        self._root = parent
        self._current_index: int | None = None
        self._current_uid: str = ""
        self._entry_widgets: dict[str, QWidget] = {}
        self._field_ai_buttons: dict[str, QToolButton] = {}
        self._field_aux_buttons: dict[str, QToolButton] = {}
        self.fetch_rules_list: QListWidget | None = None
        self.fetch_source_combo: QComboBox | None = None
        self.fetch_frequency_combo: QComboBox | None = None
        self.fetch_time_input: QLineEdit | None = None
        self.fetch_now_btn: QPushButton | None = None
        self._fetch_thread: QThread | None = None
        self._fetch_worker: FetchSendWorker | None = None
        self._global_update_thread: QThread | None = None
        self._global_update_worker: DirectoryGlobalUpdateWorker | None = None
        self._pending_fetch_context: dict[str, object] | None = None
        self._kindroid_photo_fetch_view: QWebEngineView | None = None
        self._kindroid_photo_fetch_page: QWebEnginePage | None = None
        self._kindroid_photo_fetch_target: dict[str, object] | None = None
        self._kindroid_photo_fetch_tab_index: int | None = None
        self._kindroid_photo_fetch_poll_attempts = 0
        self._kindroid_photo_downloads: list[str] = []
        self._kindroid_photo_download_session: dict[str, object] | None = None
        self._loading_generations_form = False
        self.generations_embed: generations.GenerationsTab | None = None
        self.character_portrait_label: QLabel | None = None
        self.character_portrait_name: QLabel | None = None
        self.character_banner_label: QLabel | None = None
        self.family_banner_label: QLabel | None = None
        self.family_tags_layout: QHBoxLayout | None = None
        self.gen_dob_input: QLineEdit | None = None
        self.gen_sex_input: QLineEdit | None = None
        self.gen_status_input: QLineEdit | None = None
        self.gen_rank_input: QLineEdit | None = None
        self.gen_notes_input: QTextEdit | None = None
        self.gen_pregnant_check: QCheckBox | None = None
        self.gen_preg_progress_spin: QSpinBox | None = None
        self.gen_partner_input: QLineEdit | None = None
        self.tree_canvas: FamilyTreeCanvas | None = None
        self.communication_video_enabled_check: QCheckBox | None = None
        self.communication_idle_video_input: QLineEdit | None = None
        self.communication_talking_video_input: QLineEdit | None = None
        self.communication_pairs_list: QListWidget | None = None
        self.pregnancy_communication_pairs_list: QListWidget | None = None
        self._active_communication_pairs_kind = "normal"
        self._mindset_window: QDialog | None = None
        self.directory_search_input: QLineEdit | None = None
        self.directory_category_combo: QComboBox | None = None
        self.archive_person_btn: QPushButton | None = None
        self._save_timer = QTimer(self)
        self._save_timer.setSingleShot(True)
        self._save_timer.setInterval(350)
        self._save_timer.timeout.connect(self._flush_scheduled_save)
        self._build_ui()
        self.refresh_entries()
        self._root.profile.downloadRequested.connect(self._on_kindroid_photo_download_requested)

    def _build_ui(self) -> None:
        layout = QHBoxLayout(self)
        layout.setContentsMargins(28, 28, 28, 28)
        layout.setSpacing(20)

        left = QVBoxLayout()
        left.setSpacing(12)
        title = QLabel("DIRECTORY", self)
        title.setStyleSheet("font-size: 20px; font-weight: 800; color: #f6f8ff;")
        subtitle = QLabel("Pick a person to edit their full profile and server status.", self)
        subtitle.setWordWrap(True)
        self.directory_search_input = QLineEdit(self)
        self.directory_search_input.setPlaceholderText("Search people by name...")
        self.directory_search_input.setClearButtonEnabled(True)
        self.directory_search_input.textChanged.connect(self.refresh_entries)
        self.directory_category_combo = QComboBox(self)
        self.directory_category_combo.addItems(["Active", "Archived", "All"])
        self.directory_category_combo.currentIndexChanged.connect(self.refresh_entries)
        self.people_list = QListWidget(self)
        self.people_list.setMinimumWidth(330)
        self.people_list.setItemDelegate(NameOutlineDelegate(self.people_list))
        self.people_list.currentRowChanged.connect(self._on_person_selected)
        add_btn = QPushButton("Add Person", self)
        add_btn.clicked.connect(self._add_person)
        remove_btn = QPushButton("Remove Person", self)
        remove_btn.clicked.connect(self._remove_person)
        self.archive_person_btn = QPushButton("Archive Person", self)
        self.archive_person_btn.clicked.connect(self._toggle_archive_person)
        left.addWidget(title)
        left.addWidget(subtitle)
        left.addWidget(self.directory_search_input)
        left.addWidget(self.directory_category_combo)
        left.addWidget(self.people_list, 1)
        left.addWidget(add_btn)
        left.addWidget(self.archive_person_btn)
        left.addWidget(remove_btn)

        right_container = QWidget(self)
        right = QVBoxLayout(right_container)
        right.setContentsMargins(0, 0, 0, 0)
        right.setSpacing(12)

        sheet_row = QHBoxLayout()
        sheet_row.setSpacing(16)

        portrait_card = QFrame(self)
        portrait_card.setStyleSheet("QFrame { background:#0d1324; border:1px solid #314766; border-radius:14px; }")
        portrait_layout = QVBoxLayout(portrait_card)
        portrait_layout.setContentsMargins(12, 12, 12, 12)
        portrait_layout.setSpacing(10)
        self.character_portrait_name = QLabel("CHARACTER SHEET", portrait_card)
        self.character_portrait_name.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.character_portrait_name.setStyleSheet("font-size:14px; font-weight:800; color:#9bc6ff;")
        portrait_layout.addWidget(self.character_portrait_name)
        self.character_portrait_label = QLabel("No portrait in album", portrait_card)
        self.character_portrait_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.character_portrait_label.setMinimumSize(320, 460)
        self.character_portrait_label.setStyleSheet(
            "background:#11192b; border:1px dashed #45608f; border-radius:12px; color:#93a8cd; font-size:14px; font-weight:700;"
        )
        portrait_layout.addWidget(self.character_portrait_label, 1)
        self.character_banner_label = QLabel("No family banner", portrait_card)
        self.character_banner_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.character_banner_label.setFixedSize(320, 320)
        self.character_banner_label.setStyleSheet(
            "background:#11192b; border:1px dashed #45608f; border-radius:12px; color:#93a8cd; font-size:13px; font-weight:700;"
        )
        portrait_layout.addWidget(self.character_banner_label, 0, Qt.AlignmentFlag.AlignHCenter)
        sheet_row.addWidget(portrait_card, 0, Qt.AlignmentFlag.AlignTop)

        fields_panel = QWidget(self)
        fields_layout = QVBoxLayout(fields_panel)
        fields_layout.setContentsMargins(0, 0, 0, 0)
        fields_layout.setSpacing(12)

        sheets_tabs = QTabWidget(self)
        data_tab = QWidget(self)
        data_layout = QVBoxLayout(data_tab)
        data_layout.setContentsMargins(0, 0, 0, 0)
        data_layout.setSpacing(12)

        self.status_indicator = QLabel("OFFLINE", self)
        self.status_indicator.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.status_indicator.setMinimumHeight(72)
        self.status_indicator.setStyleSheet("font-size: 24px; font-weight: 900; border-radius: 14px;")
        self.toggle_status_btn = QPushButton("Set ONLINE / OFFLINE", self)
        self.toggle_status_btn.clicked.connect(self._toggle_online_status)
        self.upload_audio_btn = QPushButton("Upload Voice Sample", self)
        self.upload_audio_btn.clicked.connect(self._upload_audio_sample)
        self.upload_banner_btn = QPushButton("Upload Family Banner", self)
        self.upload_banner_btn.clicked.connect(self._upload_family_banner)
        self.upload_portrait_btn = QPushButton("Upload Portrait", self)
        self.upload_portrait_btn.clicked.connect(self._upload_directory_portrait)
        self.open_album_btn = QPushButton("ALBUM", self)
        self.open_album_btn.clicked.connect(self._open_album_dialog)
        self.sync_google_btn = QPushButton("SYNC PHOTOS", self)
        self.sync_google_btn.clicked.connect(self._sync_google_photos_from_directory)
        self.fetch_kindroid_btn = QPushButton("FETCH PHOTOS", self)
        self.fetch_kindroid_btn.clicked.connect(self._fetch_kindroid_photos_for_person)
        self.open_ai_btn = QPushButton("AI", self)
        self.open_ai_btn.clicked.connect(self._open_directory_ai_window)
        self.global_execute_btn = QPushButton("GLOBAL EXECUTE", self)
        self.global_execute_btn.clicked.connect(self._global_execute_updates)
        for button, tooltip, icon_kind in (
            (self.toggle_status_btn, "Set ONLINE / OFFLINE", QStyle.StandardPixmap.SP_DialogApplyButton),
            (self.upload_audio_btn, "Upload and preserve this person's voice sample", QStyle.StandardPixmap.SP_MediaVolume),
            (self.upload_banner_btn, "Upload family banner", QStyle.StandardPixmap.SP_FileDialogContentsView),
            (self.upload_portrait_btn, "Upload portrait and set it as this person's directory portrait", QStyle.StandardPixmap.SP_FileIcon),
            (self.open_album_btn, "Open album", QStyle.StandardPixmap.SP_DirIcon),
            (self.sync_google_btn, "Sync albums from Google Photos", QStyle.StandardPixmap.SP_BrowserReload),
            (self.fetch_kindroid_btn, "Fetch photos from Kindroid selfies", QStyle.StandardPixmap.SP_ArrowDown),
            (self.open_ai_btn, "Open DIRECTORY AI assistant", QStyle.StandardPixmap.SP_ComputerIcon),
            (self.global_execute_btn, "Update all kins on server (skip failures)", QStyle.StandardPixmap.SP_BrowserReload),
        ):
            button.setText("")
            button.setIcon(self.style().standardIcon(icon_kind))
            button.setIconSize(QSize(16, 16))
            button.setFixedSize(44, 44)
            button.setToolTip(tooltip)
            button.setAccessibleName(tooltip)
            button.setStyleSheet(
                "QPushButton { border:1px solid #3c547f; border-radius:10px; background:#131d32; color:#d9e7ff; font-weight:800; }"
                "QPushButton:hover { background:#1b2946; border-color:#5b7fc2; }"
            )
        self.audio_sample_label = QLabel("No voice sample preserved", self)
        self.audio_sample_label.setWordWrap(True)
        self.audio_sample_label.setToolTip("Voice samples are copied into the KINDROIDXL data folder so they travel with backups.")
        self.audio_sample_label.setStyleSheet("color:#95a2bf;")
        self.assets_indicator = QLabel("$0", self)
        self.assets_indicator.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.assets_indicator.setMinimumHeight(80)
        self.assets_indicator.setStyleSheet(
            "font-size: 34px; font-weight: 900; border-radius: 14px; background:#0d1f2f; color:#9be0ff; border:1px solid #2f6f94;"
        )
        self.assets_caption = QLabel("ASSETS DISABLED", self)
        self.assets_caption.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.assets_caption.setStyleSheet("font-size:12px; font-weight:800; color:#6fbce8; letter-spacing:0.8px;")
        top_actions = QHBoxLayout()
        top_actions.setSpacing(8)
        top_actions.addWidget(self.toggle_status_btn)
        top_actions.addWidget(self.upload_audio_btn)
        top_actions.addWidget(self.upload_banner_btn)
        top_actions.addWidget(self.upload_portrait_btn)
        top_actions.addWidget(self.open_album_btn)
        top_actions.addWidget(self.sync_google_btn)
        top_actions.addWidget(self.fetch_kindroid_btn)
        top_actions.addWidget(self.open_ai_btn)
        top_actions.addWidget(self.global_execute_btn)
        top_actions.addStretch(1)
        data_layout.addLayout(top_actions)
        data_layout.addWidget(self.status_indicator)
        data_layout.addWidget(self.audio_sample_label)
        data_layout.addWidget(self.assets_indicator)
        data_layout.addWidget(self.assets_caption)

        comm_title = QLabel("COMMUNICATION AVATAR", self)
        comm_title.setStyleSheet("font-size:16px; font-weight:700; color:#9dd9ff;")
        data_layout.addWidget(comm_title)
        self.communication_video_enabled_check = QCheckBox("Native idle/talking video avatar enabled for all", self)
        self.communication_video_enabled_check.setChecked(True)
        self.communication_video_enabled_check.hide()
        comm_form = QFormLayout()
        self.communication_idle_video_input = QLineEdit(self)
        self.communication_idle_video_input.setPlaceholderText("Idle video path")
        self.communication_idle_video_input.textChanged.connect(self._schedule_save_current_person)
        idle_browse_btn = QPushButton("Browse", self)
        idle_browse_btn.clicked.connect(lambda: self._choose_communication_video("idle"))
        idle_row = QHBoxLayout()
        idle_row.addWidget(self.communication_idle_video_input, 1)
        idle_row.addWidget(idle_browse_btn)
        self.communication_talking_video_input = QLineEdit(self)
        self.communication_talking_video_input.setPlaceholderText("Talking video path")
        self.communication_talking_video_input.textChanged.connect(self._schedule_save_current_person)
        talking_browse_btn = QPushButton("Browse", self)
        talking_browse_btn.clicked.connect(lambda: self._choose_communication_video("talking"))
        talking_row = QHBoxLayout()
        talking_row.addWidget(self.communication_talking_video_input, 1)
        talking_row.addWidget(talking_browse_btn)
        comm_form.addRow("Idle video", idle_row)
        comm_form.addRow("Talking video", talking_row)
        # Keep these editor fields off the main DIRECTORY page; the Video Pairs
        # Manager owns the add/update workflow so all pair controls live in one window.
        self.communication_pairs_list = QListWidget(self)
        self.communication_pairs_list.currentRowChanged.connect(self._load_selected_communication_pair)
        self.communication_pairs_list.hide()
        self.pregnancy_communication_pairs_list = QListWidget(self)
        self.pregnancy_communication_pairs_list.currentRowChanged.connect(self._load_selected_pregnancy_communication_pair)
        self.pregnancy_communication_pairs_list.hide()
        data_layout.addWidget(self.communication_pairs_list)
        data_layout.addWidget(self.pregnancy_communication_pairs_list)
        pair_actions = QHBoxLayout()
        manage_pairs_btn = QPushButton("Open Video Pairs Manager…", self)
        manage_pairs_btn.clicked.connect(self._open_video_pairs_manager)
        pair_actions.addWidget(manage_pairs_btn)
        pair_actions.addStretch(1)
        data_layout.addLayout(pair_actions)

        form = QFormLayout()
        form.setSpacing(10)
        for key, label, kind in self.DIRECTORY_FIELDS:
            if kind == "text":
                widget = QTextEdit(self)
                widget.setMinimumHeight(80)
                widget.textChanged.connect(self._schedule_save_current_person)
            elif kind == "age_combo":
                widget = QComboBox(self)
                widget.addItems(self.AGE_OPTIONS)
                widget.currentTextChanged.connect(self._schedule_save_current_person)
            else:
                widget = QLineEdit(self)
                if kind == "rank_line":
                    widget.setReadOnly(True)
                    widget.setPlaceholderText("Auto-filled from GENERATIONS / HOUSES rank")
                widget.textChanged.connect(self._schedule_save_current_person)
                widget.editingFinished.connect(self._flush_scheduled_save)
            widget.installEventFilter(self)
            self._entry_widgets[key] = widget
            row_widget = QWidget(self)
            row_layout = QHBoxLayout(row_widget)
            row_layout.setContentsMargins(0, 0, 0, 0)
            row_layout.setSpacing(6)
            row_layout.addWidget(widget, 1)
            ai_btn = QToolButton(self)
            ai_btn.setText("⚡")
            ai_btn.setToolTip(f"Run AI for {label}")
            ai_btn.setFixedSize(24, 24)
            ai_btn.clicked.connect(lambda _=False, field=key: self._run_ai_for_field(field))
            self._field_ai_buttons[key] = ai_btn
            row_layout.addWidget(ai_btn, 0, Qt.AlignmentFlag.AlignTop)
            if key == "additional_context":
                preset_btn = QToolButton(self)
                preset_btn.setText("📚")
                preset_btn.setToolTip("Open Additional Context presets")
                preset_btn.setFixedSize(24, 24)
                preset_btn.clicked.connect(self._open_additional_context_presets)
                self._field_aux_buttons[key] = preset_btn
                row_layout.addWidget(preset_btn, 0, Qt.AlignmentFlag.AlignTop)
            form.addRow(f"{label} *", row_widget)
        data_layout.addLayout(form, 1)

        fetcher_form = QFormLayout()
        fetcher_title = QLabel("FETCHER SETTINGS", self)
        fetcher_title.setStyleSheet("font-size:16px; font-weight:700; color:#f3b3ff;")
        data_layout.addWidget(fetcher_title)
        self.fetch_rules_list = QListWidget(self)
        self.fetch_rules_list.currentRowChanged.connect(self._on_fetch_rule_selected)
        data_layout.addWidget(self.fetch_rules_list)
        self.fetch_source_combo = QComboBox(self)
        self.fetch_source_combo.currentIndexChanged.connect(self._schedule_save_current_person)
        self.fetch_frequency_combo = QComboBox(self)
        for key, label in feeder.FETCHER_FREQUENCIES:
            self.fetch_frequency_combo.addItem(label, key)
        self.fetch_frequency_combo.currentIndexChanged.connect(self._schedule_save_current_person)
        self.fetch_time_input = QLineEdit(self)
        self.fetch_time_input.setPlaceholderText("HH:MM (used for fixed daily)")
        self.fetch_time_input.textChanged.connect(self._schedule_save_current_person)
        self.fetch_now_btn = QPushButton("Send Fetch Now", self)
        self.fetch_now_btn.clicked.connect(self._send_fetch_now)
        add_rule_btn = QPushButton("Add Rule", self)
        add_rule_btn.clicked.connect(self._add_fetch_rule)
        save_rule_btn = QPushButton("Save Rule", self)
        save_rule_btn.clicked.connect(self._save_selected_fetch_rule)
        remove_rule_btn = QPushButton("Remove Rule", self)
        remove_rule_btn.clicked.connect(self._delete_fetch_rule)
        rule_actions = QHBoxLayout()
        rule_actions.addWidget(add_rule_btn)
        rule_actions.addWidget(save_rule_btn)
        rule_actions.addWidget(remove_rule_btn)
        rule_actions.addStretch(1)
        refresh_sources_btn = QPushButton("Refresh Source List", self)
        refresh_sources_btn.clicked.connect(self._refresh_fetch_source_options)
        fetcher_form.addRow("Source", self.fetch_source_combo)
        fetcher_form.addRow("Frequency", self.fetch_frequency_combo)
        fetcher_form.addRow("Fixed Time", self.fetch_time_input)
        fetcher_form.addRow("", self.fetch_now_btn)
        fetcher_form.addRow("", rule_actions)
        fetcher_form.addRow("", refresh_sources_btn)
        data_layout.addLayout(fetcher_form)
        data_layout.addStretch(1)

        generations_tab = QWidget(self)
        generations_tab_layout = QVBoxLayout(generations_tab)
        generations_tab_layout.setContentsMargins(0, 0, 0, 0)
        generations_tab_layout.setSpacing(8)
        generations_hint = QLabel(
            "Full Generations editor embedded here. Selecting a person in DIRECTORY auto-focuses them below.",
            self,
        )
        generations_hint.setWordWrap(True)
        generations_hint.setStyleSheet("color:#a7b9dd;")
        generations_tab_layout.addWidget(generations_hint)
        self.generations_embed = generations.GenerationsTab(self._root)
        self.generations_embed.set_external_selection_mode(True)
        generations_tab_layout.addWidget(self.generations_embed, 1)

        tree_tab = QWidget(self)
        tree_layout = QVBoxLayout(tree_tab)
        tree_layout.setContentsMargins(0, 0, 0, 0)
        tree_layout.setSpacing(8)
        tree_hint = QLabel(
            "Visual bloodline map based on GENERATIONS parent/child links for the selected DIRECTORY person.",
            self,
        )
        tree_hint.setWordWrap(True)
        tree_hint.setStyleSheet("color:#a7b9dd;")
        tree_layout.addWidget(tree_hint)
        tree_actions = QHBoxLayout()
        refresh_tree_btn = QPushButton("Refresh Tree", self)
        refresh_tree_btn.clicked.connect(self._refresh_tree_for_current_selection)
        tree_actions.addWidget(refresh_tree_btn)
        zoom_out_btn = QPushButton("Zoom -", self)
        zoom_out_btn.clicked.connect(lambda: self._adjust_tree_zoom(-0.1))
        tree_actions.addWidget(zoom_out_btn)
        zoom_reset_btn = QPushButton("100%", self)
        zoom_reset_btn.clicked.connect(lambda: self._set_tree_zoom(1.0))
        tree_actions.addWidget(zoom_reset_btn)
        zoom_in_btn = QPushButton("Zoom +", self)
        zoom_in_btn.clicked.connect(lambda: self._adjust_tree_zoom(0.1))
        tree_actions.addWidget(zoom_in_btn)
        self.tree_zoom_label = QLabel("Zoom 100%", self)
        self.tree_zoom_label.setStyleSheet("color:#93b7ef; font-weight:700;")
        tree_actions.addWidget(self.tree_zoom_label)
        tree_actions.addStretch(1)
        tree_layout.addLayout(tree_actions)
        self.tree_canvas = FamilyTreeCanvas(self)
        tree_layout.addWidget(self.tree_canvas, 1)

        sheets_tabs.addTab(data_tab, "DATA")
        sheets_tabs.addTab(generations_tab, "GENERATIONS")
        sheets_tabs.addTab(tree_tab, "TREE")
        fields_layout.addWidget(sheets_tabs, 1)

        sheet_row.addWidget(fields_panel, 1)
        right.addLayout(sheet_row, 1)

        right_scroll = QScrollArea(self)
        right_scroll.setWidgetResizable(True)
        right_scroll.setFrameStyle(0)
        right_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        right_scroll.setWidget(right_container)

        layout.addLayout(left, 1)
        layout.addWidget(right_scroll, 2)
        self._refresh_fetch_source_options()

    @staticmethod
    def _new_directory_uid() -> str:
        return f"dir_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}_{random.randint(0, 0xFFFFFF):06x}"

    def _ensure_entry_uid(self, entry: dict) -> str:
        uid = str(entry.get("directory_uid", "")).strip()
        if not uid:
            uid = self._new_directory_uid()
            entry["directory_uid"] = uid
        return uid

    def _index_for_directory_uid(self, uid: str) -> int:
        clean_uid = str(uid or "").strip()
        if not clean_uid:
            return -1
        for index, entry in enumerate(self._entry_data()):
            if str(entry.get("directory_uid", "")).strip() == clean_uid:
                return index
        return -1

    def _row_for_directory_uid(self, uid: str) -> int:
        clean_uid = str(uid or "").strip()
        if not clean_uid:
            return -1
        for row in range(self.people_list.count()):
            item = self.people_list.item(row)
            if item is not None and str(item.data(self.DIRECTORY_UID_ROLE) or "").strip() == clean_uid:
                return row
        return -1

    def _entry_data(self) -> list[dict[str, str]]:
        entries = self._root.config.get("directory_entries", [])
        if not isinstance(entries, list):
            return []
        return [entry for entry in entries if isinstance(entry, dict)]

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:  # noqa: N802 (Qt API)
        if watched in self._entry_widgets.values() and event.type() == QEvent.Type.FocusOut:
            self._flush_scheduled_save(force=True)
        return super().eventFilter(watched, event)

    def _directory_search_query(self) -> str:
        if self.directory_search_input is None:
            return ""
        return self.directory_search_input.text().strip().casefold()

    def _directory_category_filter(self) -> str:
        if self.directory_category_combo is None:
            return "active"
        return self.directory_category_combo.currentText().strip().casefold() or "active"

    @staticmethod
    def _is_entry_archived(entry: dict) -> bool:
        return bool(entry.get("archived", False))

    def _sorted_entries_with_source_index(self) -> list[tuple[int, dict[str, str]]]:
        entries = self._entry_data()
        query = self._directory_search_query()
        category = self._directory_category_filter()
        indexed: list[tuple[int, dict[str, str]]] = []
        for idx, entry in enumerate(entries):
            archived = self._is_entry_archived(entry)
            if category == "active" and archived:
                continue
            if category == "archived" and not archived:
                continue
            name = str(entry.get("name", "")).strip().casefold()
            if query and query not in name:
                continue
            indexed.append((idx, entry))
        indexed.sort(key=lambda pair: str(pair[1].get("name", "")).strip().casefold())
        return indexed

    def _row_for_source_index(self, source_index: int) -> int:
        for row in range(self.people_list.count()):
            item = self.people_list.item(row)
            if item is None:
                continue
            if item.data(self.DIRECTORY_SOURCE_INDEX_ROLE) == source_index:
                return row
        return -1

    @staticmethod
    def _normalize_family_name(raw: str) -> str:
        return normalize_family_name(raw)

    @classmethod
    def _family_from_name(cls, full_name: str) -> str:
        return family_from_name(full_name)

    def _house_outline_color_for_entry(self, entry: dict) -> str:
        people = self._generations_people()
        raw_map = self._root.config.get("generations_family_colors", {})
        family_color_map = raw_map if isinstance(raw_map, dict) else {}
        context = build_house_context(people, family_color_map)
        by_person = context.get("by_person", {})
        if not isinstance(by_person, dict):
            return ""
        _idx, generation_person = self._find_generation_person_for_directory(entry)
        if not isinstance(generation_person, dict):
            return ""
        person_id = str(generation_person.get("id", "")).strip()
        payload = by_person.get(person_id, {})
        if not isinstance(payload, dict):
            return ""
        color = str(payload.get("house_color", "")).strip()
        return color if QColor(color).isValid() else ""

    def _family_media_for_name(self, full_name: str) -> tuple[str, list[str]]:
        family = self._family_from_name(full_name)
        if not family:
            return "", []
        raw_map = self._root.config.get("generations_family_media", {})
        if not isinstance(raw_map, dict):
            return "", []
        payload = raw_map.get(family, {})
        if not isinstance(payload, dict):
            return "", []
        banner = str(payload.get("banner", "")).strip()
        tags = [str(item).strip() for item in payload.get("tags", []) if str(item).strip()]
        return banner, tags

    def _clear_family_tags_row(self) -> None:
        if self.family_tags_layout is None:
            return
        while self.family_tags_layout.count():
            item = self.family_tags_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()

    def _render_family_status_media(self, entry: dict) -> None:
        name = str(entry.get("name", "")).strip()
        banner_path, tag_paths = self._family_media_for_name(name)
        banner_pixmap = QPixmap(banner_path)
        if banner_path and not banner_pixmap.isNull():
            if self.family_banner_label is not None:
                scaled = banner_pixmap.scaled(96, 96, Qt.AspectRatioMode.KeepAspectRatioByExpanding, Qt.TransformationMode.SmoothTransformation)
                self.family_banner_label.setPixmap(scaled)
                self.family_banner_label.setText("")
            if self.character_banner_label is not None:
                square = banner_pixmap.scaled(
                    self.character_banner_label.width(),
                    self.character_banner_label.height(),
                    Qt.AspectRatioMode.KeepAspectRatioByExpanding,
                    Qt.TransformationMode.SmoothTransformation,
                )
                self.character_banner_label.setPixmap(square)
                self.character_banner_label.setText("")
        else:
            if self.family_banner_label is not None:
                self.family_banner_label.setPixmap(QPixmap())
                self.family_banner_label.setText("No family banner selected")
            if self.character_banner_label is not None:
                self.character_banner_label.setPixmap(QPixmap())
                self.character_banner_label.setText("No family banner")

        self._clear_family_tags_row()
        if self.family_tags_layout is None:
            return
        shown = 0
        for tag_path in tag_paths:
            pixmap = QPixmap(tag_path)
            if pixmap.isNull():
                continue
            chip = QLabel(self)
            chip.setFixedSize(56, 56)
            chip.setPixmap(
                pixmap.scaled(56, 56, Qt.AspectRatioMode.KeepAspectRatioByExpanding, Qt.TransformationMode.SmoothTransformation)
            )
            chip.setStyleSheet("border:1px solid #4a5f8f; border-radius:8px;")
            self.family_tags_layout.addWidget(chip)
            shown += 1
        if shown == 0:
            empty = QLabel("No tags", self)
            empty.setStyleSheet("color:#94a9d1;")
            self.family_tags_layout.addWidget(empty)
        self.family_tags_layout.addStretch(1)

    def refresh_entries(self) -> None:
        entries = self._entry_data()
        uid_changed = False
        for entry in entries:
            if not str(entry.get("directory_uid", "")).strip():
                self._ensure_entry_uid(entry)
                uid_changed = True
            if self._normalize_directory_basic_fields(entry):
                uid_changed = True
        if uid_changed:
            self._root.config["directory_entries"] = entries
            self._root._save_config(self._root.config)
        sorted_entries = self._sorted_entries_with_source_index()
        current_source_index = self._current_index
        current_uid = self._current_uid
        self.people_list.blockSignals(True)
        self.people_list.clear()
        for source_index, entry in sorted_entries:
            name = str(entry.get("name", "")).strip() or "Unnamed person"
            archived = self._is_entry_archived(entry)
            badge = "📦" if archived else ("🟢" if entry.get("online", False) else "🔴")
            pregnant = self._root.is_entry_pregnant(entry)
            pregnant_label = "  •  pregnant" if pregnant else ""
            archived_label = "  •  archived" if archived else ""
            item = QListWidgetItem(f"{badge} {name}{pregnant_label}{archived_label}")
            item.setData(self.DIRECTORY_SOURCE_INDEX_ROLE, source_index)
            item.setData(self.DIRECTORY_UID_ROLE, self._ensure_entry_uid(entry))
            family_outline = self._house_outline_color_for_entry(entry)
            if archived:
                item.setBackground(QColor("#171b26"))
                item.setForeground(QColor("#9aa6bd"))
            elif pregnant:
                item.setBackground(QColor("#2a0e29"))
                item.setForeground(QColor("#ffd7f6"))
            if family_outline:
                item.setData(NAME_OUTLINE_COLOR_ROLE, family_outline)
            self.people_list.addItem(item)
        self.people_list.blockSignals(False)
        if self.people_list.count() == 0:
            self._current_index = None
            self._current_uid = ""
            self._set_editor_enabled(False)
            self._render_status(False)
            self._load_into_form({})
            if self.archive_person_btn is not None:
                self.archive_person_btn.setText("Archive Person")
            return

        restore_index = 0
        if current_uid:
            matched_row = self._row_for_directory_uid(current_uid)
            if matched_row >= 0:
                restore_index = matched_row
        elif current_source_index is not None:
            matched_row = self._row_for_source_index(current_source_index)
            if matched_row >= 0:
                restore_index = matched_row
        self.people_list.setCurrentRow(restore_index)
        self._on_person_selected(restore_index)

    def select_person_by_ai_id(self, ai_id: str) -> bool:
        clean_ai_id = str(ai_id).strip()
        if not clean_ai_id:
            return False
        for row in range(self.people_list.count()):
            item = self.people_list.item(row)
            if item is None:
                continue
            source_index = item.data(self.DIRECTORY_SOURCE_INDEX_ROLE)
            if not isinstance(source_index, int):
                continue
            entries = self._entry_data()
            if source_index < 0 or source_index >= len(entries):
                continue
            if str(entries[source_index].get("ai_id", "")).strip() == clean_ai_id:
                self.people_list.setCurrentRow(row)
                self._on_person_selected(row)
                return True
        return False

    def _set_editor_enabled(self, enabled: bool) -> None:
        self.toggle_status_btn.setEnabled(enabled)
        self.upload_audio_btn.setEnabled(enabled)
        self.upload_banner_btn.setEnabled(enabled)
        self.upload_portrait_btn.setEnabled(enabled)
        self.open_album_btn.setEnabled(enabled)
        self.sync_google_btn.setEnabled(enabled)
        self.open_ai_btn.setEnabled(enabled)
        self.global_execute_btn.setEnabled(enabled)
        for widget in self._entry_widgets.values():
            widget.setEnabled(enabled)
        for button in self._field_ai_buttons.values():
            button.setEnabled(enabled)
        for button in self._field_aux_buttons.values():
            button.setEnabled(enabled)
        if self.fetch_source_combo is not None:
            self.fetch_source_combo.setEnabled(enabled)
        for widget in (
            self.communication_video_enabled_check,
            self.communication_idle_video_input,
            self.communication_talking_video_input,
            self.communication_pairs_list,
            self.pregnancy_communication_pairs_list,
        ):
            if widget is not None:
                widget.setEnabled(enabled)
        if self.fetch_frequency_combo is not None:
            self.fetch_frequency_combo.setEnabled(enabled)
        if self.fetch_time_input is not None:
            self.fetch_time_input.setEnabled(enabled)
        if self.fetch_rules_list is not None:
            self.fetch_rules_list.setEnabled(enabled)
        if self.fetch_now_btn is not None:
            self.fetch_now_btn.setEnabled(enabled)
        if self.archive_person_btn is not None:
            self.archive_person_btn.setEnabled(enabled)
        if self.generations_embed is not None:
            self.generations_embed.setEnabled(enabled)
    def _render_status(self, online: bool) -> None:
        if online:
            self.status_indicator.setText("ONLINE")
            self.status_indicator.setStyleSheet(
                "font-size: 24px; font-weight: 900; border-radius: 14px; background:#10391a; color:#6bf28f; border:1px solid #2f9c4d;"
            )
        else:
            self.status_indicator.setText("OFFLINE")
            self.status_indicator.setStyleSheet(
                "font-size: 24px; font-weight: 900; border-radius: 14px; background:#3a1117; color:#ff8b98; border:1px solid #a63a4a;"
            )

    def _load_into_form(self, entry: dict) -> None:
        self._render_family_status_media(entry if isinstance(entry, dict) else {})
        self._refresh_character_sheet_portrait(entry if isinstance(entry, dict) else {})
        self._load_generations_subtab(entry if isinstance(entry, dict) else {})
        self._load_tree_subtab(entry if isinstance(entry, dict) else {})
        for key, _, kind in self.DIRECTORY_FIELDS:
            widget = self._entry_widgets[key]
            value = str(entry.get(key, "")).strip()
            if not value and key in self.DEFAULT_EMPTY_VALUES and key != "additional_context":
                value = self.DEFAULT_EMPTY_VALUES[key]
            widget.blockSignals(True)
            if key == "rank":
                value = self._rank_for_directory_entry(entry)
                if isinstance(entry, dict):
                    entry["rank"] = value
            if kind == "age_combo":
                if value not in self.AGE_OPTIONS:
                    value = self.DEFAULT_AGE
                    if isinstance(entry, dict):
                        entry["age"] = value
                assert isinstance(widget, QComboBox)
                index = widget.findText(value)
                widget.setCurrentIndex(index if index >= 0 else widget.findText(self.DEFAULT_AGE))
            elif kind == "text":
                assert isinstance(widget, QTextEdit)
                widget.setPlainText(value)
            else:
                assert isinstance(widget, QLineEdit)
                widget.setText(value)
            widget.blockSignals(False)
        if self.communication_video_enabled_check is not None:
            self.communication_video_enabled_check.blockSignals(True)
            self.communication_video_enabled_check.setChecked(True)
            self.communication_video_enabled_check.blockSignals(False)
        if self.communication_idle_video_input is not None:
            self.communication_idle_video_input.blockSignals(True)
            self.communication_idle_video_input.setText(str(entry.get("communication_idle_video_path", "")).strip())
            self.communication_idle_video_input.blockSignals(False)
        if self.communication_talking_video_input is not None:
            self.communication_talking_video_input.blockSignals(True)
            self.communication_talking_video_input.setText(str(entry.get("communication_talking_video_path", "")).strip())
            self.communication_talking_video_input.blockSignals(False)
        self._load_communication_pairs(entry)
        self._load_fetch_rules(entry)

    def _choose_communication_video(self, kind: str) -> None:
        target = self.communication_idle_video_input if kind == "idle" else self.communication_talking_video_input
        if target is None:
            return
        path, _ = QFileDialog.getOpenFileName(
            self,
            "Choose Communication Video",
            str(Path(target.text()).parent) if target.text().strip() else str(APP_DATA_DIR),
            "Video Files (*.mp4 *.mov *.m4v *.webm *.mkv *.avi);;All Files (*)",
        )
        if path:
            target.setText(self._store_communication_video(path, kind))
            self._flush_scheduled_save(force=True)

    @staticmethod
    def _sanitize_media_folder(name: str) -> str:
        clean = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name).strip())
        return clean[:64] or "person"

    def _store_communication_video(self, source_path: str, kind: str) -> str:
        source = Path(str(source_path).strip())
        if not source.exists() or not source.is_file():
            return str(source_path).strip()
        safe_root = APP_DATA_DIR / "communication_avatar_videos"
        try:
            source.relative_to(safe_root)
            return str(source)
        except ValueError:
            pass
        person_name = "person"
        if self._current_index is not None:
            entries = self._entry_data()
            if 0 <= self._current_index < len(entries):
                person_name = str(entries[self._current_index].get("name", "")).strip() or person_name
        if self._entry_widgets.get("name") is not None:
            name_widget = self._entry_widgets.get("name")
            if isinstance(name_widget, QLineEdit):
                person_name = name_widget.text().strip() or person_name
        person_dir = safe_root / self._sanitize_media_folder(person_name)
        person_dir.mkdir(parents=True, exist_ok=True)
        clean_kind = "talking" if kind == "talking" else "idle"
        ext = source.suffix.lower() or ".mp4"
        target = person_dir / f"{clean_kind}_{int(time.time() * 1000)}_{random.randint(1000, 9999)}{ext}"
        shutil.copy2(source, target)
        return str(target)

    def _communication_pairs_from_entry(self, entry: dict, pregnancy: bool = False) -> list[dict[str, str]]:
        pairs_key = "pregnancy_communication_video_pairs" if pregnancy else "communication_video_pairs"
        raw_pairs = entry.get(pairs_key, [])
        pairs: list[dict[str, str]] = []
        if isinstance(raw_pairs, list):
            for index, pair in enumerate(raw_pairs, start=1):
                if not isinstance(pair, dict):
                    continue
                idle = str(pair.get("idle", pair.get("idle_path", ""))).strip()
                talking = str(pair.get("talking", pair.get("talking_path", ""))).strip()
                if idle and talking:
                    label = str(pair.get("label", "")).strip() or f"Pair {index}"
                    pairs.append({"label": label, "idle": idle, "talking": talking})
        if not pregnancy and "communication_video_pairs" not in entry:
            legacy_idle = str(entry.get("communication_idle_video_path", "")).strip()
            legacy_talking = str(entry.get("communication_talking_video_path", "")).strip()
            if legacy_idle and legacy_talking and not pairs:
                pairs.append({"label": "Default Pair", "idle": legacy_idle, "talking": legacy_talking})
        return pairs

    def _load_communication_pairs(self, entry: dict) -> None:
        if self.communication_pairs_list is None:
            return
        for pairs_list, pregnancy in ((self.communication_pairs_list, False), (self.pregnancy_communication_pairs_list, True)):
            if pairs_list is None:
                continue
            pairs = self._communication_pairs_from_entry(entry, pregnancy=pregnancy)
            pairs_list.blockSignals(True)
            pairs_list.clear()
            for pair in pairs:
                item = QListWidgetItem(str(pair.get("label", "Pair")))
                item.setData(Qt.ItemDataRole.UserRole, pair)
                pairs_list.addItem(item)
            pairs_list.blockSignals(False)
        if self.communication_pairs_list.count() > 0:
            self.communication_pairs_list.setCurrentRow(0)
        elif self.pregnancy_communication_pairs_list is not None and self.pregnancy_communication_pairs_list.count() > 0:
            self.pregnancy_communication_pairs_list.setCurrentRow(0)

    def _load_selected_pregnancy_communication_pair(self, row: int) -> None:
        self._load_selected_communication_pair_from_list(self.pregnancy_communication_pairs_list, row)

    def _load_selected_communication_pair(self, row: int) -> None:
        self._load_selected_communication_pair_from_list(self.communication_pairs_list, row)

    def _load_selected_communication_pair_from_list(self, pairs_list: QListWidget | None, row: int) -> None:
        if pairs_list is self.pregnancy_communication_pairs_list:
            self._active_communication_pairs_kind = "pregnancy"
        elif pairs_list is self.communication_pairs_list:
            self._active_communication_pairs_kind = "normal"
        if pairs_list is None or row < 0:
            return
        item = pairs_list.item(row)
        pair = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
        if not isinstance(pair, dict):
            return
        if self.communication_idle_video_input is not None:
            self.communication_idle_video_input.blockSignals(True)
            self.communication_idle_video_input.setText(str(pair.get("idle", "")).strip())
            self.communication_idle_video_input.blockSignals(False)
        if self.communication_talking_video_input is not None:
            self.communication_talking_video_input.blockSignals(True)
            self.communication_talking_video_input.setText(str(pair.get("talking", "")).strip())
            self.communication_talking_video_input.blockSignals(False)

    def _pair_item_text(self, pair: dict, fallback: str) -> str:
        label = str(pair.get("label", fallback)).strip() or fallback
        idle_name = Path(str(pair.get("idle", ""))).name or "Missing idle"
        talking_name = Path(str(pair.get("talking", ""))).name or "Missing talking"
        return f"{label}\nIdle: {idle_name}\nTalking: {talking_name}"

    def _new_pair_list_item(self, pair: dict, fallback: str, generate_thumbnail: bool = False) -> QListWidgetItem:
        item = QListWidgetItem(self._pair_item_text(pair, fallback))
        item.setData(Qt.ItemDataRole.UserRole, pair)
        if hasattr(self._root, "_communication_pair_thumbnail"):
            item.setIcon(QIcon(self._root._communication_pair_thumbnail(str(pair.get("idle", "")), generate_missing=generate_thumbnail, timeout_seconds=4)))
        item.setToolTip(f"Idle: {pair.get('idle', '')}\nTalking: {pair.get('talking', '')}")
        return item

    def _refresh_pair_list_visuals(self, pairs_list: QListWidget | None) -> None:
        if pairs_list is None:
            return
        pairs_list.setIconSize(QSize(180, 104))
        pairs_list.setSpacing(8)
        for row in range(pairs_list.count()):
            item = pairs_list.item(row)
            pair = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
            if isinstance(pair, dict):
                fallback = f"Pair {row + 1}"
                item.setText(self._pair_item_text(pair, fallback))
                if hasattr(self._root, "_communication_pair_thumbnail"):
                    item.setIcon(QIcon(self._root._communication_pair_thumbnail(str(pair.get("idle", "")), generate_missing=False)))
                item.setToolTip(f"Idle: {pair.get('idle', '')}\nTalking: {pair.get('talking', '')}")

    def _open_video_pairs_manager(self) -> None:
        if self.communication_pairs_list is None or self.pregnancy_communication_pairs_list is None:
            return
        dialog = QDialog(self)
        dialog.setWindowTitle("Video Pairs Manager")
        dialog.resize(980, 720)
        layout = QVBoxLayout(dialog)

        editor_box = QFrame(dialog)
        editor_box.setStyleSheet("QFrame { background:#0d1324; border:1px solid #314766; border-radius:14px; }")
        editor_layout = QVBoxLayout(editor_box)
        editor_layout.setContentsMargins(12, 12, 12, 12)
        editor_layout.setSpacing(8)
        editor_title = QLabel("ADD / UPDATE VIDEO PAIR", dialog)
        editor_title.setStyleSheet("font-size:15px; font-weight:900; color:#9dd9ff;")
        editor_hint = QLabel("Choose the idle and talking videos here, then add or update the selected Normal/Pregnancy pair below.", dialog)
        editor_hint.setWordWrap(True)
        editor_hint.setStyleSheet("color:#93a8cd; font-weight:700;")
        editor_layout.addWidget(editor_title)
        editor_layout.addWidget(editor_hint)

        pair_label_input = QLineEdit(dialog)
        pair_label_input.setPlaceholderText("Optional label (example: Cozy couch, Morning, Outdoors)")
        idle_input = QLineEdit(dialog)
        idle_input.setPlaceholderText("Idle video path")
        talking_input = QLineEdit(dialog)
        talking_input.setPlaceholderText("Talking video path")

        def choose_video(target: QLineEdit, kind: str) -> None:
            path, _ = QFileDialog.getOpenFileName(
                dialog,
                "Choose Communication Video",
                str(Path(target.text()).parent) if target.text().strip() else str(APP_DATA_DIR),
                "Video Files (*.mp4 *.mov *.m4v *.webm *.mkv *.avi);;All Files (*)",
            )
            if path:
                target.setText(self._store_communication_video(path, kind))

        editor_form = QFormLayout()
        editor_form.addRow("Label", pair_label_input)
        idle_row = QHBoxLayout()
        idle_row.addWidget(idle_input, 1)
        idle_browse_btn = QPushButton("Browse", dialog)
        idle_browse_btn.clicked.connect(lambda: choose_video(idle_input, "idle"))
        idle_row.addWidget(idle_browse_btn)
        talking_row = QHBoxLayout()
        talking_row.addWidget(talking_input, 1)
        talking_browse_btn = QPushButton("Browse", dialog)
        talking_browse_btn.clicked.connect(lambda: choose_video(talking_input, "talking"))
        talking_row.addWidget(talking_browse_btn)
        editor_form.addRow("Idle video", idle_row)
        editor_form.addRow("Talking video", talking_row)
        editor_layout.addLayout(editor_form)
        layout.addWidget(editor_box)

        lists_row = QHBoxLayout()

        def build_column(title: str, source: QListWidget) -> tuple[QListWidget, QLabel]:
            column = QVBoxLayout()
            label = QLabel(title, dialog)
            label.setStyleSheet("font-size:15px; font-weight:900; color:#dbeafe;")
            count = QLabel(dialog)
            target = QListWidget(dialog)
            target.setIconSize(QSize(180, 104))
            target.setSpacing(8)
            target.blockSignals(True)
            target.currentRowChanged.connect(lambda row, w=target: load_preview(w, row))
            for row in range(source.count()):
                source_item = source.item(row)
                pair = source_item.data(Qt.ItemDataRole.UserRole) if source_item is not None else None
                if isinstance(pair, dict):
                    target.addItem(self._new_pair_list_item(pair, f"Pair {row + 1}", generate_thumbnail=True))
            target.blockSignals(False)
            count.setText(f"{target.count()} saved pair{'s' if target.count() != 1 else ''}")
            count.setStyleSheet("color:#93a8cd; font-weight:700;")
            column.addWidget(label)
            column.addWidget(count)
            column.addWidget(target, 1)
            lists_row.addLayout(column, 1)
            return target, count

        def load_preview(widget: QListWidget, row: int) -> None:
            if row < 0:
                return
            other = pregnancy_list if widget is normal_list else normal_list
            other.blockSignals(True)
            other.clearSelection()
            other.setCurrentRow(-1)
            other.blockSignals(False)
            self._active_communication_pairs_kind = "pregnancy" if widget is pregnancy_list else "normal"
            item = widget.item(row)
            pair = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
            if not isinstance(pair, dict):
                return
            pair_label_input.setText(str(pair.get("label", f"Pair {row + 1}")).strip())
            idle_input.setText(str(pair.get("idle", "")).strip())
            talking_input.setText(str(pair.get("talking", "")).strip())

        normal_list, normal_count = build_column("Normal video pairs", self.communication_pairs_list)
        pregnancy_list, pregnancy_count = build_column("Pregnancy video pairs", self.pregnancy_communication_pairs_list)
        layout.addLayout(lists_row, 1)

        def update_counts() -> None:
            normal_count.setText(f"{normal_list.count()} saved pair{'s' if normal_list.count() != 1 else ''}")
            pregnancy_count.setText(f"{pregnancy_list.count()} saved pair{'s' if pregnancy_list.count() != 1 else ''}")

        def selected_widget() -> QListWidget | None:
            if normal_list.currentRow() >= 0:
                return normal_list
            if pregnancy_list.currentRow() >= 0:
                return pregnancy_list
            return None

        def selected_or_active_widget() -> QListWidget:
            selected = selected_widget()
            if selected is not None:
                return selected
            return pregnancy_list if self._active_communication_pairs_kind == "pregnancy" else normal_list

        def editor_payload(fallback_label: str) -> dict[str, str] | None:
            idle = idle_input.text().strip()
            talking = talking_input.text().strip()
            if not idle or not talking:
                QMessageBox.warning(dialog, "Missing Videos", "Choose both an idle video and a talking video inside this Video Pairs window first.")
                return None
            idle = self._store_communication_video(idle, "idle")
            talking = self._store_communication_video(talking, "talking")
            idle_input.setText(idle)
            talking_input.setText(talking)
            if hasattr(self._root, "_communication_pair_thumbnail"):
                self._root._communication_pair_thumbnail(idle, timeout_seconds=4)
            label = pair_label_input.text().strip() or fallback_label
            return {"label": label, "idle": idle, "talking": talking}

        def move_pair(to_pregnancy: bool) -> None:
            src = normal_list if to_pregnancy else pregnancy_list
            dst = pregnancy_list if to_pregnancy else normal_list
            row = src.currentRow()
            if row < 0:
                QMessageBox.information(dialog, "No Pair Selected", "Select a pair to move first.")
                return
            item = src.takeItem(row)
            if item is None:
                return
            pair = item.data(Qt.ItemDataRole.UserRole)
            dst.addItem(self._new_pair_list_item(pair, f"Pair {dst.count() + 1}", generate_thumbnail=False))
            dst.setCurrentRow(dst.count() - 1)
            update_counts()

        def duplicate_pair(to_pregnancy: bool) -> None:
            src = normal_list if to_pregnancy else pregnancy_list
            dst = pregnancy_list if to_pregnancy else normal_list
            row = src.currentRow()
            if row < 0:
                QMessageBox.information(dialog, "No Pair Selected", "Select a pair to duplicate first.")
                return
            item = src.item(row)
            pair = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
            if not isinstance(pair, dict):
                return
            duplicated_pair = dict(pair)
            dst.addItem(self._new_pair_list_item(duplicated_pair, f"Pair {dst.count() + 1}", generate_thumbnail=False))
            dst.setCurrentRow(dst.count() - 1)
            update_counts()

        def remove_pair() -> None:
            widget = selected_widget()
            if widget is None:
                QMessageBox.information(dialog, "No Pair Selected", "Select a pair to remove first.")
                return
            widget.takeItem(widget.currentRow())
            update_counts()

        def commit_pairs(close_dialog: bool = True) -> None:
            for source, target in ((normal_list, self.communication_pairs_list), (pregnancy_list, self.pregnancy_communication_pairs_list)):
                target.blockSignals(True)
                target.clear()
                for row in range(source.count()):
                    item = source.item(row)
                    pair = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
                    if isinstance(pair, dict):
                        target.addItem(self._new_pair_list_item(pair, f"Pair {row + 1}", generate_thumbnail=False))
                target.blockSignals(False)
                self._refresh_pair_list_visuals(target)
            self._save_current_person(notify_directory=True, sync_generations=False, refresh_visuals=False)
            if close_dialog:
                dialog.accept()

        def add_editor_pair() -> None:
            target = selected_or_active_widget()
            pair = editor_payload(f"Pair {target.count() + 1}")
            if pair is None:
                return
            target.addItem(self._new_pair_list_item(pair, f"Pair {target.count() + 1}", generate_thumbnail=True))
            target.setCurrentRow(target.count() - 1)
            update_counts()

        def update_selected_pair() -> None:
            widget = selected_widget()
            if widget is None:
                QMessageBox.information(dialog, "No Pair Selected", "Select a pair to update first.")
                return
            row = widget.currentRow()
            pair = editor_payload(f"Pair {row + 1}")
            if pair is None:
                return
            item = widget.item(row)
            if item is None:
                return
            item.setData(Qt.ItemDataRole.UserRole, pair)
            item.setText(self._pair_item_text(pair, f"Pair {row + 1}"))
            if hasattr(self._root, "_communication_pair_thumbnail"):
                item.setIcon(QIcon(self._root._communication_pair_thumbnail(str(pair.get("idle", "")), generate_missing=True, timeout_seconds=4)))
            item.setToolTip(f"Idle: {pair.get('idle', '')}\nTalking: {pair.get('talking', '')}")

        def use_selected_today() -> None:
            widget = selected_widget()
            if widget is None:
                QMessageBox.information(dialog, "No Pair Selected", "Select a pair to use today first.")
                return
            row = widget.currentRow()
            use_pregnancy = widget is pregnancy_list
            commit_pairs(close_dialog=False)
            target = self.pregnancy_communication_pairs_list if use_pregnancy else self.communication_pairs_list
            self._active_communication_pairs_kind = "pregnancy" if use_pregnancy else "normal"
            if target is not None and row >= 0 and row < target.count():
                target.setCurrentRow(row)
            self._use_selected_communication_pair_today()

        actions = QHBoxLayout()
        add_btn = QPushButton("Add pair from fields", dialog)
        add_btn.clicked.connect(add_editor_pair)
        update_btn = QPushButton("Update selected from fields", dialog)
        update_btn.clicked.connect(update_selected_pair)
        move_to_preg_btn = QPushButton("Move → Pregnancy", dialog)
        move_to_preg_btn.clicked.connect(lambda: move_pair(True))
        move_to_normal_btn = QPushButton("Move → Normal", dialog)
        move_to_normal_btn.clicked.connect(lambda: move_pair(False))
        duplicate_to_preg_btn = QPushButton("Duplicate → Pregnancy", dialog)
        duplicate_to_preg_btn.clicked.connect(lambda: duplicate_pair(True))
        duplicate_to_normal_btn = QPushButton("Duplicate → Normal", dialog)
        duplicate_to_normal_btn.clicked.connect(lambda: duplicate_pair(False))
        remove_btn = QPushButton("Remove selected", dialog)
        remove_btn.clicked.connect(remove_pair)
        use_today_btn = QPushButton("Use selected today", dialog)
        use_today_btn.clicked.connect(use_selected_today)
        save_btn = QPushButton("Save & Close", dialog)
        save_btn.clicked.connect(lambda: commit_pairs(close_dialog=True))
        close_btn = QPushButton("Cancel", dialog)
        close_btn.clicked.connect(dialog.reject)
        for button in (
            add_btn,
            update_btn,
            move_to_preg_btn,
            move_to_normal_btn,
            duplicate_to_preg_btn,
            duplicate_to_normal_btn,
            remove_btn,
            use_today_btn,
        ):
            actions.addWidget(button)
        actions.addStretch(1)
        actions.addWidget(save_btn)
        actions.addWidget(close_btn)
        layout.addLayout(actions)
        dialog.exec()

    def _current_communication_pair_payload(self) -> dict[str, str] | None:
        idle = self.communication_idle_video_input.text().strip() if self.communication_idle_video_input is not None else ""
        talking = self.communication_talking_video_input.text().strip() if self.communication_talking_video_input is not None else ""
        if not idle or not talking:
            QMessageBox.warning(self, "Missing Videos", "Choose both an idle video and a talking video before saving the pair.")
            return None
        idle = self._store_communication_video(idle, "idle")
        talking = self._store_communication_video(talking, "talking")
        if self.communication_idle_video_input is not None:
            self.communication_idle_video_input.setText(idle)
        if self.communication_talking_video_input is not None:
            self.communication_talking_video_input.setText(talking)
        if hasattr(self._root, "_communication_pair_thumbnail"):
            self._root._communication_pair_thumbnail(idle, timeout_seconds=4)
        return {"idle": idle, "talking": talking}

    def _active_communication_pairs_list(self) -> QListWidget | None:
        if self._active_communication_pairs_kind == "pregnancy" and self.pregnancy_communication_pairs_list is not None:
            return self.pregnancy_communication_pairs_list
        return self.communication_pairs_list

    def _add_communication_pair(self) -> None:
        pairs_list = self._active_communication_pairs_list()
        if pairs_list is None:
            return
        payload = self._current_communication_pair_payload()
        if payload is None:
            return
        label = f"Pair {pairs_list.count() + 1}"
        pair = {"label": label, **payload}
        item = QListWidgetItem(label)
        item.setData(Qt.ItemDataRole.UserRole, pair)
        pairs_list.addItem(item)
        pairs_list.setCurrentItem(item)
        self._schedule_save_current_person()

    def _update_selected_communication_pair(self) -> None:
        pairs_list = self._active_communication_pairs_list()
        if pairs_list is None:
            return
        row = pairs_list.currentRow()
        if row < 0:
            QMessageBox.warning(self, "No Pair Selected", "Select a saved pair to update, or use Add New Pair to create another pair.")
            return
        payload = self._current_communication_pair_payload()
        if payload is None:
            return
        item = pairs_list.item(row)
        if item is None:
            return
        label = item.text() or f"Pair {row + 1}"
        item.setData(Qt.ItemDataRole.UserRole, {"label": label, **payload})
        item.setText(label)
        self._schedule_save_current_person()

    def _remove_communication_pair(self) -> None:
        pairs_list = self._active_communication_pairs_list()
        if pairs_list is None:
            return
        row = pairs_list.currentRow()
        if row >= 0:
            pairs_list.takeItem(row)
            if pairs_list.count() == 0:
                if self.communication_idle_video_input is not None:
                    self.communication_idle_video_input.clear()
                if self.communication_talking_video_input is not None:
                    self.communication_talking_video_input.clear()
            self._save_current_person(notify_directory=True, sync_generations=False, refresh_visuals=False)
            if hasattr(self._root, "_refresh_communication_avatar_for_url"):
                self._root._refresh_communication_avatar_for_url()

    def _use_selected_communication_pair_today(self) -> None:
        pairs_list = self._active_communication_pairs_list()
        if pairs_list is None:
            return
        row = pairs_list.currentRow()
        if row < 0:
            QMessageBox.warning(self, "No Pair Selected", "Select a saved communication video pair first.")
            return
        item = pairs_list.item(row)
        pair = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
        if not isinstance(pair, dict):
            QMessageBox.warning(self, "Invalid Pair", "The selected communication pair could not be read.")
            return
        idle = str(pair.get("idle", "")).strip()
        talking = str(pair.get("talking", "")).strip()
        if not idle or not talking:
            QMessageBox.warning(self, "Missing Videos", "The selected pair needs both idle and talking videos.")
            return
        if self._current_index is None:
            QMessageBox.warning(self, "No Directory Person", "Select a directory person before choosing today's pair.")
            return
        entries = self._entry_data()
        if self._current_index < 0 or self._current_index >= len(entries):
            return
        original_person = entries[self._current_index]
        original_identity = str(
            original_person.get("ai_id", "") or original_person.get("kindroid_id", "") or original_person.get("name", "")
        ).strip()
        pair_payload = {"index": row, "label": str(pair.get("label", item.text() if item is not None else f"Pair {row + 1}")), "idle": idle, "talking": talking}
        if self.communication_idle_video_input is not None:
            self.communication_idle_video_input.setText(idle)
        if self.communication_talking_video_input is not None:
            self.communication_talking_video_input.setText(talking)
        self._save_current_person(notify_directory=True, sync_generations=False, refresh_visuals=False)
        entries = self._entry_data()
        if self._current_index < 0 or self._current_index >= len(entries):
            return
        person = entries[self._current_index]
        identity = str(person.get("ai_id", "") or person.get("kindroid_id", "") or person.get("name", "")).strip()
        if not identity:
            QMessageBox.warning(self, "Missing Identity", "Add a name or AI ID before choosing today's pair.")
            return
        selected_pairs_key = "pregnancy_communication_video_pairs" if pairs_list is self.pregnancy_communication_pairs_list else "communication_video_pairs"
        pair_payload["pairs_key"] = selected_pairs_key
        person_today_lock = {
            "day": int(time.time() // 86400),
            "pairs_key": selected_pairs_key,
            "index": row,
            "idle": idle,
            "talking": talking,
            "label": pair_payload.get("label", ""),
            "selected_at": int(time.time()),
        }
        person["communication_today_pair_lock"] = person_today_lock
        entries[self._current_index] = person
        self._root.config["directory_entries"] = entries
        self._root._save_config(self._root.config)
        lock_keys = []
        if hasattr(self._root, "_communication_pair_lock_key"):
            lock_keys.append(self._root._communication_pair_lock_key(person))
        else:
            lock_keys.append(f"person::{identity}")
        if original_identity and original_identity != identity:
            lock_keys.append(f"person::{original_identity}")
        webview = getattr(self._root, "webview", None)
        current_url = webview.url() if webview is not None and hasattr(webview, "url") else None
        if current_url is not None and getattr(self._root, "_is_kindroid_group_url", lambda _url: False)(current_url):
            page_scope = current_url.toString().split("?", 1)[0]
            lock_keys.append(f"{page_scope}::{identity}")
            lock_keys.append(f"group::{page_scope}::{identity}")
            if original_identity and original_identity != identity:
                lock_keys.append(f"{page_scope}::{original_identity}")
                lock_keys.append(f"group::{page_scope}::{original_identity}")
        for lock_key in dict.fromkeys(lock_keys):
            self._root._set_communication_pair_lock_for_key(lock_key, pair_payload)
        if current_url is not None and getattr(self._root, "_is_kindroid_group_url", lambda _url: False)(current_url):
            setattr(self._root, "_group_avatar_people_signature", "")
            if hasattr(self._root, "_ensure_group_avatar_people"):
                self._root._ensure_group_avatar_people(force=True)
        elif hasattr(self._root, "_refresh_communication_avatar_for_url"):
            self._root._refresh_communication_avatar_for_url()
        QMessageBox.information(self, "Broadcast Pair Set", "The selected pair is now locked as today's communication avatar video pair.")

    def _generations_people(self) -> list[dict]:
        raw_people = self._root.config.get("generations_people", [])
        if not isinstance(raw_people, list):
            return []
        return [item for item in raw_people if isinstance(item, dict)]

    def _find_generation_person_for_directory(self, directory_entry: dict) -> tuple[int | None, dict | None]:
        people = self._generations_people()
        ai_id = str(directory_entry.get("ai_id", "")).strip()
        name = str(directory_entry.get("name", "")).strip().casefold()
        if ai_id:
            for idx, person in enumerate(people):
                if str(person.get("directory_ai_id", "")).strip() == ai_id:
                    return idx, person
        if name:
            for idx, person in enumerate(people):
                if str(person.get("name", "")).strip().casefold() == name:
                    return idx, person
        return None, None

    def _rank_for_directory_entry(self, directory_entry: dict) -> str:
        """Return the current house/generations rank for a DIRECTORY entry."""
        _idx, person = self._find_generation_person_for_directory(directory_entry)
        if isinstance(person, dict):
            return str(person.get("rank", "")).strip()
        return str(directory_entry.get("rank", "")).strip()

    def _normalize_directory_basic_fields(self, entry: dict) -> bool:
        changed = False
        age = str(entry.get("age", "")).strip()
        if age not in self.AGE_OPTIONS:
            entry["age"] = self.DEFAULT_AGE
            changed = True
        rank = self._rank_for_directory_entry(entry)
        if str(entry.get("rank", "")).strip() != rank:
            entry["rank"] = rank
            changed = True
        if "responsibilities" not in entry:
            entry["responsibilities"] = ""
            changed = True
        return changed

    def _load_generations_subtab(self, directory_entry: dict) -> None:
        if self.generations_embed is None:
            return
        ai_id = str(directory_entry.get("ai_id", "")).strip()
        name = str(directory_entry.get("name", "")).strip()
        self.generations_embed.select_person_by_directory_entry(ai_id, name)

    def _refresh_tree_for_current_selection(self) -> None:
        entries = self._entry_data()
        if self._current_index is None or self._current_index < 0 or self._current_index >= len(entries):
            self._load_tree_subtab({})
            return
        self._load_tree_subtab(entries[self._current_index])

    def _set_tree_zoom(self, zoom: float) -> None:
        if self.tree_canvas is None:
            return
        self.tree_canvas.set_zoom(zoom)
        if hasattr(self, "tree_zoom_label") and self.tree_zoom_label is not None:
            self.tree_zoom_label.setText(f"Zoom {self.tree_canvas.zoom_percent_text()}")

    def _adjust_tree_zoom(self, delta: float) -> None:
        if self.tree_canvas is None:
            return
        self._set_tree_zoom(getattr(self.tree_canvas, "_zoom", 1.0) + delta)

    def _load_tree_subtab(self, directory_entry: dict) -> None:
        if self.tree_canvas is None:
            return
        people = self._generations_people()
        raw_map = self._root.config.get("generations_family_colors", {})
        family_color_map = raw_map if isinstance(raw_map, dict) else {}
        house_ctx = build_house_context(people, family_color_map)
        houses_by_person = house_ctx.get("by_person", {}) if isinstance(house_ctx, dict) else {}
        by_id = {
            str(person.get("id", "")).strip(): person
            for person in people
            if isinstance(person, dict) and str(person.get("id", "")).strip()
        }
        ai_id = str(directory_entry.get("ai_id", "")).strip()
        name = str(directory_entry.get("name", "")).strip().casefold()
        focus: dict | None = None
        if ai_id:
            for person in people:
                if str(person.get("directory_ai_id", "")).strip() == ai_id:
                    focus = person
                    break
        if focus is None and name:
            for person in people:
                if str(person.get("name", "")).strip().casefold() == name:
                    focus = person
                    break
        if focus is None:
            self.tree_canvas.set_tree_data(
                rows=[],
                edges=[],
                title="No GENERATIONS profile linked",
                subtitle="Pick a person with linked GENERATIONS data, or sync/add them in GENERATIONS first.",
            )
            return

        focus_id = str(focus.get("id", "")).strip()
        parents = [pid for pid in focus.get("parents", []) if pid in by_id]
        children = [cid for cid in focus.get("children", []) if cid in by_id]
        grand_parents: list[str] = []
        for pid in parents:
            for gpid in by_id.get(pid, {}).get("parents", []):
                if gpid in by_id and gpid not in grand_parents:
                    grand_parents.append(gpid)
        grand_children: list[str] = []
        for cid in children:
            for gcid in by_id.get(cid, {}).get("children", []):
                if gcid in by_id and gcid not in grand_children:
                    grand_children.append(gcid)

        row_ids = [grand_parents, parents, [focus_id], children, grand_children]
        rows: list[list[dict[str, object]]] = []
        included_ids: set[str] = set()
        for ids in row_ids:
            row_nodes: list[dict[str, object]] = []
            for person_id in ids:
                person = by_id.get(person_id)
                if not person:
                    continue
                included_ids.add(person_id)
                person_name = str(person.get("name", "")).strip() or "Unnamed"
                meta_tokens = []
                sex = str(person.get("sex", "")).strip()
                rank = str(person.get("rank", "")).strip()
                if sex:
                    meta_tokens.append(sex)
                if rank:
                    meta_tokens.append(rank)
                row_nodes.append(
                    {
                        "id": person_id,
                        "name": person_name,
                        "subtitle": " • ".join(meta_tokens) if meta_tokens else "Bloodline member",
                        "focus": person_id == focus_id,
                        "color": str(houses_by_person.get(person_id, {}).get("house_color", "")).strip() or "#1f3559",
                    }
                )
            if row_nodes:
                rows.append(row_nodes)

        edges: list[tuple[str, str]] = []
        for person_id in included_ids:
            person = by_id.get(person_id, {})
            for child_id in person.get("children", []):
                if child_id in included_ids:
                    edges.append((person_id, child_id))

        title = f"Bloodline Tree • {str(focus.get('name', '')).strip() or 'Selected Person'}"
        focus_house = houses_by_person.get(focus_id, {}) if isinstance(houses_by_person, dict) else {}
        focus_house_name = str(focus_house.get("house_name", "")).strip()
        focus_house_color = str(focus_house.get("house_color", "")).strip()
        subtitle = (
            f"{len(parents)} parent(s) • {len(children)} child(ren) • "
            f"{len(grand_parents)} grandparent(s) • {len(grand_children)} grandchild(ren)"
        )
        if focus_house_name:
            subtitle += f" • House {focus_house_name}"
            if focus_house_color:
                subtitle += f" ({focus_house_color})"
        self.tree_canvas.set_tree_data(rows=rows, edges=edges, title=title, subtitle=subtitle)

    def _save_generations_subtab(self) -> None:
        if self._loading_generations_form or self._current_index is None:
            return
        entries = self._entry_data()
        if self._current_index >= len(entries):
            return
        if any(
            widget is None
            for widget in (
                self.gen_dob_input,
                self.gen_sex_input,
                self.gen_status_input,
                self.gen_rank_input,
                self.gen_notes_input,
                self.gen_pregnant_check,
                self.gen_preg_progress_spin,
                self.gen_partner_input,
            )
        ):
            return
        self._sync_generations_for_directory_entry(entries[self._current_index], prefer_form_values=True)

    def _sync_generations_for_directory_entry(self, directory_entry: dict, prefer_form_values: bool = False) -> None:
        people = self._generations_people()
        idx, existing = self._find_generation_person_for_directory(directory_entry)
        target = dict(existing) if isinstance(existing, dict) else {}
        if not target:
            target = {
                "id": f"g_{int(time.time() * 1000):x}",
                "parents": [],
                "children": [],
                "album_photos": [],
            }
        ai_id = str(directory_entry.get("ai_id", "")).strip()
        target["directory_ai_id"] = ai_id
        target["name"] = str(directory_entry.get("name", "")).strip()
        album_paths = self._album_paths_for_entry(directory_entry)
        target["album_photos"] = album_paths
        portrait_path = self._latest_portrait_path_for_entry(directory_entry)
        target["dominant_portrait"] = portrait_path or str(directory_entry.get("photo", "")).strip()
        if prefer_form_values:
            target["dob"] = self.gen_dob_input.text().strip() if self.gen_dob_input is not None else str(target.get("dob", "")).strip()
            target["sex"] = self.gen_sex_input.text().strip() if self.gen_sex_input is not None else str(target.get("sex", "")).strip()
            target["status"] = (
                self.gen_status_input.text().strip() if self.gen_status_input is not None else str(target.get("status", "")).strip()
            )
            target["rank"] = self.gen_rank_input.text().strip() if self.gen_rank_input is not None else str(target.get("rank", "")).strip()
            target["notes"] = (
                self.gen_notes_input.toPlainText().strip() if self.gen_notes_input is not None else str(target.get("notes", "")).strip()
            )
            active = self.gen_pregnant_check.isChecked() if self.gen_pregnant_check is not None else False
            progress = self.gen_preg_progress_spin.value() if self.gen_preg_progress_spin is not None else 0
            partner = self.gen_partner_input.text().strip() if self.gen_partner_input is not None else ""
            target["pregnancy"] = {"active": active, "partner_id": partner, "progress": progress} if active else None
            directory_entry["pregnancy"] = target["pregnancy"]
        else:
            target.setdefault("dob", "")
            target.setdefault("sex", "")
            target.setdefault("status", "")
            target.setdefault("rank", "")
            target.setdefault("notes", "")
            target.setdefault("pregnancy", None)

        if idx is None:
            people.append(target)
        else:
            people[idx] = target
        self._root.config["generations_people"] = people
        self._root._save_config(self._root.config)

    def _read_from_form(self) -> dict[str, str]:
        payload: dict[str, str] = {}
        for key, _, kind in self.DIRECTORY_FIELDS:
            widget = self._entry_widgets[key]
            if kind == "age_combo":
                assert isinstance(widget, QComboBox)
                age = widget.currentText().strip()
                payload[key] = age if age in self.AGE_OPTIONS else self.DEFAULT_AGE
            elif kind == "text":
                assert isinstance(widget, QTextEdit)
                payload[key] = widget.toPlainText().strip()
            else:
                assert isinstance(widget, QLineEdit)
                payload[key] = widget.text().strip()
        ai_id = str(payload.get("ai_id", "")).strip()
        if ai_id.endswith("\\"):
            ai_id = ai_id.rstrip("\\").strip()
        payload["ai_id"] = ai_id
        self._sync_selected_fetch_rule_from_editors()
        rules = self._fetch_rules_from_ui()
        payload["fetch_rules"] = rules
        first_rule = rules[0] if rules else {}
        payload["fetch_source_id"] = str(first_rule.get("source_id", "")).strip()
        payload["fetch_frequency"] = str(first_rule.get("frequency", "none")).strip() or "none"
        payload["fetch_time"] = str(first_rule.get("time", "09:00")).strip() or "09:00"
        payload["fetch_last_sent_date"] = str(first_rule.get("last_sent_date", "")).strip()
        payload["communication_video_enabled"] = True
        payload["communication_idle_video_path"] = (
            self.communication_idle_video_input.text().strip() if self.communication_idle_video_input is not None else ""
        )
        payload["communication_talking_video_path"] = (
            self.communication_talking_video_input.text().strip() if self.communication_talking_video_input is not None else ""
        )
        for pairs_list, key in (
            (self.communication_pairs_list, "communication_video_pairs"),
            (self.pregnancy_communication_pairs_list, "pregnancy_communication_video_pairs"),
        ):
            if pairs_list is None:
                continue
            pairs: list[dict[str, str]] = []
            for row in range(pairs_list.count()):
                item = pairs_list.item(row)
                pair = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
                if isinstance(pair, dict):
                    idle = str(pair.get("idle", "")).strip()
                    talking = str(pair.get("talking", "")).strip()
                    if idle and talking:
                        pairs.append({"label": str(pair.get("label", f"Pair {row + 1}")).strip(), "idle": idle, "talking": talking})
            payload[key] = pairs
        for key, value in COMMUNICATION_AVATAR_DEFAULTS.items():
            payload.setdefault(key, value)
        return payload

    def _refresh_fetch_source_options(self) -> None:
        if self.fetch_source_combo is None:
            return
        selected = self.fetch_source_combo.currentData()
        self.fetch_source_combo.blockSignals(True)
        self.fetch_source_combo.clear()
        self.fetch_source_combo.addItem("None", "")
        for source in self._root.get_fetcher_sources():
            url = str(source.get("url", "")).strip()
            description = str(source.get("description", "")).strip()
            source_id = str(source.get("id", "")).strip()
            if not source_id or not url:
                continue
            label = f"{url} — {description[:50]}"
            self.fetch_source_combo.addItem(label, source_id)
        idx = self.fetch_source_combo.findData(selected)
        self.fetch_source_combo.setCurrentIndex(idx if idx >= 0 else 0)
        self.fetch_source_combo.blockSignals(False)
        self._render_fetch_rule_labels()

    def _on_person_selected(self, row: int) -> None:
        previous_index = self._current_index
        selected_item = self.people_list.item(row) if row >= 0 else None
        selected_uid = str(selected_item.data(self.DIRECTORY_UID_ROLE) or "").strip() if selected_item is not None else ""
        selected_source_index = self._index_for_directory_uid(selected_uid) if selected_uid else (selected_item.data(self.DIRECTORY_SOURCE_INDEX_ROLE) if selected_item is not None else None)
        should_flush = (
            self._save_timer.isActive()
            and previous_index is not None
            and isinstance(selected_source_index, int)
            and previous_index != selected_source_index
        )
        if should_flush:
            self._flush_scheduled_save(force=True)
        entries = self._entry_data()
        if row < 0 or not isinstance(selected_source_index, int) or selected_source_index < 0 or selected_source_index >= len(entries):
            self._current_index = None
            self._current_uid = ""
            self._set_editor_enabled(False)
            self._render_status(False)
            self._load_into_form({})
            self._refresh_assets_indicator(None)
            self.audio_sample_label.setText("No voice sample preserved")
            return
        self._current_index = selected_source_index
        self._current_uid = self._ensure_entry_uid(entries[selected_source_index])
        self._set_editor_enabled(True)
        entry = entries[selected_source_index]
        if self.archive_person_btn is not None:
            self.archive_person_btn.setText("Restore Person" if self._is_entry_archived(entry) else "Archive Person")
        self._load_into_form(entry)
        self._render_status(bool(entry.get("online", False)))
        self._refresh_assets_indicator(entry)
        self.audio_sample_label.setText(self._voice_sample_status_text(entry))

    def _open_directory_ai_window(self) -> None:
        person = self._read_from_form() if self._current_index is not None else {}
        if self._mindset_window is not None and self._mindset_window.isVisible():
            if isinstance(self._mindset_window, DirectoryMindsetDialog):
                self._mindset_window.update_person_snapshot(person)
            self._mindset_window.raise_()
            self._mindset_window.activateWindow()
            return
        self._mindset_window = DirectoryMindsetDialog(self._root, person, self)
        self._mindset_window.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)
        self._mindset_window.destroyed.connect(lambda _=None: setattr(self, "_mindset_window", None))
        self._mindset_window.show()
        self._mindset_window.raise_()
        self._mindset_window.activateWindow()

    def _run_ai_for_field(self, field_name: str) -> None:
        if self._current_index is None:
            QMessageBox.warning(self, "Select Person", "Pick a person first.")
            return
        if field_name not in {name for name, _, _ in self.DIRECTORY_FIELDS}:
            QMessageBox.warning(self, "Unknown Field", f"Field '{field_name}' is not valid.")
            return
        if self._save_timer.isActive():
            self._flush_scheduled_save(force=True)
        person = self._read_from_form()
        if self._mindset_window is not None and self._mindset_window.isVisible():
            dialog = self._mindset_window if isinstance(self._mindset_window, DirectoryMindsetDialog) else None
            if dialog is not None:
                dialog.update_person_snapshot(person)
                selected = dialog.select_field(field_name)
                if not selected:
                    QMessageBox.warning(self, "AI Field", f"Unable to run AI for '{field_name}'.")
                    return
                dialog.raise_()
                dialog.activateWindow()
                return
        dialog = DirectoryMindsetDialog(self._root, person, self)
        dialog.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)
        dialog.destroyed.connect(lambda _=None: setattr(self, "_mindset_window", None))
        self._mindset_window = dialog
        dialog.show()
        dialog.raise_()
        dialog.activateWindow()
        if not dialog.select_field(field_name):
            QMessageBox.warning(self, "AI Field", f"Unable to run AI for '{field_name}'.")

    def _open_additional_context_presets(self) -> None:
        widget = self._entry_widgets.get("additional_context")
        if not isinstance(widget, QTextEdit):
            return
        current_text = widget.toPlainText().strip()
        raw = self._root.config.get("directory_additional_context_presets", [])
        presets = raw if isinstance(raw, list) else []
        dialog = AdditionalContextPresetsDialog(presets, current_text, self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            selected = dialog.selected_text()
            if selected:
                widget.setPlainText(selected)
                self._schedule_save_current_person()
        self._root.config["directory_additional_context_presets"] = dialog.presets()
        self._root._save_config(self._root.config)

    @staticmethod
    def _asset_value(entry: dict) -> int:
        # Legacy per-person asset scoring is disabled.
        return 0

    def _refresh_assets_indicator(self, entry: dict | None) -> None:
        _ = entry
        self.assets_indicator.setText("DISABLED")

    def _normalize_fetch_rules(self, entry: dict) -> list[dict[str, str]]:
        raw = entry.get("fetch_rules", [])
        clean: list[dict[str, str]] = []
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                source_id = str(item.get("source_id", "")).strip()
                frequency = str(item.get("frequency", "none")).strip() or "none"
                if not source_id or frequency == "none":
                    continue
                clean.append(
                    {
                        "source_id": source_id,
                        "frequency": frequency,
                        "time": str(item.get("time", "09:00")).strip() or "09:00",
                        "last_sent_date": str(item.get("last_sent_date", "")).strip(),
                    }
                )
        if clean:
            return clean
        legacy_source_id = str(entry.get("fetch_source_id", "")).strip()
        legacy_frequency = str(entry.get("fetch_frequency", "none")).strip() or "none"
        if legacy_source_id and legacy_frequency != "none":
            return [
                {
                    "source_id": legacy_source_id,
                    "frequency": legacy_frequency,
                    "time": str(entry.get("fetch_time", "09:00")).strip() or "09:00",
                    "last_sent_date": str(entry.get("fetch_last_sent_date", "")).strip(),
                }
            ]
        return []

    def _format_fetch_rule_label(self, rule: dict[str, str]) -> str:
        source_id = str(rule.get("source_id", "")).strip()
        frequency = str(rule.get("frequency", "none")).strip() or "none"
        time_value = str(rule.get("time", "09:00")).strip() or "09:00"
        source_label = "Unknown source"
        for source in self._root.get_fetcher_sources():
            if str(source.get("id", "")).strip() == source_id:
                source_label = str(source.get("url", "")).strip() or source_label
                break
        return f"{frequency} @ {time_value} -> {source_label}"

    def _load_fetch_rules(self, entry: dict) -> None:
        if self.fetch_rules_list is None:
            return
        rules = self._normalize_fetch_rules(entry)
        self.fetch_rules_list.blockSignals(True)
        self.fetch_rules_list.clear()
        for rule in rules:
            item = QListWidgetItem(self._format_fetch_rule_label(rule))
            item.setData(Qt.ItemDataRole.UserRole, rule)
            self.fetch_rules_list.addItem(item)
        self.fetch_rules_list.blockSignals(False)
        if self.fetch_rules_list.count() > 0:
            self.fetch_rules_list.setCurrentRow(0)
        else:
            self._set_fetch_rule_editors({})

    def _set_fetch_rule_editors(self, rule: dict[str, str]) -> None:
        if self.fetch_source_combo is not None:
            source_id = str(rule.get("source_id", "")).strip()
            idx = self.fetch_source_combo.findData(source_id)
            self.fetch_source_combo.blockSignals(True)
            self.fetch_source_combo.setCurrentIndex(idx if idx >= 0 else 0)
            self.fetch_source_combo.blockSignals(False)
        if self.fetch_frequency_combo is not None:
            frequency = str(rule.get("frequency", "none")).strip() or "none"
            idx = self.fetch_frequency_combo.findData(frequency)
            self.fetch_frequency_combo.blockSignals(True)
            self.fetch_frequency_combo.setCurrentIndex(idx if idx >= 0 else 0)
            self.fetch_frequency_combo.blockSignals(False)
        if self.fetch_time_input is not None:
            self.fetch_time_input.blockSignals(True)
            self.fetch_time_input.setText(str(rule.get("time", "09:00")).strip() or "09:00")
            self.fetch_time_input.blockSignals(False)

    def _on_fetch_rule_selected(self, row: int) -> None:
        if self.fetch_rules_list is None or row < 0:
            self._set_fetch_rule_editors({})
            return
        item = self.fetch_rules_list.item(row)
        if item is None:
            self._set_fetch_rule_editors({})
            return
        data = item.data(Qt.ItemDataRole.UserRole)
        rule = data if isinstance(data, dict) else {}
        self._set_fetch_rule_editors(rule)

    def _sync_selected_fetch_rule_from_editors(self) -> None:
        if self.fetch_rules_list is None or self.fetch_rules_list.currentRow() < 0:
            return
        item = self.fetch_rules_list.currentItem()
        if item is None:
            return
        source_id = str(self.fetch_source_combo.currentData() or "").strip() if self.fetch_source_combo is not None else ""
        frequency = str(self.fetch_frequency_combo.currentData() or "none").strip() if self.fetch_frequency_combo is not None else "none"
        time_value = self.fetch_time_input.text().strip() if self.fetch_time_input is not None else "09:00"
        if not source_id or frequency == "none":
            return
        existing = item.data(Qt.ItemDataRole.UserRole)
        last_sent_date = str(existing.get("last_sent_date", "")).strip() if isinstance(existing, dict) else ""
        rule = {"source_id": source_id, "frequency": frequency, "time": time_value or "09:00", "last_sent_date": last_sent_date}
        item.setData(Qt.ItemDataRole.UserRole, rule)
        item.setText(self._format_fetch_rule_label(rule))

    def _fetch_rules_from_ui(self) -> list[dict[str, str]]:
        if self.fetch_rules_list is None:
            return []
        rules: list[dict[str, str]] = []
        for index in range(self.fetch_rules_list.count()):
            item = self.fetch_rules_list.item(index)
            if item is None:
                continue
            data = item.data(Qt.ItemDataRole.UserRole)
            if not isinstance(data, dict):
                continue
            source_id = str(data.get("source_id", "")).strip()
            frequency = str(data.get("frequency", "none")).strip() or "none"
            if not source_id or frequency == "none":
                continue
            rules.append(
                {
                    "source_id": source_id,
                    "frequency": frequency,
                    "time": str(data.get("time", "09:00")).strip() or "09:00",
                    "last_sent_date": str(data.get("last_sent_date", "")).strip(),
                }
            )
        return rules

    def _add_fetch_rule(self) -> None:
        if self.fetch_rules_list is None or self.fetch_source_combo is None or self.fetch_frequency_combo is None:
            return
        source_id = str(self.fetch_source_combo.currentData() or "").strip()
        frequency = str(self.fetch_frequency_combo.currentData() or "none").strip() or "none"
        time_value = self.fetch_time_input.text().strip() if self.fetch_time_input is not None else "09:00"
        if not source_id or frequency == "none":
            QMessageBox.warning(self, "Missing Rule Data", "Pick a source and frequency before adding a rule.")
            return
        rule = {"source_id": source_id, "frequency": frequency, "time": time_value or "09:00", "last_sent_date": ""}
        item = QListWidgetItem(self._format_fetch_rule_label(rule))
        item.setData(Qt.ItemDataRole.UserRole, rule)
        self.fetch_rules_list.addItem(item)
        self.fetch_rules_list.setCurrentItem(item)
        self._save_current_person()

    def _save_selected_fetch_rule(self) -> None:
        self._sync_selected_fetch_rule_from_editors()
        self._save_current_person()

    def _delete_fetch_rule(self) -> None:
        if self.fetch_rules_list is None:
            return
        row = self.fetch_rules_list.currentRow()
        if row < 0:
            return
        self.fetch_rules_list.takeItem(row)
        if self.fetch_rules_list.count() > 0:
            self.fetch_rules_list.setCurrentRow(min(row, self.fetch_rules_list.count() - 1))
        else:
            self._set_fetch_rule_editors({})
        self._save_current_person()

    def _render_fetch_rule_labels(self) -> None:
        if self.fetch_rules_list is None:
            return
        for index in range(self.fetch_rules_list.count()):
            item = self.fetch_rules_list.item(index)
            if item is None:
                continue
            data = item.data(Qt.ItemDataRole.UserRole)
            if isinstance(data, dict):
                item.setText(self._format_fetch_rule_label(data))

    def _send_fetch_now(self) -> None:
        if self._fetch_thread is not None:
            QMessageBox.information(self, "Fetch In Progress", "Please wait for the current fetch to finish.")
            return
        if self._current_index is None:
            QMessageBox.warning(self, "Select Person", "Select a person first.")
            return
        # Persist unsaved UI edits before resolving rules.
        self._save_current_person()
        entries = self._entry_data()
        if self._current_index >= len(entries):
            return
        person = entries[self._current_index]
        ai_id = str(person.get("ai_id", "")).strip()
        name = str(person.get("name", "")).strip() or "Someone"
        if not ai_id:
            QMessageBox.warning(self, "Missing AI ID", "Set this person's AI ID before sending fetch messages.")
            return

        api_key = str(self._root.get_default_api_key() or "").strip()
        if not api_key:
            QMessageBox.warning(self, "Missing API Key", "Save a default API key in FEEDER first.")
            return

        source_map = {str(s.get("id", "")).strip(): s for s in self._root.get_fetcher_sources()}
        rules = self._normalize_fetch_rules(person)
        if not rules:
            QMessageBox.warning(self, "No Fetch Rules", "Add at least one source rule first.")
            return

        jobs: list[dict[str, object]] = []
        for rule_index, rule in enumerate(rules):
            source = source_map.get(str(rule.get("source_id", "")).strip())
            if not source:
                continue
            url = str(source.get("url", "")).strip()
            description = str(source.get("description", "")).strip()
            if not url:
                continue
            message = feeder.render_auto_message_template(
                "fetcher_send",
                {"name": name, "url": url, "description": description},
                wrap=True,
            )
            payload = feeder.build_send_message_payload(
                ai_id=ai_id,
                message=message,
                link_url=url,
                link_description=description,
            )
            jobs.append(
                {
                    "api_key": api_key,
                    "payload": payload,
                    "requester": "KINDROIDXL-FETCHER-MANUAL",
                    "success_token": rule_index,
                }
            )

        if not jobs:
            QMessageBox.warning(self, "No Valid Rules", "No rule currently points to a valid source URL.")
            return
        self._pending_fetch_context = {
            "entries": entries,
            "person_index": self._current_index,
            "rules": rules,
        }
        self.fetch_now_btn.setEnabled(False)
        self.fetch_now_btn.setText("Sending...")
        self._fetch_thread = QThread(self)
        self._fetch_worker = FetchSendWorker(jobs)
        self._fetch_worker.moveToThread(self._fetch_thread)
        self._fetch_thread.started.connect(self._fetch_worker.run)
        self._fetch_worker.finished.connect(self._on_fetch_now_finished)
        self._fetch_worker.finished.connect(self._fetch_thread.quit)
        self._fetch_worker.finished.connect(self._fetch_worker.deleteLater)
        self._fetch_thread.finished.connect(self._fetch_thread.deleteLater)
        self._fetch_thread.start()

    def _on_fetch_now_finished(self, sent: int, failed: int, success_tokens: list) -> None:
        if self.fetch_now_btn is not None:
            self.fetch_now_btn.setEnabled(True)
            self.fetch_now_btn.setText("Send Fetch Now")
        context = self._pending_fetch_context or {}
        entries = context.get("entries", [])
        person_index = context.get("person_index", -1)
        rules = context.get("rules", [])
        if isinstance(entries, list) and isinstance(person_index, int) and isinstance(rules, list):
            if 0 <= person_index < len(entries):
                person = entries[person_index]
                if isinstance(person, dict):
                    for token in success_tokens:
                        if isinstance(token, int) and 0 <= token < len(rules) and isinstance(rules[token], dict):
                            rules[token]["last_sent_date"] = time.strftime("%Y-%m-%d")
                    if sent > 0:
                        person["fetch_rules"] = rules
                        first = rules[0] if rules else {}
                        person["fetch_source_id"] = str(first.get("source_id", "")).strip()
                        person["fetch_frequency"] = str(first.get("frequency", "none")).strip() or "none"
                        person["fetch_time"] = str(first.get("time", "09:00")).strip() or "09:00"
                        person["fetch_last_sent_date"] = str(first.get("last_sent_date", "")).strip()
                        entries[person_index] = person
                        self._root.config["directory_entries"] = entries
                        self._root._save_config(self._root.config)
                        self._root._notify_feeder_directory_changed()
        self._fetch_thread = None
        self._fetch_worker = None
        self._pending_fetch_context = None
        QMessageBox.information(self, "Fetch Now Complete", f"Sent: {sent}\nFailed: {failed}")

    def _sanitize_audio_filename_stem(self, raw_name: str) -> str:
        clean = re.sub(r"[^A-Za-z0-9._-]+", "_", raw_name.strip())
        return clean.strip("._-") or "participant"

    def _voice_sample_status_text(self, entry: dict) -> str:
        if not isinstance(entry, dict):
            return "No voice sample preserved"
        sample_file = str(entry.get("voice_sample_file") or entry.get("audio_sample_file") or "").strip()
        sample_path = str(entry.get("voice_sample_path") or entry.get("audio_sample_path") or "").strip()
        if not sample_file and sample_path:
            sample_file = Path(sample_path).name
        if not sample_file:
            return "No voice sample preserved"
        if sample_path and Path(sample_path).exists():
            return f"Preserved voice sample: {sample_file}"
        return f"Voice sample recorded in directory data: {sample_file}"

    def _sanitize_album_path_stem(self, raw_name: str) -> str:
        clean = re.sub(r"[^A-Za-z0-9._-]+", "_", raw_name.strip())
        return clean.strip("._-") or "person"

    def _fetch_kindroid_photos_for_person(self) -> None:
        if self._kindroid_photo_fetch_page is not None:
            QMessageBox.information(self, "Fetch In Progress", "A Kindroid photo fetch is already running.")
            return
        if self._current_index is None:
            QMessageBox.warning(self, "Select Person", "Select a person first.")
            return
        entries = self._entry_data()
        if self._current_index >= len(entries):
            return
        person = entries[self._current_index]
        ai_id = str(person.get("ai_id", "")).strip()
        person_name = str(person.get("name", "")).strip() or "Person"
        if not ai_id:
            QMessageBox.warning(self, "Missing AI ID", "Set this person's AI ID first.")
            return

        selfie_url = QUrl(f"https://kindroid.ai/selfies/{ai_id}/")
        page = QWebEnginePage(self._root.profile, self)
        view = QWebEngineView(self._root)
        view.setPage(page)
        self._kindroid_photo_fetch_tab_index = self._root.tabs.addTab(view, "PHOTO FETCH")
        self._kindroid_photo_fetch_view = view
        self._kindroid_photo_fetch_page = page
        self._kindroid_photo_fetch_target = {"person_name": person_name, "entry_index": self._current_index}

        def on_loaded(ok: bool) -> None:
            if not ok or self._kindroid_photo_fetch_page is None:
                self._cleanup_kindroid_photo_fetch()
                QMessageBox.warning(self, "Fetch Failed", "Could not load the Kindroid selfies page.")
                return
            QTimer.singleShot(2000, self._collect_kindroid_photos_from_loaded_page)

        page.loadFinished.connect(on_loaded)
        page.setUrl(selfie_url)

    def _collect_kindroid_photos_from_loaded_page(self) -> None:
        if self._kindroid_photo_fetch_page is None:
            return
        target = self._kindroid_photo_fetch_target or {}
        person_name = str(target.get("person_name", "")).strip() or "Person"
        entry_index = int(target.get("entry_index", -1))
        album_dir = APP_DATA_DIR / "directory_albums" / self._sanitize_album_path_stem(person_name)
        album_dir.mkdir(parents=True, exist_ok=True)
        self._kindroid_photo_downloads = []
        self._kindroid_photo_download_session = {"entry_index": entry_index, "album_dir": str(album_dir), "last_tick": time.time()}
        if DEBUG_CONSOLE_OUTPUT:
            print(f"[KXL Fetch Photos] Triggering JS bulk downloader for {person_name} ({entry_index}).")

        click_script = """
            (() => {
              const btn = document.getElementById('kxl-selfies-download-btn');
              if (!btn) return { ok:false, reason:'button_not_found' };
              btn.click();
              return { ok:true };
            })();
        """
        self._kindroid_photo_fetch_page.runJavaScript(click_script, self._on_kindroid_photo_collect_result)

    def _on_kindroid_photo_collect_result(self, result: object) -> None:
        if DEBUG_CONSOLE_OUTPUT:
            print(f"[KXL Fetch Photos] Button click result: {result}")
        if not isinstance(result, dict) or not bool(result.get("ok", False)):
            self._cleanup_kindroid_photo_fetch()
            QMessageBox.warning(self, "Fetch Failed", "Bulk downloader button not found on selfies page.")
            return
        QTimer.singleShot(7000, self._finalize_kindroid_download_session)

    def _finalize_kindroid_download_session(self) -> None:
        session = self._kindroid_photo_download_session or {}
        last_tick = float(session.get("last_tick", 0.0) or 0.0)
        idle_for = time.time() - last_tick
        if idle_for < 4.0:
            QTimer.singleShot(3000, self._finalize_kindroid_download_session)
            return
        downloads = list(self._kindroid_photo_downloads)
        self._kindroid_photo_download_session = None
        if DEBUG_CONSOLE_OUTPUT:
            print(f"[KXL Fetch Photos] Download session completed. Files: {len(downloads)}")
        self._save_kindroid_fetched_photos(downloads)

    def _on_kindroid_photo_download_requested(self, download) -> None:
        session = self._kindroid_photo_download_session
        if not session:
            return
        try:
            album_dir = Path(str(session.get("album_dir", "")).strip())
            album_dir.mkdir(parents=True, exist_ok=True)
            name = str(download.downloadFileName() or "kindroid-selfie.jpg").strip() or "kindroid-selfie.jpg"
            target = album_dir / name
            counter = 1
            while target.exists():
                target = album_dir / f"{target.stem}_{counter}{target.suffix}"
                counter += 1
            download.setDownloadDirectory(str(album_dir))
            download.setDownloadFileName(target.name)
            download.accept()
            if DEBUG_CONSOLE_OUTPUT:
                print(f"[KXL Fetch Photos] Accepted download -> {target}")
            def _on_finished() -> None:
                if target.exists():
                    self._kindroid_photo_downloads.append(str(target))
                if self._kindroid_photo_download_session is not None:
                    self._kindroid_photo_download_session["last_tick"] = time.time()
                if DEBUG_CONSOLE_OUTPUT:
                    print(f"[KXL Fetch Photos] Download finished -> {target.exists()} {target}")
            download.finished.connect(_on_finished)
            if self._kindroid_photo_download_session is not None:
                self._kindroid_photo_download_session["last_tick"] = time.time()
        except Exception as exc:
            if DEBUG_CONSOLE_OUTPUT:
                print(f"[KXL Fetch Photos] download hook error: {exc}")

    def _save_kindroid_fetched_photos(self, result: object) -> None:
        target = self._kindroid_photo_fetch_target or {}
        self._cleanup_kindroid_photo_fetch()
        saved_paths = [str(item).strip() for item in (result if isinstance(result, list) else []) if str(item).strip()]
        if not saved_paths:
            QMessageBox.information(self, "Fetch Complete", "No photos were detected on the selfies page.")
            return

        entry_index = int(target.get("entry_index", -1))
        entries = self._entry_data()
        if entry_index < 0 or entry_index >= len(entries):
            return
        person = entries[entry_index]
        person_name = str(target.get("person_name", "")).strip() or str(person.get("name", "")).strip() or "Person"
        album_dir = APP_DATA_DIR / "directory_albums" / self._sanitize_album_path_stem(person_name)
        album_dir.mkdir(parents=True, exist_ok=True)

        existing = [str(item).strip() for item in person.get("album_photos", []) if str(item).strip()]
        existing_set = set(existing)
        added_paths: list[str] = []
        for path in saved_paths:
            if path in existing_set:
                continue
            if not Path(path).exists():
                continue
            existing_set.add(path)
            added_paths.append(path)

        if not added_paths:
            QMessageBox.information(self, "Fetch Complete", "No new photos were downloaded.")
            return
        person["album_photos"] = [*existing, *added_paths]
        entries[entry_index] = person
        self._root.save_directory_entries(entries)
        self.refresh_entries()
        self._select_source_index(entry_index)
        QMessageBox.information(self, "Fetch Complete", f"Downloaded {len(added_paths)} photo(s) from Kindroid selfies.")

    def _cleanup_kindroid_photo_fetch(self) -> None:
        if self._kindroid_photo_fetch_page is not None:
            try:
                self._kindroid_photo_fetch_page.deleteLater()
            except Exception:
                pass
        if self._kindroid_photo_fetch_view is not None:
            try:
                if self._kindroid_photo_fetch_tab_index is not None and hasattr(self._root, "tabs"):
                    self._root.tabs.removeTab(self._kindroid_photo_fetch_tab_index)
                self._kindroid_photo_fetch_view.deleteLater()
            except Exception:
                pass
        self._kindroid_photo_fetch_page = None
        self._kindroid_photo_fetch_view = None
        self._kindroid_photo_fetch_target = None
        self._kindroid_photo_fetch_tab_index = None

    def _google_credentials_candidates(self) -> list[Path]:
        roots: list[Path] = [APP_ROOT]
        cwd = Path.cwd()
        if cwd != APP_ROOT:
            roots.append(cwd)
        candidates: list[Path] = []
        for base in roots:
            candidates.extend(
                [
                    base / "client_secret_333183957465-i3sem49tbt4g032qauc6qvn2tcp5uknm.apps.googleusercontent.com.json",
                    base / "client_secret_333183957465-c3esnjif2thbi35mh6m27ffr4ea4qvul.apps.googleusercontent.com.json",
                    base / "google_calendar_credentials.json",
                ]
            )
        return candidates

    def _google_credentials_path(self) -> Path:
        for candidate in self._google_credentials_candidates():
            if candidate.exists():
                return candidate
        return self._google_credentials_candidates()[0]

    def _google_photos_token_candidates(self) -> list[Path]:
        return [
            APP_DATA_DIR / self.GOOGLE_PHOTOS_TOKEN_FILENAME,
            APP_ROOT / self.GOOGLE_PHOTOS_TOKEN_FILENAME,
            Path.cwd() / self.GOOGLE_PHOTOS_TOKEN_FILENAME,
        ]

    def _google_access_token_from_json(self, candidates: list[Path]) -> tuple[str, Path | None]:
        for candidate in candidates:
            if not candidate.exists():
                continue
            try:
                payload = json.loads(candidate.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(payload, dict):
                continue
            token = str(payload.get("token", "")).strip()
            if token:
                return token, candidate
        return "", None

    def _download_google_photo(
        self,
        *,
        base_url: str,
        mime_type: str,
        media_id: str,
        target_dir: Path,
        headers: dict[str, str],
    ) -> str:
        download_url = f"{base_url}=d"
        extension = mimetypes.guess_extension(mime_type or "") or ".jpg"
        if extension == ".jpe":
            extension = ".jpg"
        target = target_dir / f"google_{media_id}{extension}"
        try:
            response = requests.get(download_url, headers=headers, timeout=45)
            response.raise_for_status()
            target.write_bytes(response.content)
        except Exception:
            return ""
        return str(target)

    def _ensure_google_photos_access_token(self, force_reauth: bool = False) -> tuple[str, Path | None]:
        photos_token_path = APP_DATA_DIR / self.GOOGLE_PHOTOS_TOKEN_FILENAME
        if force_reauth:
            for candidate in self._google_photos_token_candidates():
                if not candidate.exists():
                    continue
                try:
                    candidate.unlink()
                except Exception:
                    pass

        for candidate in self._google_photos_token_candidates():
            if not candidate.exists():
                continue
            try:
                payload = json.loads(candidate.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(payload, dict):
                continue
            token = str(payload.get("token", "")).strip()
            scopes = {str(scope).strip() for scope in payload.get("scopes", []) if str(scope).strip()}
            if token and "https://www.googleapis.com/auth/photoslibrary.readonly" in scopes:
                return token, candidate

        if importlib.util.find_spec("google_auth_oauthlib") is None or importlib.util.find_spec("google.oauth2") is None:
            raise RuntimeError(
                "Google auth libraries are missing. Install/refresh Google dependencies from the Calendar tab, then retry."
            )
        credentials_path = self._google_credentials_path()
        if not credentials_path.exists():
            raise RuntimeError(
                "Google credentials JSON not found. Use the same client_secret JSON you use for Calendar sync."
            )

        from google_auth_oauthlib.flow import InstalledAppFlow

        flow = InstalledAppFlow.from_client_secrets_file(str(credentials_path), self.GOOGLE_PHOTOS_SCOPES)
        creds = flow.run_local_server(
            host="localhost",
            port=0,
            open_browser=True,
            access_type="offline",
            prompt="consent",
            include_granted_scopes="false",
        )
        APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
        photos_token_path.write_text(creds.to_json(), encoding="utf-8")
        return str(getattr(creds, "token", "")).strip(), photos_token_path

    def _sync_all_directory_albums_from_google_photos(self) -> tuple[int, int, int]:
        token, token_path = self._ensure_google_photos_access_token()
        if not token:
            raise RuntimeError("No valid Google Photos token available.")

        entries = self._entry_data()
        if not entries:
            return 0, 0, 0
        names_to_index: dict[str, int] = {}
        for idx, entry in enumerate(entries):
            person_name = str(entry.get("name", "")).strip()
            if person_name:
                names_to_index[person_name.casefold()] = idx
        if not names_to_index:
            return 0, 0, 0

        headers = {"Authorization": f"Bearer {token}"}

        def _google_error_detail(response: requests.Response) -> str:
            try:
                payload = response.json()
            except Exception:
                payload = {}
            if isinstance(payload, dict):
                err = payload.get("error", {})
                if isinstance(err, dict):
                    message = str(err.get("message", "")).strip()
                    status = str(err.get("status", "")).strip()
                    if message and status:
                        return f"{status}: {message}"
                    if message:
                        return message
            return (response.text or "").strip()[:240]

        albums: list[dict] = []
        next_page_token = ""
        while True:
            params = {"pageSize": 50}
            if next_page_token:
                params["pageToken"] = next_page_token
            response = requests.get(self.GOOGLE_PHOTOS_ALBUMS_API, headers=headers, params=params, timeout=45)
            if response.status_code == 401:
                token, token_path = self._ensure_google_photos_access_token(force_reauth=True)
                if not token:
                    raise RuntimeError("Google Photos authorization expired. Click SYNC PHOTOS again to reconnect.")
                headers = {"Authorization": f"Bearer {token}"}
                response = requests.get(self.GOOGLE_PHOTOS_ALBUMS_API, headers=headers, params=params, timeout=45)
            if response.status_code == 403:
                token, token_path = self._ensure_google_photos_access_token(force_reauth=True)
                if token:
                    headers = {"Authorization": f"Bearer {token}"}
                    response = requests.get(self.GOOGLE_PHOTOS_ALBUMS_API, headers=headers, params=params, timeout=45)
            if response.status_code == 403:
                detail = _google_error_detail(response)
                raise RuntimeError(
                    "Google Photos API access denied (403). "
                    "Enable Google Photos Library API for your OAuth project and re-consent Photos access.\n"
                    f"Details: {detail}"
                )
            response.raise_for_status()
            payload = response.json() if response.content else {}
            if isinstance(payload, dict):
                albums.extend(item for item in payload.get("albums", []) if isinstance(item, dict))
                next_page_token = str(payload.get("nextPageToken", "")).strip()
                if next_page_token:
                    continue
            break

        matched = 0
        downloaded = 0
        updated_people = 0
        for album in albums:
            title = str(album.get("title", "")).strip()
            album_id = str(album.get("id", "")).strip()
            if not title or not album_id:
                continue
            entry_index = names_to_index.get(title.casefold())
            if entry_index is None:
                continue
            matched += 1
            person = entries[entry_index]
            person_name = str(person.get("name", "")).strip() or title
            album_dir = APP_DATA_DIR / "directory_albums" / self._sanitize_album_path_stem(person_name)
            album_dir.mkdir(parents=True, exist_ok=True)
            existing = [str(item).strip() for item in person.get("album_photos", []) if str(item).strip()]
            existing_set = set(existing)
            next_media_token = ""
            person_new_paths: list[str] = []
            while True:
                body: dict[str, object] = {"albumId": album_id, "pageSize": 100}
                if next_media_token:
                    body["pageToken"] = next_media_token
                media_response = requests.post(self.GOOGLE_PHOTOS_SEARCH_API, headers=headers, json=body, timeout=45)
                if media_response.status_code == 403:
                    token, token_path = self._ensure_google_photos_access_token(force_reauth=True)
                    if token:
                        headers = {"Authorization": f"Bearer {token}"}
                        media_response = requests.post(self.GOOGLE_PHOTOS_SEARCH_API, headers=headers, json=body, timeout=45)
                if media_response.status_code == 403:
                    detail = _google_error_detail(media_response)
                    raise RuntimeError(
                        "Google Photos media search denied (403). "
                        "Verify Photos API enablement and granted scopes for this Google project.\n"
                        f"Details: {detail}"
                    )
                media_response.raise_for_status()
                media_payload = media_response.json() if media_response.content else {}
                media_items = media_payload.get("mediaItems", []) if isinstance(media_payload, dict) else []
                for media in media_items:
                    if not isinstance(media, dict):
                        continue
                    base_url = str(media.get("baseUrl", "")).strip()
                    mime_type = str(media.get("mimeType", "")).strip()
                    media_id = str(media.get("id", "")).strip()
                    if not base_url or not media_id or not mime_type.startswith("image/"):
                        continue
                    local_path = self._download_google_photo(
                        base_url=base_url,
                        mime_type=mime_type,
                        media_id=media_id,
                        target_dir=album_dir,
                        headers=headers,
                    )
                    if not local_path or local_path in existing_set:
                        continue
                    existing_set.add(local_path)
                    person_new_paths.append(local_path)
                    downloaded += 1
                next_media_token = str(media_payload.get("nextPageToken", "")).strip() if isinstance(media_payload, dict) else ""
                if not next_media_token:
                    break
            if person_new_paths:
                person["album_photos"] = [*existing, *person_new_paths]
                entries[entry_index] = person
                updated_people += 1

        if updated_people:
            self._root.save_directory_entries(entries)
            self.refresh_entries()
        return matched, downloaded, updated_people

    def _sync_google_photos_from_directory(self) -> None:
        try:
            matched, downloaded, updated_people = self._sync_all_directory_albums_from_google_photos()
        except Exception as exc:
            QMessageBox.warning(self, "Google Photos Sync Failed", str(exc))
            return
        QMessageBox.information(
            self,
            "Google Photos Sync Complete",
            (
                f"Matched albums: {matched}\n"
                f"Downloaded images: {downloaded}\n"
                f"People updated: {updated_people}\n\n"
                "Matching rule: Google album title equals DIRECTORY person name (case-insensitive)."
            ),
        )

    def _open_album_dialog(self) -> None:
        if self._current_index is None:
            QMessageBox.warning(self, "Select Person", "Select a person first.")
            return
        entries = self._entry_data()
        if self._current_index >= len(entries):
            return
        person = entries[self._current_index]
        person_name = str(person.get("name", "")).strip() or "Person"
        album_paths = self._album_paths_for_entry(person)
        if album_paths != [str(item).strip() for item in person.get("album_photos", []) if str(item).strip()]:
            person["album_photos"] = album_paths
            entries[self._current_index] = person
            self._root.config["directory_entries"] = entries
            self._root._save_config(self._root.config)

        dialog = QDialog(self)
        dialog.setWindowTitle(f"Album — {person_name}")
        dialog.resize(920, 620)
        dialog.setStyleSheet(
            """
            QDialog { background: #0a0f1c; color: #eef2ff; }
            QLabel#albumTitle { font-size: 22px; font-weight: 800; color: #f5f7ff; }
            QLabel#albumSubtitle { color: #9fb0d8; }
            QListWidget {
                background: #070b16;
                border: 1px solid #1b2740;
                border-radius: 14px;
                padding: 10px;
            }
            QListWidget::item {
                margin: 8px;
                padding: 8px;
                border-radius: 12px;
                background: #10192b;
            }
            QListWidget::item:selected {
                border: 1px solid #5f8cff;
                background: #1a2742;
            }
            QPushButton {
                background: #131d34;
                border: 1px solid #31456f;
                border-radius: 10px;
                padding: 9px 14px;
                color: #ecf0ff;
                font-weight: 700;
            }
            QPushButton:hover { background: #1b2946; border-color: #4d6fae; }
            QPushButton#primaryButton { background: #315cff; border-color: #5d7fff; }
            QPushButton#dangerButton { background: #442030; border-color: #8b4560; }
            """
        )
        layout = QVBoxLayout(dialog)
        header = QLabel(f"{person_name}'s Photo Album", dialog)
        header.setObjectName("albumTitle")
        subtitle = QLabel("Upload photos and curate this person's gallery. Or import from Google Photos albums.", dialog)
        subtitle.setObjectName("albumSubtitle")
        layout.addWidget(header)
        layout.addWidget(subtitle)

        album_list = QListWidget(dialog)
        album_list.setViewMode(QListWidget.ViewMode.IconMode)
        album_list.setResizeMode(QListWidget.ResizeMode.Adjust)
        album_list.setWrapping(True)
        album_list.setMovement(QListWidget.Movement.Static)
        album_list.setIconSize(QSize(180, 180))
        album_list.setSpacing(12)
        album_list.setSelectionMode(QListWidget.SelectionMode.ExtendedSelection)
        layout.addWidget(album_list, 1)

        info_label = QLabel(dialog)
        info_label.setStyleSheet("color:#9fb0d8;")
        layout.addWidget(info_label)

        button_row = QHBoxLayout()
        add_btn = QPushButton("Add Photos", dialog)
        add_btn.setObjectName("primaryButton")
        sync_google_btn = QPushButton("Sync All From Google Photos", dialog)
        remove_btn = QPushButton("Remove Selected", dialog)
        remove_btn.setObjectName("dangerButton")
        close_btn = QPushButton("Done", dialog)
        button_row.addWidget(add_btn)
        button_row.addWidget(sync_google_btn)
        button_row.addWidget(remove_btn)
        button_row.addStretch(1)
        button_row.addWidget(close_btn)
        layout.addLayout(button_row)

        def refresh_album_list(paths: list[str]) -> None:
            album_list.clear()
            valid_paths: list[str] = []
            for raw in paths:
                photo_path = str(raw).strip()
                if not photo_path:
                    continue
                pix = QPixmap(photo_path)
                if pix.isNull():
                    continue
                item = QListWidgetItem(Path(photo_path).name)
                item.setData(Qt.ItemDataRole.UserRole, photo_path)
                thumb = pix.scaled(
                    180,
                    180,
                    Qt.AspectRatioMode.KeepAspectRatioByExpanding,
                    Qt.TransformationMode.SmoothTransformation,
                )
                item.setIcon(QIcon(thumb))
                item.setToolTip(photo_path)
                album_list.addItem(item)
                valid_paths.append(photo_path)
            info_label.setText(f"{len(valid_paths)} photo(s) in album")
            if self._current_index is not None and 0 <= self._current_index < len(entries):
                person["album_photos"] = valid_paths
                entries[self._current_index] = person
                self._root.config["directory_entries"] = entries
                self._root._save_config(self._root.config)
                self._root._notify_feeder_directory_changed()
                self._refresh_character_sheet_portrait(person)

        def add_photos() -> None:
            files, _ = QFileDialog.getOpenFileNames(
                dialog,
                "Choose album photos",
                str(Path.home()),
                "Image Files (*.png *.jpg *.jpeg *.webp *.bmp *.gif)",
            )
            if not files:
                return
            album_dir = APP_DATA_DIR / "directory_albums" / self._sanitize_album_path_stem(person_name)
            album_dir.mkdir(parents=True, exist_ok=True)
            current = [album_list.item(i).data(Qt.ItemDataRole.UserRole) for i in range(album_list.count())]
            for source_raw in files:
                source = Path(source_raw)
                ext = source.suffix.lower()
                if ext not in self.ALBUM_IMAGE_EXTENSIONS:
                    continue
                target = album_dir / source.name
                counter = 1
                while target.exists():
                    target = album_dir / f"{source.stem}_{counter}{source.suffix}"
                    counter += 1
                try:
                    shutil.copy2(source, target)
                except OSError as exc:
                    QMessageBox.warning(dialog, "Photo Copy Failed", f"Could not add {source.name}:\n{exc}")
                    continue
                current.append(str(target))
            refresh_album_list(current)

        def remove_selected() -> None:
            selected = {index.row() for index in album_list.selectedIndexes()}
            if not selected:
                return
            current = [album_list.item(i).data(Qt.ItemDataRole.UserRole) for i in range(album_list.count())]
            for idx in sorted(selected, reverse=True):
                if 0 <= idx < len(current):
                    current.pop(idx)
            refresh_album_list(current)

        def sync_google_photos() -> None:
            try:
                matched, downloaded, updated_people = self._sync_all_directory_albums_from_google_photos()
            except Exception as exc:
                QMessageBox.warning(dialog, "Google Photos Sync Failed", str(exc))
                return
            if self._current_index is not None and 0 <= self._current_index < len(entries):
                current_person = entries[self._current_index]
                refresh_album_list([str(item).strip() for item in current_person.get("album_photos", []) if str(item).strip()])
            QMessageBox.information(
                dialog,
                "Google Photos Sync Complete",
                (
                    f"Matched albums: {matched}\n"
                    f"Downloaded images: {downloaded}\n"
                    f"People updated: {updated_people}\n\n"
                    "Matching rule: Google album title equals DIRECTORY person name (case-insensitive)."
                ),
            )

        add_btn.clicked.connect(add_photos)
        sync_google_btn.clicked.connect(sync_google_photos)
        remove_btn.clicked.connect(remove_selected)
        close_btn.clicked.connect(dialog.accept)
        refresh_album_list(album_paths)
        dialog.exec()

    def _upload_directory_portrait(self) -> None:
        if self._current_index is None:
            QMessageBox.warning(self, "Select Person", "Select a person first.")
            return

        entries = self._entry_data()
        if self._current_index >= len(entries):
            return
        person = entries[self._current_index]
        person_name = str(person.get("name", "")).strip()
        if not person_name:
            QMessageBox.warning(self, "Missing Name", "Please set the person's name first.")
            return

        file_path, _ = QFileDialog.getOpenFileName(
            self,
            f"Choose portrait for {person_name}",
            str(Path.home()),
            "Image Files (*.png *.jpg *.jpeg *.webp *.bmp *.gif)",
        )
        if not file_path:
            return

        source = Path(file_path)
        ext = source.suffix.lower()
        if ext not in self.ALBUM_IMAGE_EXTENSIONS:
            QMessageBox.warning(self, "Invalid File", f"Unsupported image format: {ext or 'unknown'}")
            return

        candidate = QPixmap(str(source))
        if candidate.isNull():
            QMessageBox.warning(self, "Image unavailable", f"Could not open image:\n{file_path}")
            return
        if candidate.width() >= candidate.height():
            QMessageBox.warning(
                self,
                "Portrait required",
                "Directory portraits must be portrait oriented (height greater than width).",
            )
            return

        portraits_dir = APP_DATA_DIR / "directory_albums" / self._sanitize_album_path_stem(person_name) / "portraits"
        portraits_dir.mkdir(parents=True, exist_ok=True)
        target = portraits_dir / source.name
        counter = 1
        while target.exists():
            target = portraits_dir / f"{source.stem}_{counter}{source.suffix}"
            counter += 1
        try:
            shutil.copy2(source, target)
        except OSError as exc:
            QMessageBox.warning(self, "Portrait Copy Failed", f"Could not save portrait:\n{exc}")
            return

        target_path = str(target)
        person["dominant_portrait"] = target_path
        person["photo"] = target_path
        person["album_photos"] = self._album_paths_for_entry(person, extra_paths=[target_path])
        entries[self._current_index] = person
        self._root.config["directory_entries"] = entries
        self._root._save_config(self._root.config)
        self._sync_generations_for_directory_entry(person, prefer_form_values=False)
        self.refresh_entries()
        self._select_source_index(self._current_index)
        self._refresh_character_sheet_portrait(person)
        self._load_tree_subtab(person)
        self._root._notify_feeder_directory_changed()
        QMessageBox.information(self, "Portrait Saved", f"Saved directory portrait to:\n{target}")

    def _upload_audio_sample(self) -> None:
        if self._current_index is None:
            QMessageBox.warning(self, "Select Person", "Select a person first.")
            return

        entries = self._entry_data()
        if self._current_index >= len(entries):
            return
        person = entries[self._current_index]
        person_name = str(person.get("name", "")).strip()
        if not person_name:
            QMessageBox.warning(self, "Missing Name", "Please set the person's name first.")
            return

        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "Select Voice Sample",
            str(Path.home()),
            "Audio Files (*.mp3 *.wav *.m4a *.ogg *.flac *.aac *.wma)",
        )
        if not file_path:
            return

        source = Path(file_path)
        ext = source.suffix.lower()
        if ext not in self.AUDIO_SAMPLE_EXTENSIONS:
            QMessageBox.warning(self, "Invalid File", f"Unsupported audio format: {ext or 'unknown'}")
            return

        directory_uid = self._ensure_entry_uid(person)
        person_folder = f"{self._sanitize_audio_filename_stem(person_name)}_{directory_uid[:8]}"
        samples_dir = DIRECTORY_VOICE_SAMPLES_DIR / person_folder
        samples_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        target = samples_dir / f"{self._sanitize_audio_filename_stem(person_name)}_voice_{timestamp}{ext}"
        counter = 1
        while target.exists():
            target = samples_dir / f"{self._sanitize_audio_filename_stem(person_name)}_voice_{timestamp}_{counter}{ext}"
            counter += 1
        try:
            shutil.copy2(source, target)
        except OSError as exc:
            QMessageBox.warning(self, "Backup Failed", f"Could not preserve voice sample:\n{exc}")
            return

        history = person.get("voice_sample_history", [])
        if not isinstance(history, list):
            history = []
        history.append(
            {
                "file": target.name,
                "path": str(target),
                "source_name": source.name,
                "uploaded_at": datetime.now().isoformat(timespec="seconds"),
            }
        )
        person["voice_sample_file"] = target.name
        person["voice_sample_path"] = str(target)
        person["voice_sample_uploaded_at"] = history[-1]["uploaded_at"]
        person["voice_sample_history"] = history
        # Keep the legacy audio_sample_* keys populated so older integrations keep working.
        person["audio_sample_file"] = target.name
        person["audio_sample_path"] = str(target)
        entries[self._current_index] = person
        self._root.config["directory_entries"] = entries
        self._root._save_config(self._root.config)
        self._root._notify_feeder_directory_changed()
        self.audio_sample_label.setText(self._voice_sample_status_text(person))
        QMessageBox.information(self, "Voice Sample Preserved", f"Copied voice sample into DIRECTORY backup storage:\n{target}")

    def _upload_family_banner(self) -> None:
        if self._current_index is None:
            QMessageBox.warning(self, "Select Person", "Select a person first.")
            return

        entries = self._entry_data()
        if self._current_index >= len(entries):
            return
        person = entries[self._current_index]
        person_name = str(person.get("name", "")).strip()
        family = self._family_from_name(person_name)
        if not family:
            QMessageBox.warning(self, "Missing Family Name", "Use a full name so we can detect a family name.")
            return

        file_path, _ = QFileDialog.getOpenFileName(
            self,
            f"Choose family banner for {family}",
            str(Path.home()),
            "Image Files (*.png *.jpg *.jpeg *.webp *.bmp *.gif)",
        )
        if not file_path:
            return

        source = Path(file_path)
        ext = source.suffix.lower()
        if ext not in self.ALBUM_IMAGE_EXTENSIONS:
            QMessageBox.warning(self, "Invalid File", f"Unsupported image format: {ext or 'unknown'}")
            return

        banners_dir = APP_DATA_DIR / "family_media" / "banners"
        banners_dir.mkdir(parents=True, exist_ok=True)
        target = banners_dir / f"{family}{ext}"
        try:
            shutil.copy2(source, target)
        except OSError as exc:
            QMessageBox.warning(self, "Banner Copy Failed", f"Could not save banner:\n{exc}")
            return

        media_map = self._root.config.get("generations_family_media", {})
        if not isinstance(media_map, dict):
            media_map = {}
        existing = media_map.get(family, {})
        if not isinstance(existing, dict):
            existing = {}
        existing["banner"] = str(target)
        existing["tags"] = [str(tag).strip() for tag in existing.get("tags", []) if str(tag).strip()]
        media_map[family] = existing
        self._root.config["generations_family_media"] = media_map
        self._root._save_config(self._root.config)
        self._render_family_status_media(person)
        QMessageBox.information(self, "Banner Saved", f"Saved family banner for {family}:\n{target}")

    def _add_person(self) -> None:
        name, ok = QInputDialog.getText(self, "New Person", "NAME:")
        if not ok:
            return
        clean_name = name.strip()
        if not clean_name:
            QMessageBox.warning(self, "Missing Name", "Name is required.")
            return
        entries = self._entry_data()
        new_uid = self._new_directory_uid()
        entries.append(
            {
                "directory_uid": new_uid,
                "name": clean_name,
                "gender": "",
                "age": self.DEFAULT_AGE,
                "ai_id": "",
                "location": "home",
                "position": "",
                "rank": "",
                "responsibilities": "",
                "backstory": "",
                "ai_memory": "",
                "greeting": "",
                "directive": "",
                "additional_context": self.DEFAULT_EMPTY_VALUES["additional_context"],
                "temperature": self.DEFAULT_EMPTY_VALUES["temperature"],
                "reasoning_effort": self.DEFAULT_EMPTY_VALUES["reasoning_effort"],
                "llm_flair": self.DEFAULT_EMPTY_VALUES["llm_flair"],
                "avatar_preset": self.DEFAULT_EMPTY_VALUES["avatar_preset"],
                "avatar_description": "",
                "fetch_rules": [],
                "fetch_source_id": "",
                "fetch_frequency": "none",
                "fetch_time": "09:00",
                "fetch_last_sent_date": "",
                "album_photos": [],
                "assets": 0,
                "online": False,
                "archived": False,
                **COMMUNICATION_AVATAR_DEFAULTS,
            }
        )
        self._root.config["directory_entries"] = entries
        self._root._save_config(self._root.config)
        self._current_uid = new_uid
        self.refresh_entries()
        target_row = self._row_for_directory_uid(new_uid)
        self.people_list.setCurrentRow(target_row if target_row >= 0 else 0)
        self._root._notify_feeder_directory_changed()
        if self._current_index is not None and 0 <= self._current_index < len(entries):
            self._sync_generations_for_directory_entry(entries[self._current_index], prefer_form_values=False)
            self._refresh_character_sheet_portrait(entries[self._current_index])

    def _refresh_character_sheet_portrait(self, entry: dict | None) -> None:
        if self.character_portrait_label is None or self.character_portrait_name is None:
            return
        payload = entry if isinstance(entry, dict) else {}
        name = str(payload.get("name", "")).strip() or "CHARACTER SHEET"
        self.character_portrait_name.setText(name.upper())
        pixmap = self._character_sheet_portrait_for_entry(payload)
        if pixmap is None:
            self.character_portrait_label.setPixmap(QPixmap())
            self.character_portrait_label.setText("No portrait in album")
            return
        shown = pixmap.scaled(
            self.character_portrait_label.size(),
            Qt.AspectRatioMode.KeepAspectRatioByExpanding,
            Qt.TransformationMode.SmoothTransformation,
        )
        self.character_portrait_label.setPixmap(shown)
        self.character_portrait_label.setText("")


    @staticmethod
    def _album_paths_for_entry(entry: dict, extra_paths: list[str] | None = None) -> list[str]:
        paths: list[str] = []
        raw_album = entry.get("album_photos", [])
        if isinstance(raw_album, list):
            paths.extend(str(item).strip() for item in raw_album if str(item).strip())
        paths.extend(
            path
            for path in (
                str(entry.get("dominant_portrait", "")).strip(),
                str(entry.get("photo", "")).strip(),
                *(extra_paths or []),
            )
            if path
        )
        return list(dict.fromkeys(paths))

    @staticmethod
    def _character_sheet_portrait_for_entry(entry: dict) -> QPixmap | None:
        portrait_path = DirectoryTab._latest_portrait_path_for_entry(entry)
        if not portrait_path:
            return None
        pix = QPixmap(portrait_path)
        return None if pix.isNull() else pix

    @staticmethod
    def _latest_portrait_path_for_entry(entry: dict) -> str:
        explicit_candidates = (
            str(entry.get("dominant_portrait", "")).strip(),
            str(entry.get("photo", "")).strip(),
        )
        for candidate in explicit_candidates:
            if DirectoryTab._is_readable_portrait_path(candidate):
                return candidate

        album = entry.get("album_photos", [])
        if not isinstance(album, list):
            return ""
        portraits: list[tuple[float, str]] = []
        for raw in album:
            candidate = str(raw).strip()
            if not DirectoryTab._is_readable_portrait_path(candidate):
                continue
            path = Path(candidate)
            try:
                stamp = path.stat().st_mtime
            except OSError:
                stamp = 0.0
            portraits.append((stamp, str(path)))
        if not portraits:
            return ""
        portraits.sort(key=lambda row: row[0], reverse=True)
        return portraits[0][1]

    @staticmethod
    def _is_readable_portrait_path(candidate: str) -> bool:
        if not candidate:
            return False
        path = Path(candidate)
        if not path.exists() or not path.is_file():
            return False
        pix = QPixmap(str(path))
        return not pix.isNull() and pix.height() > pix.width()

    def _toggle_archive_person(self) -> None:
        if self._current_index is None:
            return
        self._save_current_person(notify_directory=False, sync_generations=False, refresh_visuals=False)
        entries = self._entry_data()
        if self._current_index >= len(entries):
            return
        person = entries[self._current_index]
        archived = not self._is_entry_archived(person)
        person["archived"] = archived
        if archived:
            person["online"] = False
        entries[self._current_index] = person
        self._root.config["directory_entries"] = entries
        self._root._save_config(self._root.config)
        self._current_uid = self._ensure_entry_uid(person)
        self.refresh_entries()
        self._root._notify_feeder_directory_changed()

    def _remove_person(self) -> None:
        if self._current_index is None:
            return
        entries = self._entry_data()
        victim = entries[self._current_index]
        confirm = QMessageBox.question(
            self, "Delete Person", f"Delete {victim.get('name', 'this person')} from DIRECTORY?"
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        entries.pop(self._current_index)
        self._root.config["directory_entries"] = entries
        self._root._save_config(self._root.config)
        self.refresh_entries()
        self._root._notify_feeder_directory_changed()

    def _schedule_save_current_person(self) -> None:
        if self._current_index is None:
            return
        self._save_timer.start()

    def _flush_scheduled_save(self, *, force: bool = False) -> None:
        if not force and not self._save_timer.isActive():
            return
        if self._current_index is None:
            self._save_timer.stop()
            return
        self._save_timer.stop()
        self._save_current_person(notify_directory=False, sync_generations=False, refresh_visuals=False)

    def _save_current_person(
        self,
        *,
        notify_directory: bool = True,
        sync_generations: bool = True,
        refresh_visuals: bool = True,
    ) -> None:
        self._save_timer.stop()
        if self._current_index is None:
            return
        entries = self._entry_data()
        if self._current_index >= len(entries):
            return
        form_data = self._read_from_form()
        form_data["rank"] = self._rank_for_directory_entry(entries[self._current_index])
        for key, default_value in self.DEFAULT_EMPTY_VALUES.items():
            if key == "additional_context":
                continue
            if not str(form_data.get(key, "")).strip():
                form_data[key] = default_value
        original_online = bool(entries[self._current_index].get("online", False))
        entries[self._current_index] = {**entries[self._current_index], **form_data, "online": original_online}
        self._root.config["directory_entries"] = entries
        self._root._save_config(self._root.config)
        display_row = self._row_for_source_index(self._current_index)
        if display_row >= 0:
            name = str(form_data.get("name", "")).strip() or "Unnamed person"
            badge = "🟢" if original_online else "🔴"
            item = self.people_list.item(display_row)
            if item is not None:
                item.setText(f"{badge} {name}")
        if sync_generations:
            self._sync_generations_for_directory_entry(entries[self._current_index], prefer_form_values=False)
        if refresh_visuals:
            self._refresh_character_sheet_portrait(entries[self._current_index])
            self._load_tree_subtab(entries[self._current_index])
        if notify_directory:
            self._root._notify_feeder_directory_changed()

    def _toggle_online_status(self) -> None:
        if self._current_index is None:
            return
        # Always persist current form edits before any online/offline action.
        # This avoids losing in-progress changes when server sync dialogs/actions run.
        self._save_current_person(notify_directory=False, sync_generations=False, refresh_visuals=False)
        entries = self._entry_data()
        if self._current_index >= len(entries):
            return
        person = entries[self._current_index]
        is_online = bool(person.get("online", False))
        if is_online:
            person["online"] = False
            entries[self._current_index] = person
            self._root.config["directory_entries"] = entries
            self._root._save_config(self._root.config)
            self.refresh_entries()
            self._root._notify_feeder_directory_changed()
            return

        action_choice, ok = QInputDialog.getItem(
            self,
            "Server Sync Mode",
            "Set this person online with which action?",
            ["Rebuild on the server", "Update on the server", "Mark online only"],
            0,
            False,
        )
        if not ok:
            return

        success = True
        if action_choice == "Rebuild on the server":
            success = self._rebuild_person_on_server(self._current_index)
        elif action_choice == "Update on the server":
            success = self._update_person_on_server(self._current_index)

        if not success:
            return

        person["online"] = True
        entries[self._current_index] = person
        self._root.config["directory_entries"] = entries
        self._root._save_config(self._root.config)
        self.refresh_entries()
        self._root._notify_feeder_directory_changed()

    def _rebuild_person_on_server(self, person_index: int) -> bool:
        entries = self._entry_data()
        if person_index >= len(entries):
            return False
        person = entries[person_index]
        required = ["name", "gender", "backstory"]
        missing = [field for field in required if not str(person.get(field, "")).strip()]
        if missing:
            QMessageBox.warning(self, "Missing fields", f"Please fill required fields first: {', '.join(missing)}.")
            return False

        api_key = self._root.get_default_api_key()
        if not api_key:
            api_key, ok = QInputDialog.getText(
                self,
                "API Key Required",
                "Enter API key (kn_...):",
                QLineEdit.EchoMode.Password,
            )
            if not ok:
                return False
            api_key = api_key.strip()
        if not api_key.startswith("kn_"):
            QMessageBox.warning(self, "Invalid API key", "API key must start with kn_.")
            return False

        payload = {
            "ai_name": str(person.get("name", "")).strip(),
            "ai_gender": str(person.get("gender", "")).strip(),
            "ai_backstory": str(person.get("backstory", "")).strip(),
            "custom_greeting": str(person.get("greeting", "")).strip(),
            "ai_directive": str(person.get("directive", "")).strip(),
            "ai_avatar": str(person.get("avatar_preset", "")).strip(),
            "custom_avatar_description": str(person.get("avatar_description", "")).strip(),
        }
        payload = {k: v for k, v in payload.items() if v}

        ok, status, response = feeder.execute_api_request(
            tool_key="create_kin",
            api_key=api_key,
            payload=payload,
            requester="KINDROIDXL-DIRECTORY-REBUILD",
        )
        if not ok:
            QMessageBox.warning(self, "Rebuild failed", f"{status}\n{response}")
            return False

        new_ai_id = self._extract_ai_id(response)
        if not new_ai_id:
            QMessageBox.warning(
                self,
                "Rebuild parsing error",
                "Create Kin succeeded but the new AI ID could not be parsed from the response.",
            )
            return False
        person["ai_id"] = new_ai_id
        entries[person_index] = person
        self._root.config["directory_entries"] = entries
        self._root._save_config(self._root.config)
        self.refresh_entries()
        self._root._notify_feeder_directory_changed()

        fed_count = self._replay_memories_by_name(
            api_key=api_key,
            person_name=str(person.get("name", "")).strip(),
            ai_id=new_ai_id,
            mode="all",
        )
        updated, update_status, update_response = self._push_update_kin(api_key=api_key, person=person, ai_id=new_ai_id)
        QMessageBox.information(
            self,
            "Rebuild complete",
            (
                f"Rebuild success (HTTP {status}). Updated AI ID: {new_ai_id}\n"
                f"Replayed memories: {fed_count}\n"
                f"Update Kin status: {update_status}\n\n"
                f"Update response:\n{update_response}"
            ),
        )
        return True

    def _update_person_on_server(self, person_index: int) -> bool:
        entries = self._entry_data()
        if person_index >= len(entries):
            return False
        person = entries[person_index]
        ai_id = str(person.get("ai_id", "")).strip()
        if not ai_id:
            QMessageBox.warning(self, "Missing AI ID", "Update on server requires an existing AI ID.")
            return False

        api_key = self._root.get_default_api_key()
        if not api_key:
            api_key, ok = QInputDialog.getText(
                self,
                "API Key Required",
                "Enter API key (kn_...):",
                QLineEdit.EchoMode.Password,
            )
            if not ok:
                return False
            api_key = api_key.strip()
        if not api_key.startswith("kn_"):
            QMessageBox.warning(self, "Invalid API key", "API key must start with kn_.")
            return False

        fed_count = self._replay_memories_by_name(
            api_key=api_key,
            person_name=str(person.get("name", "")).strip(),
            ai_id=ai_id,
            mode="forgotten_only",
        )
        updated, update_status, update_response = self._push_update_kin(api_key=api_key, person=person, ai_id=ai_id)
        if not updated:
            QMessageBox.warning(
                self,
                "Update failed",
                f"Update Kin request failed.\nStatus: {update_status}\nResponse:\n{update_response}",
            )
            return False
        QMessageBox.information(
            self,
            "Update complete",
            (
                f"Updated {person.get('name', 'kin')} on server.\n"
                f"Forgotten memories replayed: {fed_count}\n"
                f"Update status: {update_status}\n\n"
                f"Update response:\n{update_response}"
            ),
        )
        return True

    def _global_execute_updates(self) -> None:
        if self._global_update_thread is not None and self._global_update_thread.isRunning():
            QMessageBox.information(self, "Global Execute", "Global execute is already running.")
            return
        api_key = str(self._root.get_default_api_key() or "").strip()
        if not api_key:
            api_key, ok = QInputDialog.getText(
                self,
                "API Key Required",
                "Enter API key (kn_...):",
                QLineEdit.EchoMode.Password,
            )
            if not ok:
                return
            api_key = api_key.strip()
        if not api_key.startswith("kn_"):
            QMessageBox.warning(self, "Invalid API key", "API key must start with kn_.")
            return

        jobs: list[dict[str, object]] = []
        for person in self._entry_data():
            if not isinstance(person, dict):
                continue
            ai_id = str(person.get("ai_id", "")).strip()
            if not ai_id:
                continue
            payload = self._build_update_kin_payload(person=person, ai_id=ai_id)
            if not payload:
                continue
            jobs.append({"api_key": api_key, "payload": payload})
        if not jobs:
            QMessageBox.information(
                self,
                "Global Execute",
                "No valid DIRECTORY entries were found with AI IDs. Nothing to execute.",
            )
            return

        self.global_execute_btn.setEnabled(False)
        self.global_execute_btn.setToolTip("Running global execute...")
        self._global_update_thread = QThread(self)
        self._global_update_worker = DirectoryGlobalUpdateWorker(jobs)
        self._global_update_worker.moveToThread(self._global_update_thread)
        self._global_update_thread.started.connect(self._global_update_worker.run)
        self._global_update_worker.finished.connect(self._on_global_execute_finished)
        self._global_update_worker.finished.connect(self._global_update_thread.quit)
        self._global_update_worker.finished.connect(self._global_update_worker.deleteLater)
        self._global_update_thread.finished.connect(self._global_update_thread.deleteLater)
        self._global_update_thread.finished.connect(self._on_global_execute_thread_finished)
        self._global_update_thread.start()

    def _on_global_execute_finished(self, attempted: int, failed: int) -> None:
        self._root._notify_feeder_directory_changed()
        QMessageBox.information(
            self,
            "Global Execute Complete",
            (
                f"Global execute dispatched {attempted} update(s).\n"
                f"Failures skipped: {failed}\n\n"
                "Entries without AI IDs were skipped automatically."
            ),
        )

    def _on_global_execute_thread_finished(self) -> None:
        self._global_update_worker = None
        self._global_update_thread = None
        self.global_execute_btn.setEnabled(True)
        self.global_execute_btn.setToolTip("Update all kins on server (skip failures)")

    def _extract_ai_id(self, response: str) -> str:
        text = response.strip()
        if not text:
            return ""
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                for key in ("ai_id", "id", "data"):
                    value = parsed.get(key)
                    if isinstance(value, str) and value.strip():
                        return value.strip()
        except json.JSONDecodeError:
            pass
        return text.splitlines()[-1].strip()

    def _push_update_kin(self, *, api_key: str, person: dict, ai_id: str) -> tuple[bool, str, str]:
        payload = self._build_update_kin_payload(person=person, ai_id=ai_id)
        if not payload:
            return False, "No payload", "Missing required update data."
        ok, status_text, response_text = feeder.execute_api_request(
            tool_key="update_kin",
            api_key=api_key,
            payload=payload,
            requester="KINDROIDXL-DIRECTORY-UPDATE",
        )
        return ok, status_text, response_text

    def _build_update_kin_payload(self, *, person: dict, ai_id: str) -> dict[str, object]:
        temperature_raw = str(person.get("temperature", "")).strip() or self.DEFAULT_EMPTY_VALUES["temperature"]
        reasoning_effort = str(person.get("reasoning_effort", "")).strip() or self.DEFAULT_EMPTY_VALUES["reasoning_effort"]
        llm_flair = str(person.get("llm_flair", "")).strip() or self.DEFAULT_EMPTY_VALUES["llm_flair"]
        try:
            temperature_value: float | str = float(temperature_raw)
        except ValueError:
            temperature_value = temperature_raw
        payload = {
            "ai_id": ai_id,
            "ai_name": str(person.get("name", "")).strip(),
            "ai_gender": str(person.get("gender", "")).strip(),
            "ai_backstory": str(person.get("backstory", "")).strip(),
            "ai_memory": str(person.get("ai_memory", "")).strip(),
            "ai_directive": str(person.get("directive", "")).strip(),
            "ai_additional_context": str(person.get("additional_context", "")).strip(),
            "user_set_temperature": temperature_value,
            "reasoning_effort": reasoning_effort,
            "llm_flair": llm_flair,
        }
        return {k: v for k, v in payload.items() if v not in ("", None)}

    def _replay_memories_by_name(self, *, api_key: str, person_name: str, ai_id: str, mode: str) -> int:
        entries, doc_path, local_path = self._root.load_journal_entries()
        matching_indexes = [idx for idx, item in enumerate(entries) if str(item.get("name", "")).strip() == person_name]
        if mode == "all":
            for idx in matching_indexes:
                entries[idx]["memory_status"] = "forgotten"
        fed = 0
        for idx in matching_indexes:
            item = entries[idx]
            if str(item.get("memory_status", "")) != "forgotten":
                continue
            keyphrases = [k.strip() for k in item.get("keyphrases", []) if isinstance(k, str) and k.strip()]
            if not keyphrases:
                keyphrases = ["memory"]
            ok, _, _ = feeder.execute_api_request(
                tool_key="create_journal_entry",
                api_key=api_key,
                payload={"ai_id": ai_id, "entry": str(item.get("entry", "")).strip(), "keyphrases": keyphrases},
                requester="KINDROIDXL-DIRECTORY-JOURNAL-REPLAY",
            )
            if not ok:
                break
            entries[idx]["memory_status"] = "in_memory"
            entries[idx]["last_fed_at"] = journal.datetime.now(journal.timezone.utc).isoformat()
            fed += 1
            self._root.save_journal_entries(entries, doc_path, local_path)
            QApplication.processEvents()
            time.sleep(0.4)
        self._root.save_journal_entries(entries, doc_path, local_path)
        return fed


class LocationsTab(QWidget):
    IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}

    def __init__(self, parent: "KindroidMainWindow") -> None:
        super().__init__(parent)
        self._root = parent
        self._current_index: int | None = None
        self._visible_location_names: list[str] = []
        self._build_ui()
        self.refresh_entries()

    def _build_ui(self) -> None:
        self.setStyleSheet("""
            LocationsTab { background:#050713; color:#eef5ff; }
            QListWidget#locationsList {
                background:#07101f; border:1px solid #243b67; border-radius:18px; padding:10px;
                color:#dce9ff; font-size:15px; font-weight:800;
            }
            QListWidget#peopleNowList {
                background:#070b16; border:1px solid #24436f; border-radius:18px; padding:10px;
                color:#f6fbff; font-size:16px; font-weight:850;
            }
            QListWidget#peopleNowList::item { padding:14px; border-bottom:1px solid #1b2c4c; border-radius:12px; }
            QLineEdit, QTextEdit {
                background:#080e1c; border:1px solid #2a416b; border-radius:14px; color:#f3f7ff; padding:10px;
            }
            QPushButton {
                background:qlineargradient(x1:0,y1:0,x2:1,y2:0, stop:0 #123b79, stop:1 #7c2dff);
                border:1px solid #5d8cff; border-radius:14px; color:white; font-weight:900; padding:10px 14px;
            }
            QPushButton:hover { border-color:#9df2ff; background:#1b4ea3; }
        """)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(28, 28, 28, 28)
        layout.setSpacing(22)

        left = QVBoxLayout()
        left.setSpacing(12)
        title = QLabel("LOCATIONS", self)
        title.setStyleSheet("font-size: 32px; font-weight: 950; color: #ffffff; letter-spacing: 3px;")
        subtitle = QLabel(
            "Modern location command center — image-first place view with large presence cards from DIRECTORY / GROUPMAKER positions.",
            self,
        )
        subtitle.setWordWrap(True)
        subtitle.setStyleSheet("color:#9fb7df; font-size:13px; font-weight:700;")
        self.locations_list = QListWidget(self)
        self.locations_list.setObjectName("locationsList")
        self.locations_list.currentRowChanged.connect(self._on_location_selected)
        add_btn = QPushButton("Add Location", self)
        add_btn.clicked.connect(self._add_location)
        remove_btn = QPushButton("Remove Location", self)
        remove_btn.clicked.connect(self._remove_location)

        left.addWidget(title)
        left.addWidget(subtitle)
        left.addWidget(self.locations_list, 1)
        left.addWidget(add_btn)
        left.addWidget(remove_btn)
        left.setStretch(2, 1)

        right = QVBoxLayout()
        right.setSpacing(12)
        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignmentFlag.AlignLeft)
        self.name_input = QLineEdit(self)
        self.name_input.textChanged.connect(self._save_current_entry)
        form.addRow("NAME", self.name_input)
        self.description_input = QTextEdit(self)
        self.description_input.setMinimumHeight(110)
        self.description_input.textChanged.connect(self._save_current_entry)
        form.addRow("DESCRIPTION", self.description_input)
        right.addLayout(form)
        self.history_box = QTextEdit(self)
        self.history_box.setReadOnly(True)
        self.history_box.setMinimumHeight(120)
        self.history_box.setPlaceholderText("GROUPMAKER events that happened here will appear here.")
        form.addRow("EVENT HISTORY", self.history_box)
        picture_label = QLabel("Dominant Location Image", self)
        picture_label.setStyleSheet("font-size:18px; font-weight:950; color:#ffffff; letter-spacing:1px;")
        right.addWidget(picture_label)
        self.preview_label = QLabel("No picture selected", self)
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview_label.setMinimumHeight(390)
        self.preview_label.setStyleSheet(
            "border:2px solid #345c9c; border-radius:24px; background:#02040b; color:#9ab0d8; padding:12px; font-size:18px; font-weight:900;"
        )
        right.addWidget(self.preview_label, 1)

        image_row = QHBoxLayout()
        upload_btn = QPushButton("Upload Picture", self)
        upload_btn.clicked.connect(self._upload_picture)
        clear_btn = QPushButton("Clear Picture", self)
        clear_btn.clicked.connect(self._clear_picture)
        image_row.addWidget(upload_btn)
        image_row.addWidget(clear_btn)
        image_row.addStretch(1)
        right.addLayout(image_row)
        people_label = QLabel("WHO IS PRESENT", self)
        people_label.setStyleSheet("font-size:20px; font-weight:950; color:#9df2ff; letter-spacing:2px;")
        right.addWidget(people_label)
        self.people_now_list = QListWidget(self)
        self.people_now_list.setObjectName("peopleNowList")
        self.people_now_list.setIconSize(QSize(82, 82))
        self.people_now_list.setStyleSheet(
            """
            QListWidget {
                border:1px solid #1d2437;
                border-radius:12px;
                background:#090c15;
                padding:12px;
            }
            QListWidget::item {
                padding:16px;
                border-bottom:1px solid #1a2233;
            }
            """
        )
        right.addWidget(self.people_now_list, 1)
        self.create_groupmaker_event_btn = QPushButton("Create Event via GROUPMAKER", self)
        self.create_groupmaker_event_btn.clicked.connect(self._create_groupmaker_event_for_location)
        right.addWidget(self.create_groupmaker_event_btn)

        layout.addLayout(left, 1)
        layout.addLayout(right, 2)


    @staticmethod
    def _sanitize_filename_stem(raw_name: str) -> str:
        clean = re.sub(r"[^A-Za-z0-9._-]+", "_", str(raw_name or "").strip())
        return clean.strip("._-") or "location"

    @staticmethod
    def _normalize_location_name(raw_name: str) -> str:
        return str(raw_name or "").strip().upper()

    @staticmethod
    def _normalized_property_value(raw_value: object) -> int:
        try:
            parsed = int(raw_value or 0)
        except (TypeError, ValueError):
            parsed = random.randint(500_000, 5_000_000)
        return max(500_000, min(5_000_000, parsed))

    @staticmethod
    def _safe_nonnegative_int(raw_value: object, default: int = 0) -> int:
        try:
            parsed = int(raw_value or 0)
        except (TypeError, ValueError):
            parsed = default
        return max(0, parsed)

    @staticmethod
    def _parse_money(value: object, *, default: int = 0) -> int:
        try:
            return max(0, int(value or 0))
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _random_location_value() -> int:
        return random.randint(500_000, 5_000_000)

    def refresh_directory_people(self) -> None:
        self.refresh_entries()

    @staticmethod
    def _event_occurs_on_date(event: dict, target_date: date) -> bool:
        raw_date = str(event.get("date", "")).strip()
        try:
            start_date = date.fromisoformat(raw_date)
        except ValueError:
            return False
        if target_date < start_date:
            return False
        mode = str(event.get("repeat_mode", "none")).strip().lower()
        weekday = target_date.weekday()
        if mode == "weekdays":
            return weekday <= 4
        if mode == "weekends":
            return weekday >= 5
        if mode == "all_week":
            return True
        return target_date == start_date

    def _events_happening_now(self) -> list[dict]:
        now = datetime.now()
        today = now.date()
        current_hour = now.hour
        raw = self._root.config.get("calendar_events", [])
        if not isinstance(raw, list):
            return []
        active: list[dict] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            location = self._normalize_location_name(str(item.get("location", "")).strip())
            if not location:
                continue
            try:
                start_hour = int(item.get("hour", -1))
                end_hour = int(item.get("end_hour", start_hour + 1))
            except (TypeError, ValueError):
                continue
            if end_hour <= start_hour:
                end_hour = min(start_hour + 1, 24)
            if start_hour <= current_hour < end_hour and self._event_occurs_on_date(item, today):
                active.append({**item, "location": location})
        return active

    def _active_location_keys(self) -> set[str]:
        return set()

    def refresh_entries(self) -> None:
        entries = self._root.get_location_entries()
        active_keys = self._active_location_keys()
        entries = sorted(
            entries,
            key=lambda entry: (
                0 if str(entry.get("name", "")).strip().casefold() in active_keys else 1,
                str(entry.get("name", "")).strip(),
            ),
        )
        current_name = ""
        if self._current_index is not None and 0 <= self._current_index < self.locations_list.count():
            current_item = self.locations_list.item(self._current_index)
            if current_item is not None:
                current_name = current_item.text().strip()

        self.locations_list.blockSignals(True)
        self.locations_list.clear()
        self._visible_location_names = []
        for entry in entries:
            label = str(entry.get("name", "")).strip() or "UNTITLED"
            prefix = "🟢 " if label.casefold() in active_keys else ""
            self.locations_list.addItem(f"{prefix}{label}")
            self._visible_location_names.append(label)
        self.locations_list.blockSignals(False)
        if entries:
            target = 0
            if current_name:
                for idx in range(self.locations_list.count()):
                    name = self.locations_list.item(idx).text().removeprefix("🟢 ").strip()
                    if name == current_name.removeprefix("🟢 ").strip():
                        target = idx
                        break
            self.locations_list.setCurrentRow(target)
        else:
            self._current_index = None
            self.name_input.blockSignals(True)
            self.name_input.clear()
            self.name_input.blockSignals(False)
            self.description_input.blockSignals(True)
            self.description_input.clear()
            self.description_input.blockSignals(False)
            if hasattr(self, "history_box"):
                self.history_box.clear()
            self._refresh_preview(None)
            self.people_now_list.clear()
            self._visible_location_names = []

    def _entry_data(self) -> list[dict]:
        return self._root.get_location_entries()

    def _selected_location_name(self) -> str:
        if self._current_index is None:
            return ""
        if 0 <= self._current_index < len(self._visible_location_names):
            return self._normalize_location_name(self._visible_location_names[self._current_index])
        current_item = self.locations_list.currentItem()
        if current_item is None:
            return ""
        return self._normalize_location_name(current_item.text().removeprefix("🟢 ").strip())

    def _selected_entry_index(self, entries: list[dict]) -> int:
        selected_name = self._selected_location_name()
        if not selected_name:
            return -1
        selected_key = selected_name.casefold()
        for idx, entry in enumerate(entries):
            if not isinstance(entry, dict):
                continue
            if self._normalize_location_name(str(entry.get("name", ""))).casefold() == selected_key:
                return idx
        return -1

    def _on_location_selected(self, row: int) -> None:
        self._current_index = row
        entries = self._entry_data()
        if row < 0 or row >= len(self._visible_location_names):
            self._current_index = None
            return
        selected_name = self._normalize_location_name(self._visible_location_names[row])
        item_index = -1
        for idx, item in enumerate(entries):
            if not isinstance(item, dict):
                continue
            if self._normalize_location_name(str(item.get("name", ""))) == selected_name:
                item_index = idx
                break
        if item_index < 0:
            return
        item = entries[item_index]
        self.name_input.blockSignals(True)
        self.name_input.setText(str(item.get("name", "")).strip())
        self.name_input.blockSignals(False)
        self.description_input.blockSignals(True)
        self.description_input.setPlainText(str(item.get("description", "")).strip())
        self.description_input.blockSignals(False)
        self._refresh_event_history(item)
        image_path = str(item.get("image_path", "")).strip()
        self._refresh_preview(image_path if image_path else None)
        self._refresh_people_now(str(item.get("name", "")).strip())

    def _save_current_entry(self) -> None:
        entries = self._entry_data()
        item_index = self._selected_entry_index(entries)
        if item_index < 0:
            return
        updated_name = self._normalize_location_name(self.name_input.text())
        if not updated_name:
            return
        entries[item_index]["name"] = updated_name
        entries[item_index]["description"] = self.description_input.toPlainText().strip()
        self._root.save_location_entries(entries)
        self.locations_list.blockSignals(True)
        current_item = self.locations_list.item(self._current_index) if self._current_index is not None else None
        if current_item is not None:
            current_item.setText(updated_name)
        if self._current_index is not None and 0 <= self._current_index < len(self._visible_location_names):
            self._visible_location_names[self._current_index] = updated_name
        self.locations_list.blockSignals(False)
        self._refresh_people_now(updated_name)

    def _add_location(self) -> None:
        name, ok = QInputDialog.getText(self, "New Location", "NAME:")
        if not ok:
            return
        clean = self._normalize_location_name(name)
        if not clean:
            QMessageBox.warning(self, "Missing Name", "Location name is required.")
            return
        entries = self._entry_data()
        names = {str(item.get("name", "")).strip().casefold() for item in entries if isinstance(item, dict)}
        if clean.casefold() in names:
            QMessageBox.information(self, "Exists", f"'{clean}' is already listed.")
            return
        entries.append(
            {
                "name": clean,
                "description": "",
                "image_file": "",
                "image_path": "",
                "source": "manual",
            }
        )
        self._root.save_location_entries(entries)
        self.refresh_entries()
        self.locations_list.setCurrentRow(len(entries) - 1)

    def _remove_location(self) -> None:
        entries = self._entry_data()
        item_index = self._selected_entry_index(entries)
        if item_index < 0:
            return
        victim = entries[item_index]
        confirm = QMessageBox.question(
            self,
            "Delete Location",
            f"Delete {str(victim.get('name', 'this location')).strip() or 'this location'} from LOCATIONS?",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        del entries[item_index]
        self._root.save_location_entries(entries)
        self.refresh_entries()

    def _upload_picture(self) -> None:
        entries = self._entry_data()
        item_index = self._selected_entry_index(entries)
        if item_index < 0:
            QMessageBox.warning(self, "Select Location", "Select a location first.")
            return
        location_name = self._normalize_location_name(str(entries[item_index].get("name", "")).strip()) or "LOCATION"
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "Select Location Picture",
            str(Path.home()),
            "Image files (*.png *.jpg *.jpeg *.webp *.bmp *.gif);;All files (*)",
        )
        if not file_path:
            return
        source = Path(file_path)
        ext = source.suffix.lower()
        if ext not in self.IMAGE_EXTENSIONS:
            QMessageBox.warning(self, "Invalid File", f"Unsupported image format: {ext or 'unknown'}")
            return
        images_dir = APP_DATA_DIR / "location_images"
        images_dir.mkdir(parents=True, exist_ok=True)
        target = images_dir / f"{self._sanitize_filename_stem(location_name)}{ext}"
        try:
            shutil.copy2(source, target)
        except OSError as exc:
            QMessageBox.warning(self, "Save Failed", f"Could not save image:\n{exc}")
            return
        entries[item_index]["image_file"] = target.name
        entries[item_index]["image_path"] = str(target)
        self._root.save_location_entries(entries)
        self._refresh_preview(str(target))
        self._refresh_people_now(location_name)

    def _clear_picture(self) -> None:
        entries = self._entry_data()
        item_index = self._selected_entry_index(entries)
        if item_index < 0:
            return
        entries[item_index]["image_file"] = ""
        entries[item_index]["image_path"] = ""
        self._root.save_location_entries(entries)
        self._refresh_preview(None)
        self._refresh_people_now(str(entries[item_index].get("name", "")).strip())

    def _refresh_preview(self, image_path: str | None) -> None:
        normalized = str(image_path or "").strip()
        if not normalized:
            self.preview_label.setPixmap(QPixmap())
            self.preview_label.setText("No picture selected")
            return
        pixmap = QPixmap(normalized)
        if pixmap.isNull():
            self.preview_label.setPixmap(QPixmap())
            self.preview_label.setText(f"Image not found:\n{normalized}")
            return
        target_size = self.preview_label.size() if self.preview_label.size().isValid() else QSize(760, 430)
        scaled = pixmap.scaled(target_size, Qt.AspectRatioMode.KeepAspectRatioByExpanding, Qt.TransformationMode.SmoothTransformation)
        self.preview_label.setPixmap(scaled)
        self.preview_label.setText("")

    def _refresh_event_history(self, entry: dict) -> None:
        if not hasattr(self, "history_box"):
            return
        history = entry.get("event_history", []) if isinstance(entry, dict) else []
        if not isinstance(history, list) or not history:
            self.history_box.setPlainText("No GROUPMAKER event history yet for this location.")
            return
        lines: list[str] = []
        for row in reversed(history[-25:]):
            if not isinstance(row, dict):
                continue
            happened_at = str(row.get("created_at", "")).strip()
            participants = str(row.get("participants", "")).strip()
            description = str(row.get("description", "")).strip()
            header = happened_at
            if participants:
                header = f"{header} • {participants}" if header else participants
            if header:
                lines.append(header)
            if description:
                lines.append(f"  {description}")
        self.history_box.setPlainText("\n\n".join(lines) if lines else "No GROUPMAKER event history yet for this location.")

    def _latest_history_description(self, entry: dict) -> str:
        history = entry.get("event_history", []) if isinstance(entry, dict) else []
        if not isinstance(history, list):
            return ""
        for row in reversed(history):
            if isinstance(row, dict):
                description = str(row.get("description", "")).strip()
                if description:
                    return description
        return ""

    def _refresh_people_now(self, location_name: str) -> None:
        target_key = self._normalize_location_name(location_name).casefold()
        self.people_now_list.clear()
        if not target_key:
            return

        participants = self._participants_for_location(target_key)
        for entry, reason in participants:
            self.people_now_list.addItem(self._people_item(entry, reason))

        if self.people_now_list.count() == 0:
            self.people_now_list.addItem("No people currently assigned here.")

    def _participants_for_location(self, target_location_key: str) -> list[tuple[dict, str]]:
        participants: list[tuple[dict, str]] = []
        directory_by_ai_id = {
            str(item.get("ai_id", "")).strip(): item
            for item in self._root.get_directory_entries()
            if isinstance(item, dict) and str(item.get("ai_id", "")).strip()
        }
        added: set[str] = set()
        for entry in self._root.get_directory_entries():
            if not isinstance(entry, dict):
                continue
            if self._normalize_location_name(str(entry.get("position", ""))).casefold() != target_location_key:
                continue
            ai_id = str(entry.get("ai_id", "")).strip()
            if not ai_id or ai_id in added:
                continue
            added.add(ai_id)
            participants.append((entry, "Assigned position"))
        return participants

    def _create_groupmaker_event_for_location(self) -> None:
        entries = self._entry_data()
        item_index = self._selected_entry_index(entries)
        if item_index < 0:
            QMessageBox.warning(self, "Select Location", "Select a location first.")
            return

        location_name = self._normalize_location_name(str(entries[item_index].get("name", "")).strip())
        if not location_name:
            QMessageBox.warning(self, "Missing Location", "Selected location has no valid name.")
            return
        participants = self._participants_for_location(location_name.casefold())
        if not participants:
            QMessageBox.information(
                self,
                "No Participants",
                f"No people found for {location_name} from DIRECTORY position assignments.",
            )
            return

        group_tab = getattr(self._root, "groupmaker_tab", None)
        if group_tab is None:
            QMessageBox.warning(self, "GROUPMAKER Unavailable", "Could not access GROUPMAKER tab.")
            return
        if not all(hasattr(group_tab, attr) for attr in ("status_box", "location_input", "position_input")):
            QMessageBox.warning(self, "GROUPMAKER Unavailable", "GROUPMAKER editor controls are not available.")
            return

        names = [str(entry.get("name", "")).strip() for entry, _reason in participants if str(entry.get("name", "")).strip()]
        names_text = ", ".join(dict.fromkeys(names))
        description = str(entries[item_index].get("description", "")).strip() or self._latest_history_description(entries[item_index])
        status = description or f"{names_text} are currently at {location_name}."
        if names_text and names_text.lower() not in status.lower():
            status = f"{status} People: {names_text}."

        if hasattr(group_tab, "names_box"):
            group_tab.names_box.setPlainText(names_text)
        group_tab.location_input.setText(description[:80] if description else "")
        group_tab.position_input.setText(location_name)
        group_tab.status_box.setPlainText(status)

        if hasattr(group_tab, "_sync_from_text"):
            group_tab._sync_from_text()  # pylint: disable=protected-access
        elif hasattr(group_tab, "sync_btn"):
            group_tab.sync_btn.click()

        if hasattr(self._root, "tabs"):
            index = self._root.tabs.indexOf(group_tab)
            if index >= 0:
                self._root.tabs.setCurrentIndex(index)

    def _people_item(self, entry: dict, reason: str) -> QListWidgetItem:
        name = str(entry.get("name", "")).strip() or "Unnamed person"
        pregnant = self._root.is_entry_pregnant(entry)
        indicator = " • pregnant" if pregnant else ""
        item = QListWidgetItem(f"{name}{indicator}\n{reason}")
        if pregnant:
            item.setBackground(QColor("#2a0e29"))
            item.setForeground(QColor("#ffd7f6"))
        photo = self._latest_photo_for_person(entry)
        if photo is not None:
            thumb = photo.scaled(82, 82, Qt.AspectRatioMode.KeepAspectRatioByExpanding, Qt.TransformationMode.SmoothTransformation)
            item.setIcon(QIcon(thumb))
        item.setSizeHint(QSize(260, 96))
        return item

    @staticmethod
    def _latest_photo_for_person(entry: dict) -> QPixmap | None:
        album = entry.get("album_photos", [])
        if not isinstance(album, list):
            return None
        candidates: list[Path] = []
        for raw in album:
            path = Path(str(raw).strip())
            if path.exists() and path.is_file():
                candidates.append(path)
        if not candidates:
            return None
        latest = max(candidates, key=lambda candidate: candidate.stat().st_mtime)
        pix = QPixmap(str(latest))
        return pix if not pix.isNull() else None


class LevelIndicator(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._level = 0.0
        self.setMinimumHeight(18)

    def set_level(self, level: float) -> None:
        self._level = max(0.0, min(level, 1.0))
        self.update()

    def paintEvent(self, _event) -> None:  # type: ignore[override]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        painter.setBrush(QColor("#2f2f2f"))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawRoundedRect(0, 0, w, h, 6, 6)
        fill_w = int(w * self._level)
        color = QColor("#37d67a") if self._level < 0.75 else QColor("#ffb020")
        if self._level > 0.92:
            color = QColor("#ff4d4f")
        painter.setBrush(color)
        painter.drawRoundedRect(0, 0, fill_w, h, 6, 6)


class CommunicationAudioWorker(QObject):
    level_changed = Signal(float)
    error = Signal(str)

    def __init__(self) -> None:
        super().__init__()
        self._running = False

    @Slot(str)
    def start_capture(self, _target_name: str) -> None:
        if self._running:
            return
        self._running = True
        com_initialized = False
        try:
            if os.name == "nt":
                coinit_apartment = 0x2
                result = ctypes.windll.ole32.CoInitializeEx(None, coinit_apartment)
                # S_OK (0) and S_FALSE (1) must be balanced with CoUninitialize().
                # RPC_E_CHANGED_MODE (0x80010106) means COM is already initialized for
                # this thread in another apartment model, so do not uninitialize it here.
                com_initialized = result in (0, 1)
            # Import WASAPI-backed audio libraries only inside the capture worker.
            # Importing soundcard on the GUI thread can initialize COM before Qt,
            # which makes QApplication/OleInitialize fail with RPC_E_CHANGED_MODE.
            import numpy as np
            import soundcard as sc

            warnings.filterwarnings("ignore", message="data discontinuity in recording")
            default_speaker = sc.default_speaker()
            if default_speaker is None:
                self.error.emit("No default speaker found.")
                self._running = False
                return
            loop_mic = sc.get_microphone(id=str(default_speaker.id), include_loopback=True)
            with loop_mic.recorder(samplerate=48000, channels=2, blocksize=1024) as recorder:
                while self._running:
                    data = recorder.record(numframes=1024)
                    if getattr(data, "size", 0) == 0:
                        self.level_changed.emit(0.0)
                        continue
                    rms = float(np.sqrt(np.mean(np.square(data))))
                    self.level_changed.emit(min(rms * 8.0, 1.0))
        except Exception as exc:  # pylint: disable=broad-except
            self.error.emit(f"Capture runtime error: {exc}")
        finally:
            if os.name == "nt" and com_initialized:
                try:
                    ctypes.windll.ole32.CoUninitialize()
                except Exception:  # pylint: disable=broad-except
                    pass
            self._running = False

    @Slot()
    def stop_capture(self) -> None:
        self._running = False

class SettingsTab(QWidget):
    def __init__(self, parent: "KindroidMainWindow") -> None:
        super().__init__(parent)
        self._root = parent
        self._path_labels: dict[str, QLabel] = {}
        self._build_ui()
        self.refresh_values()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 28, 28, 28)
        layout.setSpacing(14)

        title = QLabel("SETTINGS", self)
        title.setStyleSheet("font-size: 20px; font-weight: 800; color: #f6f8ff;")

        subtitle = QLabel(
            "Configure Kindroid call SFX in the desktop app. This replaces website sounds without injecting settings UI into Kindroid.",
            self,
        )
        subtitle.setWordWrap(True)
        subtitle.setStyleSheet("color:#aeb7d3;")

        panel = QWidget(self)
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(14, 14, 14, 14)
        panel_layout.setSpacing(12)
        panel.setStyleSheet("border: 1px solid #1d2437; border-radius: 12px; background: #090c15;")

        panel_title = QLabel("Call SFX", panel)
        panel_title.setStyleSheet("font-size: 16px; font-weight: 800; color:#f6f8ff;")
        panel_layout.addWidget(panel_title)

        for target in CALL_SFX_TARGETS:
            row = QWidget(panel)
            row_layout = QHBoxLayout(row)
            row_layout.setContentsMargins(0, 0, 0, 0)
            row_layout.setSpacing(8)

            info = QVBoxLayout()
            info.setSpacing(2)
            label = QLabel(f"{target['label']} ({target['key']})", row)
            label.setStyleSheet("font-weight:700; color:#e9f1ff;")
            desc = QLabel(target["description"], row)
            desc.setStyleSheet("font-size:11px; color:#9ab0d8;")
            desc.setWordWrap(True)
            path_label = QLabel("Using Kindroid default sound", row)
            path_label.setStyleSheet("font-size:11px; color:#93c5fd;")
            path_label.setWordWrap(True)
            self._path_labels[target["key"]] = path_label
            info.addWidget(label)
            info.addWidget(desc)
            info.addWidget(path_label)

            actions = QVBoxLayout()
            actions.setSpacing(6)
            upload_btn = QPushButton("Upload", row)
            upload_btn.clicked.connect(lambda _checked=False, key=target["key"]: self._choose_file(key))
            clear_btn = QPushButton("Clear", row)
            clear_btn.clicked.connect(lambda _checked=False, key=target["key"]: self._clear_file(key))
            test_btn = QPushButton("Test", row)
            test_btn.clicked.connect(lambda _checked=False, key=target["key"]: self._test_sound(key))
            actions.addWidget(upload_btn)
            actions.addWidget(clear_btn)
            actions.addWidget(test_btn)

            row_layout.addLayout(info, 1)
            row_layout.addLayout(actions)
            panel_layout.addWidget(row)

        note = QLabel(
            "Changes are applied by reloading the embedded browser with a runtime-only audio replacement hook.",
            panel,
        )
        note.setWordWrap(True)
        note.setStyleSheet("font-size:11px; color:#b8c4de;")
        panel_layout.addWidget(note)

        comm_panel = QWidget(self)
        comm_layout = QVBoxLayout(comm_panel)
        comm_layout.setContentsMargins(14, 14, 14, 14)
        comm_layout.setSpacing(8)
        comm_panel.setStyleSheet("border: 1px solid #1d2437; border-radius: 12px; background: #090c15;")
        comm_title = QLabel("Communication Mode", comm_panel)
        comm_title.setStyleSheet("font-size: 16px; font-weight: 800; color:#f6f8ff;")
        comm_desc = QLabel("Route Kindroid call input to shared system/window audio instead of default mic when enabled.", comm_panel)
        comm_desc.setWordWrap(True)
        comm_desc.setStyleSheet("font-size:11px; color:#b8c4de;")
        self.comm_mode_settings_toggle = QCheckBox("Enable Communication Mode", comm_panel)
        self.comm_mode_settings_toggle.toggled.connect(self._sync_comm_toggle_to_kindroid_panel)
        self.comm_mode_settings_target = QComboBox(comm_panel)
        self.comm_mode_settings_target.currentIndexChanged.connect(self._sync_comm_target_to_kindroid_panel)
        self.comm_mode_settings_status = QLabel("", comm_panel)
        self.comm_mode_settings_indicator = LevelIndicator(comm_panel)
        self.comm_mode_settings_status.setWordWrap(True)
        self.comm_mode_settings_status.setStyleSheet("font-size:11px; color:#93c5fd;")
        comm_layout.addWidget(comm_title)
        comm_layout.addWidget(comm_desc)
        comm_layout.addWidget(self.comm_mode_settings_toggle)
        comm_layout.addWidget(self.comm_mode_settings_target)
        comm_layout.addWidget(QLabel("Audio Detector", comm_panel))
        comm_layout.addWidget(self.comm_mode_settings_indicator)
        comm_layout.addWidget(self.comm_mode_settings_status)

        backup_panel = QWidget(self)
        backup_layout = QVBoxLayout(backup_panel)
        backup_layout.setContentsMargins(14, 14, 14, 14)
        backup_layout.setSpacing(10)
        backup_panel.setStyleSheet("border: 1px solid #1d2437; border-radius: 12px; background: #090c15;")

        backup_title = QLabel("Backup & Restore", backup_panel)
        backup_title.setStyleSheet("font-size: 16px; font-weight: 800; color:#f6f8ff;")
        backup_desc = QLabel(
            "Automatic safety backups now store critical JSON/journal state once per day instead of copying the full browser/media profile every 30 minutes. "
            "Use Export Full Backup when you intentionally want a complete archive including profile data and media assets.",
            backup_panel,
        )
        backup_desc.setWordWrap(True)
        backup_desc.setStyleSheet("font-size:11px; color:#b8c4de;")
        backup_actions = QHBoxLayout()
        export_backup_btn = QPushButton("Export Full Backup", backup_panel)
        export_backup_btn.clicked.connect(self._export_full_backup)
        restore_backup_btn = QPushButton("Restore Full Backup", backup_panel)
        restore_backup_btn.clicked.connect(self._restore_full_backup)
        backup_actions.addWidget(export_backup_btn)
        backup_actions.addWidget(restore_backup_btn)
        backup_actions.addStretch(1)
        backup_layout.addWidget(backup_title)
        backup_layout.addWidget(backup_desc)
        backup_layout.addLayout(backup_actions)

        layout.addWidget(title)
        layout.addWidget(subtitle)
        layout.addWidget(panel)
        layout.addWidget(comm_panel)
        layout.addWidget(backup_panel)
        layout.addStretch(1)

    def refresh_values(self) -> None:
        self._sync_communication_mode_controls()
        mapping = self._root.get_call_sfx_files()
        for key, label in self._path_labels.items():
            path = mapping.get(key, "")
            if path:
                label.setText(f"Loaded: {path}")
            else:
                label.setText("Using Kindroid default sound")

    def _sync_comm_toggle_to_kindroid_panel(self, enabled: bool) -> None:
        self._root.communication_mode_toggle.setChecked(enabled)

    def _sync_comm_target_to_kindroid_panel(self) -> None:
        data = self.comm_mode_settings_target.currentData()
        idx = self._root.communication_target_combo.findData(data)
        if idx >= 0:
            self._root.communication_target_combo.setCurrentIndex(idx)

    def _sync_communication_mode_controls(self) -> None:
        root_toggle = getattr(self._root, "communication_mode_toggle", None)
        root_target = getattr(self._root, "communication_target_combo", None)
        root_status = getattr(self._root, "communication_status_label", None)
        if root_toggle is None or root_target is None or root_status is None:
            return
        self.comm_mode_settings_toggle.blockSignals(True)
        self.comm_mode_settings_toggle.setChecked(root_toggle.isChecked())
        self.comm_mode_settings_toggle.blockSignals(False)
        self.comm_mode_settings_target.blockSignals(True)
        self.comm_mode_settings_target.clear()
        for i in range(root_target.count()):
            self.comm_mode_settings_target.addItem(root_target.itemText(i), root_target.itemData(i))
        idx = self.comm_mode_settings_target.findData(root_target.currentData())
        if idx >= 0:
            self.comm_mode_settings_target.setCurrentIndex(idx)
        self.comm_mode_settings_target.blockSignals(False)
        self.comm_mode_settings_status.setText(root_status.text())
        self.comm_mode_settings_indicator.set_level(getattr(self._root, "_communication_audio_level", 0.0))

    def _choose_file(self, target_key: str) -> None:
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            f"Select sound for {target_key}",
            str(Path.home()),
            "Audio files (*.mp3 *.wav *.m4a *.ogg *.flac *.aac *.wma);;All files (*)",
        )
        if not file_path:
            return
        try:
            self._root.set_call_sfx_file(target_key, file_path)
        except OSError as exc:
            QMessageBox.warning(self, "Upload failed", f"Could not save custom sound:\n{exc}")
            return
        self.refresh_values()

    def _clear_file(self, target_key: str) -> None:
        self._root.set_call_sfx_file(target_key, "")
        self.refresh_values()

    def _test_sound(self, target_key: str) -> None:
        encoded = self._root._call_sfx_data_url_for_target(target_key)
        if not encoded:
            QMessageBox.information(self, "No custom file", "No custom audio is set for this target.")
            return
        escaped = json.dumps(encoded)
        self._root.webview.page().runJavaScript(
            f"(() => {{ const audio = new Audio({escaped}); audio.volume = 1; audio.play().catch(() => null); }})();"
        )

    def _export_full_backup(self) -> None:
        self._root.export_full_backup()

    def _restore_full_backup(self) -> None:
        self._root.restore_full_backup()


class LightModeWindow(QMainWindow):
    """Low-impact shell with a live KINDROID page and GROUPMAKER controls."""

    def __init__(self, main_window: "KindroidMainWindow") -> None:
        super().__init__()
        self.main_window = main_window
        self._closed_by_restore = False
        self._original_webview = main_window.webview
        self._original_webpage = main_window.webpage
        self.setWindowTitle("KINDROIDXL Light Mode")
        self.setMinimumSize(1100, 640)
        self.resize(1320, 760)

        current_url = self._original_webview.url() if hasattr(self._original_webview, "url") else QUrl(TARGET_URL)
        if not current_url.isValid() or not current_url.toString():
            current_url = QUrl(TARGET_URL)

        self.light_webview = QWebEngineView(self)
        self.light_webpage = KindroidWebPage(main_window.profile, self.light_webview)
        main_window.webview = self.light_webview
        main_window.webpage = self.light_webpage
        main_window._enable_web_capture_settings()
        self.light_webpage.featurePermissionRequested.connect(main_window._handle_feature_permission_request)
        desktop_media_signal = getattr(self.light_webpage, "desktopMediaRequested", None)
        if desktop_media_signal is not None:
            desktop_media_signal.connect(main_window._handle_desktop_media_request)
        audible_signal = getattr(self.light_webpage, "recentlyAudibleChanged", None)
        if audible_signal is not None:
            audible_signal.connect(main_window._on_kindroid_recently_audible_changed)
        self.light_webview.setPage(self.light_webpage)
        self.light_webview.setUrl(current_url)
        self.light_webview.urlChanged.connect(main_window._on_kindroid_url_changed)

        self.setCentralWidget(self.light_webview)

        restore = QPushButton("EXIT LIGHT MODE", self)
        restore.clicked.connect(self.restore_main_window)
        self.statusBar().addPermanentWidget(restore)
        self.statusBar().showMessage("Light Mode: only the live KINDROID web panel is running; heavy GROUPMAKER UI, probes, and transcript capture are disabled.")

    def restore_main_window(self) -> None:
        if self._closed_by_restore:
            return
        self._closed_by_restore = True
        current_url = self.light_webview.url() if hasattr(self.light_webview, "url") else QUrl(TARGET_URL)
        self.main_window.webview = self._original_webview
        self.main_window.webpage = self._original_webpage
        if current_url.isValid() and current_url.toString():
            self._original_webview.setUrl(current_url)
        self.light_webpage.deleteLater()
        self.light_webview.deleteLater()
        self.main_window.exit_light_mode()
        if not self.isHidden():
            self.close()

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt override
        self.restore_main_window()
        event.accept()


class KindroidMainWindow(QMainWindow):
    _comm_start_signal = Signal(str)
    _comm_stop_signal = Signal()
    @staticmethod
    def _normalized_property_value(raw_value: object) -> int:
        try:
            parsed = int(raw_value or 0)
        except (TypeError, ValueError):
            parsed = random.randint(500_000, 5_000_000)
        return max(500_000, min(5_000_000, parsed))

    @staticmethod
    def _safe_nonnegative_int(raw_value: object, default: int = 0) -> int:
        try:
            parsed = int(raw_value or 0)
        except (TypeError, ValueError):
            parsed = default
        return max(0, parsed)

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("KINDROIDXL")
        self.setMinimumSize(960, 540)
        self.resize(*self._default_window_size())
        self._center_window_on_primary_screen()
        self._window_geometry_ready = False
        self._did_initial_fit_check = False
        self._restore_maximized_on_first_show = False
        self._is_quitting = False
        self._closing_for_groupmaker_remote = False
        self._tray_hide_notice_shown = False
        self.tray_icon: QSystemTrayIcon | None = None
        self.remote_tray_icon: QSystemTrayIcon | None = None
        self._random_send_thread: QThread | None = None
        self._random_send_worker: FetchSendWorker | None = None
        self._pending_random_send_context: dict[str, object] | None = None
        self._tab_recording_active = False
        self.lightweight_mode = False
        self._light_mode_window: LightModeWindow | None = None
        self._last_launcher_command_id = ""
        self._conversation_mode_active = False

        APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
        DOCUMENTS_KINDROID_BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        JAVASCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
        self.config = self._load_config()
        self._documents_backup_interval_ms = max(1, int(self.config.get("documents_backup_interval_minutes", 5) or 5)) * 60 * 1000
        self._documents_backup_retention = max(1, int(self.config.get("documents_backup_retention", 7) or 7))
        self._documents_full_backup_retention = max(0, int(self.config.get("documents_full_backup_retention", 1) or 1))
        self._documents_backup_mode = str(self.config.get("documents_backup_mode", "critical")).strip().casefold() or "critical"
        self._communication_mode_enabled = bool(self.config.get("communication_mode_enabled", False))
        self._communication_target_app = str(self.config.get("communication_target_app", "")).strip()
        self._communication_audio_level = 0.0
        self._communication_avatar_session_nonce = 0
        self._communication_avatar_window_requested = False
        self._restore_lifeline_memory_database_from_safety_backup()
        self._lifeline_memory_manager_process = None
        self._communication_avatar_pair_by_url: dict[str, dict[str, str]] = {}
        raw_pair_locks = self.config.get("communication_avatar_pair_locks", {})
        self._communication_avatar_pair_locks: dict[str, dict[str, object]] = raw_pair_locks if isinstance(raw_pair_locks, dict) else {}
        self._documents_backup_timer = QTimer(self)
        self._documents_backup_timer.setInterval(self._documents_backup_interval_ms)
        self._documents_backup_timer.timeout.connect(self._backup_documents_kindroidxl)
        self._documents_backup_timer.start()
        self._backup_documents_kindroidxl()

        self.profile = QWebEngineProfile("kindroid_profile", self)
        self.profile.setPersistentStoragePath(str(PROFILE_DIR))
        self.profile.setCachePath(str(PROFILE_DIR / "cache"))
        self.profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.DiskHttpCache)

        self._apply_cookie_policy(True)
        # Keep the shared browser profile clean.  Add-on/userscript automation is
        # installed only on the GROUPMAKER/COMMS page below so the main CALLS
        # Kindroid panel remains an independent, unmodified Kindroid page.

        self.tabs = QTabWidget(self)
        self.light_mode_btn = QPushButton("LIGHT MODE", self)
        self.light_mode_btn.setToolTip("Switch to a low-impact window with only KINDROID and GROUPMAKER controls.")
        self.light_mode_btn.clicked.connect(self.enter_light_mode)
        self.tabs.setCornerWidget(self.light_mode_btn, Qt.Corner.TopRightCorner)
        self.tabs.tabBar().setUsesScrollButtons(True)
        self.tabs.tabBar().setExpanding(False)
        self.tabs.tabBar().setElideMode(Qt.TextElideMode.ElideNone)
        self.setCentralWidget(self.tabs)

        self.webview = QWebEngineView(self)
        self.webpage = KindroidWebPage(self.profile, self.webview)
        self._enable_web_capture_settings()
        self.webpage.featurePermissionRequested.connect(self._handle_feature_permission_request)
        desktop_media_signal = getattr(self.webpage, "desktopMediaRequested", None)
        if desktop_media_signal is not None:
            desktop_media_signal.connect(self._handle_desktop_media_request)
        audible_signal = getattr(self.webpage, "recentlyAudibleChanged", None)
        if audible_signal is not None:
            audible_signal.connect(self._on_kindroid_recently_audible_changed)
        self.webview.setPage(self.webpage)
        self._inject_local_scripts(self.webpage.scripts())
        self._kindroid_load_in_progress = False
        self._kindroid_load_started_ms = 0
        self._kindroid_reconnect_attempts = 0
        self._kindroid_last_url = QUrl(TARGET_URL)
        self._kindroid_load_watchdog = QTimer(self)
        self._kindroid_load_watchdog.setInterval(45000)
        self._kindroid_load_watchdog.setSingleShot(True)
        self._kindroid_load_watchdog.timeout.connect(self._recover_stuck_kindroid_load)
        self.webview.loadStarted.connect(self._on_kindroid_load_started)
        self.webview.loadFinished.connect(self._on_kindroid_load_finished)
        render_signal = getattr(self.webpage, "renderProcessTerminated", None)
        if render_signal is not None:
            render_signal.connect(self._on_kindroid_render_process_terminated)
        self.webview.setUrl(QUrl(TARGET_URL))
        self.webview.urlChanged.connect(self._on_kindroid_url_changed)

        self.main_kindroid_webview = QWebEngineView(self)
        self.main_kindroid_webpage = KindroidWebPage(self.profile, self.main_kindroid_webview)
        self.main_kindroid_webpage.featurePermissionRequested.connect(self._handle_feature_permission_request)
        main_desktop_media_signal = getattr(self.main_kindroid_webpage, "desktopMediaRequested", None)
        if main_desktop_media_signal is not None:
            main_desktop_media_signal.connect(self._handle_desktop_media_request)
        self.main_kindroid_webview.setPage(self.main_kindroid_webpage)
        self.main_kindroid_webview.setUrl(QUrl(TARGET_URL))
        self._kindroid_audio_probe_script = (APP_ROOT / "modules" / "kindroid_audio_probe.js").read_text(encoding="utf-8")
        self._kindroid_group_probe_script = (
            APP_ROOT / "modules" / "kindroid_group_participant_probe.js"
        ).read_text(encoding="utf-8")
        self._avatar_audio_probe_timer = QTimer(self)
        self._avatar_audio_probe_timer.setInterval(250)
        self._avatar_audio_probe_timer.timeout.connect(self._poll_kindroid_audio_probe)
        self._group_avatar_probe_timer = QTimer(self)
        self._group_avatar_probe_timer.setInterval(500)
        self._group_avatar_probe_timer.timeout.connect(self._poll_kindroid_group_participants)
        self._groupmaker_sync_now_request_timer = QTimer(self)
        self._groupmaker_sync_now_request_timer.setInterval(250)
        self._groupmaker_sync_now_request_timer.timeout.connect(self._poll_groupmaker_sync_now_request)
        self._groupmaker_sync_now_request_timer.start()
        self._group_avatar_candidate_key = ""
        self._group_avatar_candidate_since_ms = 0
        self._group_avatar_loaded_key = ""
        self._group_avatar_last_snapshot = {}
        self._group_avatar_mute_until_ms = 0
        self._group_avatar_force_audio_until_ms = 0
        self._group_avatar_last_forced_audio_key = ""
        self._group_avatar_last_selected_name = ""
        self._group_avatar_last_good_candidate_ms = 0
        self._group_avatar_people_signature = ""
        self._group_avatar_debug_enabled = DEBUG_CONSOLE_OUTPUT and bool(self.config.get("group_avatar_debug_enabled", False))
        self._group_avatar_page_debug_enabled = bool(self.config.get("group_avatar_page_debug_enabled", False))
        self._group_avatar_last_debug_message = ""
        self._group_avatar_window_requested = False
        self._comm_worker_thread = QThread(self)
        self._comm_worker = CommunicationAudioWorker()
        self._comm_worker.moveToThread(self._comm_worker_thread)
        self._comm_worker.level_changed.connect(self._on_communication_audio_level)
        self._comm_worker.error.connect(self._on_communication_audio_error)
        self._comm_start_signal.connect(self._comm_worker.start_capture)
        self._comm_stop_signal.connect(self._comm_worker.stop_capture)
        self._comm_worker_thread.start()

        self.kindroid_tab = QWidget(self)
        self.kindroid_layout = QHBoxLayout(self.kindroid_tab)
        self.kindroid_layout.setContentsMargins(0, 0, 0, 0)
        self.kindroid_layout.setSpacing(12)
        self._kindroid_tab_placeholder = QLabel("Main Kindroid panel: clean page, no KINDROIDXL JavaScript injections.", self.kindroid_tab)
        self._kindroid_tab_placeholder.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._kindroid_tab_placeholder.setStyleSheet("color:#9fb2d7; font-size:12px; font-weight:900; padding:8px;")
        self.kindroid_layout.addWidget(self.main_kindroid_webview, 1)
        self._kindroid_webview_docked_in_control_window = True
        self.communication_avatar_panel = CommunicationAvatarPanel(None)
        self.communication_avatar_panel._root = self
        self.communication_avatar_panel.dismissed.connect(self._on_communication_avatar_dismissed)
        self.communication_avatar_panel.randomize_group_pair_requested.connect(self._randomize_group_communication_pair)

        self.directory_calls_panel = QWidget(self.kindroid_tab)
        self.directory_calls_panel.setFixedWidth(330)
        directory_calls_layout = QVBoxLayout(self.directory_calls_panel)
        directory_calls_layout.setContentsMargins(10, 10, 10, 10)
        directory_calls_layout.setSpacing(10)

        directory_calls_title = QLabel("DIRECTORY CALLS", self.directory_calls_panel)
        directory_calls_title.setStyleSheet("font-size: 14px; font-weight: 900; color: #cde3ff; letter-spacing: 0.6px;")
        directory_calls_subtitle = QLabel("Filter by A-Z or family", self.directory_calls_panel)
        directory_calls_subtitle.setStyleSheet("font-size: 11px; color: #8ca3c9; font-weight: 700;")

        controls_row = QHBoxLayout()
        controls_row.setContentsMargins(0, 0, 0, 0)
        controls_row.setSpacing(8)
        self.directory_filter_combo = QComboBox(self.directory_calls_panel)
        self.directory_filter_combo.addItems(["Alphabetical", "Family"])
        self.directory_filter_combo.currentIndexChanged.connect(self._refresh_directory_call_list)
        self.directory_filter_combo.setStyleSheet("min-height: 34px; font-weight: 700;")
        self.family_style_btn = QPushButton("Family Style", self.directory_calls_panel)
        self.family_style_btn.setMinimumHeight(34)
        self.family_style_btn.clicked.connect(self._choose_family_style)
        controls_row.addWidget(self.directory_filter_combo, 1)
        controls_row.addWidget(self.family_style_btn)

        recording_row = QHBoxLayout()
        recording_row.setContentsMargins(0, 0, 0, 0)
        recording_row.setSpacing(8)
        self.record_mode_combo = QComboBox(self.directory_calls_panel)
        self.record_mode_combo.addItems(["Tab video + audio", "Audio only"])
        self.record_mode_combo.setMinimumHeight(34)
        self.record_mode_combo.setStyleSheet("font-weight: 700;")
        self.start_record_btn = QPushButton("⏺ Start Capture", self.directory_calls_panel)
        self.start_record_btn.setMinimumHeight(34)
        self.start_record_btn.clicked.connect(self._start_tab_recording)
        self.stop_record_btn = QPushButton("⏹ Stop + Save", self.directory_calls_panel)
        self.stop_record_btn.setMinimumHeight(34)
        self.stop_record_btn.setEnabled(False)
        self.stop_record_btn.clicked.connect(self._stop_tab_recording)
        recording_row.addWidget(self.record_mode_combo)
        recording_row.addWidget(self.start_record_btn)
        recording_row.addWidget(self.stop_record_btn)

        self.directory_calls_list = QListWidget(self.directory_calls_panel)
        self.directory_calls_list.setStyleSheet(
            """
            QListWidget {
                border: 1px solid #2b3550;
                border-radius: 14px;
                background: #060a14;
                padding: 6px;
                color: #e7f1ff;
            }
            """
        )

        directory_calls_layout.addWidget(directory_calls_title)
        directory_calls_layout.addWidget(directory_calls_subtitle)
        directory_calls_layout.addLayout(controls_row)
        directory_calls_layout.addLayout(recording_row)

        self.communication_mode_toggle = QCheckBox("Communication Mode", self.directory_calls_panel)
        self.communication_mode_toggle.setChecked(self._communication_mode_enabled)
        self.communication_mode_toggle.toggled.connect(self._toggle_communication_mode)

        self.communication_target_combo = QComboBox(self.directory_calls_panel)
        self.communication_target_combo.setMinimumHeight(32)
        self.communication_target_combo.currentIndexChanged.connect(self._set_communication_target_from_combo)

        self.communication_audio_indicator = LevelIndicator(self.directory_calls_panel)
        self.communication_status_label = QLabel("Communication Mode OFF", self.directory_calls_panel)
        self.communication_status_label.setStyleSheet("font-size:11px; color:#8ca3c9;")
        self.communication_status_label.setWordWrap(True)

        directory_calls_layout.addWidget(self.communication_mode_toggle)
        directory_calls_layout.addWidget(self.communication_target_combo)
        directory_calls_layout.addWidget(QLabel("Audio Detector", self.directory_calls_panel))
        directory_calls_layout.addWidget(self.communication_audio_indicator)
        directory_calls_layout.addWidget(self.communication_status_label)
        directory_calls_layout.addWidget(self.directory_calls_list, 1)
        self.kindroid_layout.addWidget(self.directory_calls_panel)

        self.quick_call_row = QWidget(self.tabs)
        self.quick_call_row_layout = QHBoxLayout(self.quick_call_row)
        self.quick_call_row_layout.setContentsMargins(10, 8, 10, 8)
        self.quick_call_row_layout.setSpacing(10)
        self.quick_call_row.setStyleSheet(
            """
            QWidget {
                background: #050505;
                border: 1px solid #242424;
                border-radius: 16px;
            }
            QPushButton {
                min-height: 40px;
                padding: 0 14px;
                border-radius: 12px;
                border: 1px solid #2c2c2c;
                background: #0a0a0a;
                color: #d1e9ff;
                font-size: 12px;
                font-weight: 800;
                letter-spacing: 0.4px;
            }
            QPushButton:hover {
                background: #141414;
                border: 1px solid #4c8dff;
            }
            """
        )

        self.home_tab_widget = home_tab.build_home_tab(self)
        self.tabs.addTab(self.home_tab_widget, "HOME")
        self.pregnancies_tab_widget = home_tab.build_pregnancies_tab(self)
        self.tabs.addTab(self.pregnancies_tab_widget, "PREGNANCIES")
        self.tabs.addTab(self.kindroid_tab, "CALLS")
        self.podcast_tab_widget = podcast_tab.build_podcast_tab(self)
        self.tabs.addTab(self.podcast_tab_widget, "PODCAST")

        self.groupmaker_tab = groupmaker.build_groupmaker_tab(self)
        self.tabs.addTab(self.groupmaker_tab, "GROUPMAKER")
        self.house_council_tab = None
        self.directory_tab = DirectoryTab(self)
        self.locations_tab = LocationsTab(self)
        self.tabs.addTab(self.locations_tab, "LOCATIONS")
        self.tabs.addTab(self.directory_tab, "DIRECTORY")
        self.houses_tab_widget = houses.build_houses_tab(self)
        self.house_council_tab = getattr(self.houses_tab_widget, "house_council_panel", None)
        self.tabs.addTab(self.houses_tab_widget, "HOUSES")

        self.calendar_tab_widget = calendar_tab.build_calendar_tab(self)
        self.tabs.addTab(self.calendar_tab_widget, "CALENDAR")

        self.tabs.addTab(journal.build_journal_tab(self), "JOURNAL")
        self.tabs.addTab(addons.build_addons_tab(self), "ADDONS")
        self.tabs.addTab(feeder.build_fetcher_tab(self), "FETCHER")
        self.tabs.addTab(feeder.build_feeder_tab(self), "FEEDER")
        self.settings_tab = SettingsTab(self)
        self.tabs.addTab(self.settings_tab, "SETTINGS")
        self.tabs.currentChanged.connect(self._on_main_tab_changed)

        self._configure_primary_and_more_tabs()
        self._apply_amoled_theme()
        self._apply_tab_label_colors()
        self.sync_locations_from_calendar_events()
        self._refresh_communication_target_apps()
        if self._communication_mode_enabled:
            self._communication_mode_enabled = False
            self.config["communication_mode_enabled"] = False
            self._save_config(self.config)
            self.communication_mode_toggle.setChecked(False)
        self._refresh_directory_call_list()
        self._refresh_quick_call_buttons()
        # Do not auto-open/dock the COMMS/GROUPMAKER panel during startup.
        # The remote is opened explicitly from the tray or GROUPMAKER controls.
        self._window_geometry_ready = True
        self._position_quick_call_row()
        self._setup_system_tray()
        self._setup_launcher_command_polling()

    def _setup_launcher_command_polling(self) -> None:
        """Watch for lightweight launcher requests to show, hide, or quit the app."""
        self._launcher_command_timer = QTimer(self)
        self._launcher_command_timer.setInterval(250)
        self._launcher_command_timer.timeout.connect(self._process_launcher_command)
        self._launcher_command_timer.start()
        self._process_launcher_command()

    def _process_launcher_command(self) -> None:
        try:
            payload = json.loads(LAUNCHER_COMMAND_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(payload, dict):
            return
        command_id = str(payload.get("id", "")).strip()
        if not command_id or command_id == self._last_launcher_command_id:
            return
        action = str(payload.get("action", "")).strip().lower()
        if action not in {"show", "hide", "quit", "toggle_conversation"}:
            return
        self._last_launcher_command_id = command_id
        if action == "show":
            self._open_groupmaker_remote_from_tray()
        elif action == "hide":
            self.close_groupmaker_remote_for_main_window()
            if self.isVisible():
                self._store_window_geometry()
                self.hide()
        elif action == "toggle_conversation":
            self._toggle_conversation_mode()
        else:
            self._quit_from_tray()

    def _toggle_conversation_mode(self) -> None:
        """Alternate Ctrl+Numpad 0 between GROUPMAKER Sync Now and the Calls page."""
        if self._conversation_mode_active:
            self._conversation_mode_active = False
            self.close_groupmaker_remote_for_main_window()
            self.main_kindroid_webview.setUrl(QUrl(TARGET_URL))
            calls_index = self.tabs.indexOf(self.kindroid_tab)
            if calls_index >= 0:
                self.tabs.setCurrentIndex(calls_index)
            self.showNormal()
            self.raise_()
            self.activateWindow()
            LOGGER.info("Conversation mode disabled; returned to the regular Kindroid page")
            return

        self._conversation_mode_active = True
        self._open_groupmaker_remote_from_tray()
        self.webpage._request_groupmaker_sync_now()  # pylint: disable=protected-access
        LOGGER.info("Conversation mode enabled; requested GROUPMAKER Sync Now")

    def enter_light_mode(self) -> None:
        """Keep only the GROUPMAKER COMMS shell and live KINDROID panel visible."""
        self.lightweight_mode = True
        if hasattr(self, "_documents_backup_timer"):
            self._documents_backup_timer.stop()
        if hasattr(self, "_avatar_audio_probe_timer"):
            self._avatar_audio_probe_timer.stop()
        if hasattr(self, "_group_avatar_probe_timer"):
            self._group_avatar_probe_timer.stop()
        self._comm_stop_signal.emit()
        tab = getattr(self, "groupmaker_tab", None)
        if tab is not None and hasattr(tab, "open_remote_controller"):
            tab.open_remote_controller()
        panel = getattr(self, "communication_avatar_panel", None)
        if panel is not None:
            panel.showMaximized()
            panel.raise_()
            panel.activateWindow()
        self.hide()

    def exit_light_mode(self) -> None:
        self.lightweight_mode = False
        self._light_mode_window = None
        if hasattr(self, "_documents_backup_timer"):
            self._documents_backup_timer.start()
        if hasattr(self, "_avatar_audio_probe_timer"):
            self._avatar_audio_probe_timer.start()
        if hasattr(self, "_group_avatar_probe_timer"):
            self._group_avatar_probe_timer.start()
        self.show()
        self.raise_()
        self.activateWindow()

    def hide_main_window_for_groupmaker_remote(self) -> None:
        """Hide the main shell while the GROUPMAKER remote is active."""
        if self.isVisible():
            self._store_window_geometry()
            self.hide()

    def close_groupmaker_remote_for_main_window(self) -> None:
        """Close GROUPMAKER COMMS before presenting the main shell."""
        tab = getattr(self, "groupmaker_tab", None)
        if tab is not None and hasattr(tab, "close_remote_controller"):
            tab.close_remote_controller()
        panel = getattr(self, "communication_avatar_panel", None)
        if panel is not None and hasattr(panel, "set_groupmaker_control_widget"):
            panel.set_groupmaker_control_widget(None)
            panel.hide()


    def active_kindroid_webview(self) -> QWebEngineView:
        return self.webview

    def dock_kindroid_webview_into_control_window(self) -> None:
        panel = getattr(self, "communication_avatar_panel", None)
        if panel is None or not hasattr(panel, "set_kindroid_widget"):
            return
        self._kindroid_webview_docked_in_control_window = True
        if self.webview.parent() is not getattr(panel, "kindroid_mirror_panel", None):
            panel.set_kindroid_widget(self.webview)
        if hasattr(self, "_kindroid_tab_placeholder"):
            self._kindroid_tab_placeholder.show()

    def restore_kindroid_webview_from_control_window(self) -> None:
        # The COMMS WINDOW is now the permanent home for the
        # KINDROID web panel. Do not move it back into a main KINDROID tab.
        self._kindroid_webview_docked_in_control_window = True

    def focus_kindroid_tab_once(self) -> None:
        for index in range(self.tabs.count()):
            if self.tabs.tabText(index) == "KINDROID":
                self.tabs.setCurrentIndex(index)
                break

    def _on_main_tab_changed(self, _index: int) -> None:
        directory_widget = getattr(self, "directory_tab", None)
        if directory_widget is None:
            return
        if hasattr(directory_widget, "_flush_scheduled_save"):
            directory_widget._flush_scheduled_save(force=True)  # pylint: disable=protected-access

    def apply_startup_launch_behavior(self) -> bool:
        """Return True if the main window should be shown at startup."""
        # Startup should stay in the tray only. The main window and GROUPMAKER
        # remote are both opened explicitly from their tray icons/menus.
        if self.tray_icon is not None:
            self.hide()
            panel = getattr(self, "communication_avatar_panel", None)
            if panel is not None:
                panel.hide()
            return False
        return True

    def _directory_people(self) -> list[dict[str, object]]:
        people: list[dict[str, object]] = []
        for entry in self.get_directory_entries():
            name = str(entry.get("name", "")).strip()
            ai_id = str(entry.get("ai_id", "")).strip()
            if not name or not ai_id:
                continue
            people.append(
                {
                    "name": name,
                    "ai_id": ai_id,
                    "family": self._extract_family_name(name),
                    "pregnant": self.is_entry_pregnant(entry),
                }
            )
        return people

    def focus_directory_person(self, ai_id: str) -> bool:
        clean_ai_id = str(ai_id).strip()
        if not clean_ai_id or not hasattr(self, "directory_tab"):
            return False
        directory_index = self.tabs.indexOf(self.directory_tab)
        if directory_index >= 0:
            self.tabs.setCurrentIndex(directory_index)
        if hasattr(self.directory_tab, "select_person_by_ai_id"):
            return bool(self.directory_tab.select_person_by_ai_id(clean_ai_id))
        return False

    @staticmethod
    def is_entry_pregnant(entry: dict) -> bool:
        preg = entry.get("pregnancy")
        return isinstance(preg, dict) and bool(preg.get("active", False))

    @staticmethod
    def entry_pregnancy_progress(entry: dict) -> float:
        preg = entry.get("pregnancy") if isinstance(entry, dict) else None
        if not isinstance(preg, dict):
            return 0.0
        raw_progress = preg.get("progress", 0)
        if isinstance(raw_progress, str):
            raw_progress = raw_progress.strip().rstrip("%")
        try:
            return max(0.0, min(100.0, float(raw_progress)))
        except (TypeError, ValueError):
            return 0.0

    @classmethod
    def uses_pregnancy_communication_video_pairs(cls, entry: dict) -> bool:
        if not cls.is_entry_pregnant(entry):
            return False
        raw_pairs = entry.get("pregnancy_communication_video_pairs", [])
        if not isinstance(raw_pairs, list):
            return False
        for pair in raw_pairs:
            if not isinstance(pair, dict):
                continue
            idle = str(pair.get("idle", pair.get("idle_path", ""))).strip()
            talking = str(pair.get("talking", pair.get("talking_path", ""))).strip()
            if idle and talking:
                return True
        return False

    def _extract_family_name(self, name: str) -> str:
        tokens = [token for token in str(name).strip().split() if token]
        if len(tokens) >= 2:
            return tokens[1].rstrip(".").upper()
        if tokens:
            return tokens[0].rstrip(".").upper()
        return "UNASSIGNED"

    def _family_styles(self) -> dict[str, dict[str, str]]:
        raw = self.config.get("family_styles", {})
        if not isinstance(raw, dict):
            return {}
        normalized: dict[str, dict[str, str]] = {}
        for family, style in raw.items():
            family_name = str(family).strip().upper()
            if not family_name or not isinstance(style, dict):
                continue
            color = str(style.get("color", "")).strip() or "#7c3aed"
            banner = str(style.get("banner", "")).strip()
            normalized[family_name] = {"color": color, "banner": banner}
        return normalized

    def _family_color(self, family_name: str) -> str:
        styles = self._family_styles()
        family_key = str(family_name).strip().upper()
        if family_key in styles:
            return styles[family_key].get("color", "#7c3aed")
        palette = ["#60a5fa", "#34d399", "#f472b6", "#f59e0b", "#a78bfa", "#22d3ee", "#fb7185", "#4ade80"]
        return palette[hash(family_key) % len(palette)]

    def _set_family_style(self, family_name: str, color: str, banner: str) -> None:
        styles = self._family_styles()
        styles[family_name] = {"color": color, "banner": banner}
        self.config["family_styles"] = styles
        self._save_config(self.config)

    def _choose_family_style(self) -> None:
        families = sorted({person["family"] for person in self._directory_people()})
        if not families:
            QMessageBox.information(self, "Family Style", "Add directory people first to configure family colors.")
            return
        selected_family, accepted = QInputDialog.getItem(
            self,
            "Family Style",
            "Select a family:",
            families,
            0,
            False,
        )
        if not accepted or not selected_family:
            return
        current_styles = self._family_styles()
        current_color = current_styles.get(selected_family, {}).get("color", "#7c3aed")
        picked_color = QColorDialog.getColor(QColor(current_color), self, f"Choose color for {selected_family}")
        if not picked_color.isValid():
            return
        banner_value, banner_ok = QInputDialog.getText(
            self,
            "Family Banner (Optional)",
            "Banner text or image URL/path (optional):",
            text=current_styles.get(selected_family, {}).get("banner", ""),
        )
        if not banner_ok:
            return
        self._set_family_style(selected_family, picked_color.name(), str(banner_value).strip())
        self._refresh_directory_call_list()
        self._refresh_quick_call_buttons()

    def _recent_quick_calls(self) -> list[str]:
        raw_recent = self.config.get("quick_call_recent", [])
        if not isinstance(raw_recent, list):
            return []
        seen: set[str] = set()
        cleaned: list[str] = []
        for item in raw_recent:
            ai_id = str(item).strip()
            if not ai_id or ai_id in seen:
                continue
            cleaned.append(ai_id)
            seen.add(ai_id)
        return cleaned

    def _record_recent_quick_call(self, ai_id: str) -> None:
        recent = self._recent_quick_calls()
        recent = [existing for existing in recent if existing != ai_id]
        recent.insert(0, ai_id)
        self.config["quick_call_recent"] = recent[:100]
        self._save_config(self.config)

    def _refresh_directory_call_list(self) -> None:
        self.directory_calls_list.clear()
        people = self._directory_people()
        if str(self.directory_filter_combo.currentText()).lower().startswith("family"):
            grouped: dict[str, list[dict[str, str]]] = {}
            for person in people:
                grouped.setdefault(person["family"], []).append(person)
            for family_name in sorted(grouped.keys()):
                self._add_family_header_item(family_name)
                for person in sorted(grouped[family_name], key=lambda entry: entry["name"].lower()):
                    self._add_person_call_item(person)
        else:
            for person in sorted(people, key=lambda entry: entry["name"].lower()):
                self._add_person_call_item(person)

    def _add_family_header_item(self, family_name: str) -> None:
        item = QListWidgetItem(self.directory_calls_list)
        item.setFlags(Qt.ItemFlag.NoItemFlags)
        banner = self._family_styles().get(family_name, {}).get("banner", "")
        header_text = family_name if not banner else f"{family_name}  •  {banner}"
        header = QLabel(header_text, self.directory_calls_list)
        color = self._family_color(family_name)
        header.setStyleSheet(
            f"padding: 7px 10px; margin: 6px 2px 4px 2px; border-radius: 8px; "
            f"background: #0f1422; color: {color}; font-size: 11px; font-weight: 900; letter-spacing: 0.9px;"
        )
        header.setMinimumHeight(32)
        item.setSizeHint(header.sizeHint())
        self.directory_calls_list.addItem(item)
        self.directory_calls_list.setItemWidget(item, header)

    def _add_person_call_item(self, person: dict[str, object]) -> None:
        item = QListWidgetItem(self.directory_calls_list)
        row_widget = QWidget(self.directory_calls_list)
        row_layout = QHBoxLayout(row_widget)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(6)
        row_widget.setMinimumHeight(38)
        is_pregnant = bool(person.get("pregnant", False))
        button = QPushButton(str(person["name"]).upper(), row_widget)
        family_color = self._family_color(str(person["family"]))
        border_color = "#ff4fd8" if is_pregnant else family_color
        text_color = "#ffd7f6" if is_pregnant else family_color
        background = "#1a0920" if is_pregnant else "#0d1220"
        button.setStyleSheet(
            f"min-height: 32px; text-align: left; padding: 0 10px; border-radius: 9px; "
            f"border: 2px solid {border_color}; background: {background}; color: {text_color}; "
            "font-size: 12px; font-weight: 800;"
        )
        button.clicked.connect(lambda _checked=False, selected_ai_id=person["ai_id"]: self._open_quick_call(selected_ai_id))
        if is_pregnant:
            preg_badge = QLabel("pregnant", row_widget)
            preg_badge.setStyleSheet(
                "padding:2px 8px; border-radius:9px; border:1px solid #ff4fd8; color:#ffd7f6; "
                "background:#2f0d31; font-size:10px; font-weight:800;"
            )
            row_layout.addWidget(preg_badge)
        fetch_btn = QPushButton("🎲 SEND", row_widget)
        fetch_btn.setToolTip("Send one instant random source message for this person.")
        fetch_btn.setStyleSheet(
            "min-height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid #4b67a0; "
            "background:#0d1528; color:#d6e8ff; font-size: 11px; font-weight: 800;"
        )
        fetch_btn.clicked.connect(
            lambda _checked=False, selected_ai_id=person["ai_id"], clicked_button=fetch_btn: self._send_random_fetch_for_ai(
                selected_ai_id, clicked_button
            )
        )
        row_layout.insertWidget(0, button, 1)
        row_layout.addWidget(fetch_btn)
        item.setSizeHint(row_widget.sizeHint().expandedTo(button.sizeHint()))
        self.directory_calls_list.addItem(item)
        self.directory_calls_list.setItemWidget(item, row_widget)

    def _entry_fetch_rules(self, entry: dict) -> list[dict[str, str]]:
        clean: list[dict[str, str]] = []
        raw_rules = entry.get("fetch_rules", [])
        if isinstance(raw_rules, list):
            for rule in raw_rules:
                if not isinstance(rule, dict):
                    continue
                source_id = str(rule.get("source_id", "")).strip()
                frequency = str(rule.get("frequency", "none")).strip() or "none"
                if not source_id or frequency == "none":
                    continue
                clean.append(
                    {
                        "source_id": source_id,
                        "frequency": frequency,
                        "time": str(rule.get("time", "09:00")).strip() or "09:00",
                        "last_sent_date": str(rule.get("last_sent_date", "")).strip(),
                    }
                )
        if clean:
            return clean
        source_id = str(entry.get("fetch_source_id", "")).strip()
        frequency = str(entry.get("fetch_frequency", "none")).strip() or "none"
        if not source_id or frequency == "none":
            return []
        return [
            {
                "source_id": source_id,
                "frequency": frequency,
                "time": str(entry.get("fetch_time", "09:00")).strip() or "09:00",
                "last_sent_date": str(entry.get("fetch_last_sent_date", "")).strip(),
            }
        ]

    def _send_random_fetch_for_ai(self, ai_id: str, button: QPushButton | None = None) -> None:
        if self._random_send_thread is not None:
            QMessageBox.information(self, "Send In Progress", "Please wait for the current random send to finish.")
            return
        target_ai_id = str(ai_id).strip()
        if not target_ai_id:
            return
        api_key = str(self.get_default_api_key() or "").strip()
        if not api_key:
            QMessageBox.warning(self, "Missing API Key", "Save a default API key in FEEDER first.")
            return
        entries = self.get_directory_entries()
        target_index = next((idx for idx, entry in enumerate(entries) if str(entry.get("ai_id", "")).strip() == target_ai_id), -1)
        if target_index < 0:
            QMessageBox.warning(self, "Not Found", "Could not find this person in DIRECTORY.")
            return
        person = entries[target_index]
        rules = self._entry_fetch_rules(person)
        if not rules:
            QMessageBox.warning(self, "No Rules", "This person has no fetch rules configured.")
            return
        source_map = {str(source.get("id", "")).strip(): source for source in self.get_fetcher_sources()}
        candidates: list[tuple[dict[str, str], dict]] = []
        for rule in rules:
            source = source_map.get(str(rule.get("source_id", "")).strip())
            if source is None:
                continue
            url = str(source.get("url", "")).strip()
            if not url:
                continue
            candidates.append((rule, source))
        if not candidates:
            QMessageBox.warning(self, "Missing Sources", "None of this person's rules match an existing source.")
            return
        rule, source = random.choice(candidates)
        name = str(person.get("name", "")).strip() or "Someone"
        url = str(source.get("url", "")).strip()
        description = str(source.get("description", "")).strip()
        message = feeder.render_auto_message_template(
            "fetcher_send",
            {"name": name, "url": url, "description": description},
            wrap=True,
        )
        payload = feeder.build_send_message_payload(
            ai_id=target_ai_id,
            message=message,
            link_url=url,
            link_description=description,
        )
        jobs = [
            {
                "api_key": api_key,
                "payload": payload,
                "requester": "KINDROIDXL-DIRECTORY-RANDOM",
                "success_token": 0,
            }
        ]
        self._pending_random_send_context = {
            "entries": entries,
            "target_index": target_index,
            "rules": rules,
            "name": name,
            "button": button,
        }
        if button is not None:
            button.setEnabled(False)
            button.setText("...")
        self._random_send_thread = QThread(self)
        self._random_send_worker = FetchSendWorker(jobs)
        self._random_send_worker.moveToThread(self._random_send_thread)
        self._random_send_thread.started.connect(self._random_send_worker.run)
        self._random_send_worker.finished.connect(self._on_random_send_finished)
        self._random_send_worker.finished.connect(self._random_send_thread.quit)
        self._random_send_worker.finished.connect(self._random_send_worker.deleteLater)
        self._random_send_thread.finished.connect(self._random_send_thread.deleteLater)
        self._random_send_thread.start()

    def _on_random_send_finished(self, sent: int, failed: int, _success_tokens: list) -> None:
        context = self._pending_random_send_context or {}
        button = context.get("button")
        if isinstance(button, QPushButton):
            button.setEnabled(True)
            button.setText("🎲 SEND")
        entries = context.get("entries", [])
        target_index = context.get("target_index", -1)
        rules = context.get("rules", [])
        name = str(context.get("name", "this person"))
        if sent > 0 and isinstance(entries, list) and isinstance(target_index, int) and isinstance(rules, list):
            if 0 <= target_index < len(entries) and rules:
                person = entries[target_index]
                if isinstance(person, dict):
                    rules[0]["last_sent_date"] = time.strftime("%Y-%m-%d")
                    person["fetch_rules"] = rules
                    first = rules[0]
                    person["fetch_source_id"] = str(first.get("source_id", "")).strip()
                    person["fetch_frequency"] = str(first.get("frequency", "none")).strip() or "none"
                    person["fetch_time"] = str(first.get("time", "09:00")).strip() or "09:00"
                    person["fetch_last_sent_date"] = str(first.get("last_sent_date", "")).strip()
                    entries[target_index] = person
                    self.save_directory_entries(entries)
        self._random_send_thread = None
        self._random_send_worker = None
        self._pending_random_send_context = None
        if failed > 0:
            QMessageBox.warning(self, "Send Failed", "Could not send random source message.")
            return
        QMessageBox.information(self, "Source Sent", f"Sent random source for {name}.")

    def _refresh_quick_call_buttons(self) -> None:
        while self.quick_call_row_layout.count():
            item = self.quick_call_row_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()

        people = self._directory_people()
        by_ai_id = {person["ai_id"]: person["name"] for person in people}
        ordered_recent = [ai_id for ai_id in self._recent_quick_calls() if ai_id in by_ai_id][:10]

        if not ordered_recent:
            empty = QLabel("No quick call buttons yet. Add people with AI IDs in DIRECTORY.", self.quick_call_row)
            empty.setStyleSheet("color:#95a2bf; font-weight:700; padding: 10px 12px;")
            self.quick_call_row_layout.addWidget(empty)
            self.quick_call_row_layout.addStretch(1)
            return

        for ai_id in ordered_recent:
            name = by_ai_id[ai_id]
            family = self._extract_family_name(name)
            family_color = self._family_color(family)
            button = QPushButton(str(name).upper(), self.quick_call_row)
            button.setStyleSheet(
                f"border: 2px solid {family_color}; color: {family_color}; background: #0b1120; border-radius: 12px;"
            )
            button.clicked.connect(lambda _checked=False, selected_ai_id=ai_id: self._open_quick_call(selected_ai_id))
            self.quick_call_row_layout.addWidget(button)

        self.quick_call_row_layout.addStretch(1)

    def _open_quick_call(self, ai_id: str) -> None:
        cleaned_ai_id = str(ai_id).strip()
        if not cleaned_ai_id:
            return
        self._record_recent_quick_call(cleaned_ai_id)
        self._refresh_quick_call_buttons()
        target_url = QUrl(f"https://kindroid.ai/call/{cleaned_ai_id}/")
        kindroid_index = self.tabs.indexOf(self.kindroid_tab)
        if kindroid_index >= 0:
            self.tabs.setCurrentIndex(kindroid_index)
        self.webview.setUrl(target_url)
        QTimer.singleShot(150, self.webview.reload)

    def _position_quick_call_row(self) -> None:
        bar_height = self.tabs.tabBar().sizeHint().height()
        x = 16
        y = bar_height + 18
        width = max(self.tabs.width() - 32, 220)
        self.quick_call_row.setGeometry(x, y, width, 58)
        self.quick_call_row.raise_()

    def _setup_system_tray(self) -> None:
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return

        tray_icon = QSystemTrayIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_ComputerIcon), self)
        tray_icon.setToolTip("KINDROIDXL")
        tray_icon.activated.connect(self._on_tray_activated)

        tray_menu = QMenu(self)
        show_action = QAction("Show KINDROIDXL", self)
        show_action.triggered.connect(self._restore_from_tray)
        open_remote_action = QAction("Open GroupMaker Remote", self)
        open_remote_action.triggered.connect(self._open_groupmaker_remote_from_tray)
        quit_action = QAction("Quit", self)
        quit_action.triggered.connect(self._quit_from_tray)

        tray_menu.addAction(show_action)
        tray_menu.addAction(open_remote_action)
        tray_menu.addSeparator()
        tray_menu.addAction(quit_action)
        tray_icon.setContextMenu(tray_menu)
        tray_icon.show()

        remote_tray_icon = QSystemTrayIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_DialogYesButton), self)
        remote_tray_icon.setToolTip("KINDROIDXL GROUPMAKER Remote")
        remote_tray_icon.activated.connect(self._on_remote_tray_activated)
        remote_tray_menu = QMenu(self)
        remote_open_action = QAction("Show GroupMaker Remote", self)
        remote_open_action.triggered.connect(self._open_groupmaker_remote_from_tray)
        remote_hide_action = QAction("Hide GroupMaker Remote", self)
        remote_hide_action.triggered.connect(self.close_groupmaker_remote_for_main_window)
        remote_quit_action = QAction("Quit KINDROIDXL", self)
        remote_quit_action.triggered.connect(self._quit_from_tray)
        remote_tray_menu.addAction(remote_open_action)
        remote_tray_menu.addAction(remote_hide_action)
        remote_tray_menu.addSeparator()
        remote_tray_menu.addAction(remote_quit_action)
        remote_tray_icon.setContextMenu(remote_tray_menu)
        remote_tray_icon.show()

        self.tray_icon = tray_icon
        self.remote_tray_icon = remote_tray_icon

    def _restore_from_tray(self) -> None:
        self.close_groupmaker_remote_for_main_window()
        raw = self.config.get("window_geometry", {})
        restore_maximized = isinstance(raw, dict) and bool(raw.get("is_maximized", False))
        if restore_maximized:
            self.showMaximized()
        else:
            self.showNormal()
            self._ensure_window_fits_visible_screen()
        self.raise_()
        self.activateWindow()

    def _quit_from_tray(self) -> None:
        self._is_quitting = True
        QApplication.instance().quit()

    def _open_groupmaker_remote_from_tray(self) -> None:
        tab = getattr(self, "groupmaker_tab", None)
        if tab is None:
            return
        if hasattr(tab, "open_remote_controller"):
            tab.open_remote_controller()

    def _on_tray_activated(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason in (
            QSystemTrayIcon.ActivationReason.Trigger,
            QSystemTrayIcon.ActivationReason.DoubleClick,
        ):
            if self.isVisible():
                self.hide()
            else:
                self._restore_from_tray()

    def _on_remote_tray_activated(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason in (
            QSystemTrayIcon.ActivationReason.Trigger,
            QSystemTrayIcon.ActivationReason.DoubleClick,
        ):
            self._open_groupmaker_remote_from_tray()

    def closeEvent(self, event) -> None:  # type: ignore[override]
        if self._closing_for_groupmaker_remote:
            self._store_window_geometry()
            event.ignore()
            self.hide()
            return

        if self._is_quitting or not self.tray_icon:
            self._comm_stop_signal.emit()
            self._comm_worker_thread.quit()
            self._comm_worker_thread.wait(1000)
            self._store_window_geometry()
            super().closeEvent(event)
            return

        self._store_window_geometry()
        event.ignore()
        self.hide()
        if not self._tray_hide_notice_shown:
            self.tray_icon.showMessage(
                "KINDROIDXL",
                "Still running in the system tray. Use the tray menu to reopen or quit.",
                QSystemTrayIcon.MessageIcon.Information,
                3500,
            )
            self._tray_hide_notice_shown = True

    def resizeEvent(self, event) -> None:  # type: ignore[override]
        super().resizeEvent(event)
        if hasattr(self, "quick_call_row"):
            self._position_quick_call_row()

    def moveEvent(self, event) -> None:  # type: ignore[override]
        super().moveEvent(event)

    def showEvent(self, event) -> None:  # type: ignore[override]
        super().showEvent(event)
        if not self.lightweight_mode:
            self.close_groupmaker_remote_for_main_window()
        if self._restore_maximized_on_first_show:
            self._restore_maximized_on_first_show = False
            self.showMaximized()
            return
        if self._did_initial_fit_check:
            return
        self._did_initial_fit_check = True
        QTimer.singleShot(0, self._ensure_window_fits_visible_screen)

    def _refresh_communication_target_apps(self) -> None:
        previous = self._communication_target_app
        self.communication_target_combo.blockSignals(True)
        self.communication_target_combo.clear()

        grouped: dict[str, int] = {}
        for proc in psutil.process_iter(attrs=["name", "exe", "username"]):
            try:
                info = proc.info
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
            name = str(info.get("name") or "").strip().lower()
            if not name or not info.get("exe") or not info.get("username"):
                continue
            grouped[name] = grouped.get(name, 0) + 1

        for name, count in sorted(grouped.items()):
            label = f"{name} ({count} processes)" if count > 1 else name
            self.communication_target_combo.addItem(label, name)

        if self.communication_target_combo.count() == 0:
            self.communication_target_combo.addItem("No open user applications found", "")

        if previous:
            idx = self.communication_target_combo.findData(previous)
            if idx >= 0:
                self.communication_target_combo.setCurrentIndex(idx)

        self.communication_target_combo.blockSignals(False)
        self._set_communication_target_from_combo()
        self._update_communication_mode_status()

    def _set_communication_target_from_combo(self) -> None:
        self._communication_target_app = str(self.communication_target_combo.currentData() or "").strip()
        self.config["communication_target_app"] = self._communication_target_app
        self._save_config(self.config)
        self._update_communication_mode_status()

    def _toggle_communication_mode(self, enabled: bool) -> None:
        if enabled:
            QMessageBox.information(
                self,
                "Communication Mode Disabled",
                "Communication Mode routing has been temporarily disabled to preserve normal physical microphone behavior.",
            )
        self._communication_mode_enabled = False
        self.communication_mode_toggle.blockSignals(True)
        self.communication_mode_toggle.setChecked(False)
        self.communication_mode_toggle.blockSignals(False)
        self._on_communication_audio_level(0.0)
        self.config["communication_mode_enabled"] = self._communication_mode_enabled
        self.config["communication_target_app"] = self._communication_target_app
        self._save_config(self.config)
        self._update_communication_mode_status()

    def _update_communication_mode_status(self) -> None:
        if self._communication_mode_enabled and self._communication_target_app:
            self.communication_status_label.setText(
                f"Communication Mode ON — Kindroid will request system/window audio share for: {self._communication_target_app}."
            )
        elif self._communication_mode_enabled:
            self.communication_status_label.setText("Communication Mode ON — select a target app.")
        else:
            self.communication_status_label.setText("Communication Mode OFF — Kindroid uses the system default microphone.")
        if hasattr(self, "settings_tab") and hasattr(self.settings_tab, "_sync_communication_mode_controls"):
            self.settings_tab._sync_communication_mode_controls()

    def _build_communication_mode_script(self) -> str:
        return ""

    def _on_kindroid_load_started(self) -> None:
        self._kindroid_load_in_progress = True
        self._kindroid_load_started_ms = int(time.time() * 1000)
        self._kindroid_load_watchdog.start()

    def _on_kindroid_load_finished(self, ok: bool) -> None:
        self._kindroid_load_in_progress = False
        self._kindroid_load_watchdog.stop()
        if ok:
            self._kindroid_reconnect_attempts = 0
        else:
            QTimer.singleShot(1000, self.reconnect_kindroid_web_panel)
        self._refresh_communication_avatar_for_url()

    def _recover_stuck_kindroid_load(self) -> None:
        if not getattr(self, "_kindroid_load_in_progress", False):
            return
        self._kindroid_reconnect_attempts += 1
        self.reconnect_kindroid_web_panel()

    def _on_kindroid_render_process_terminated(self, *_args) -> None:
        QTimer.singleShot(500, self.reconnect_kindroid_web_panel)

    def reload_kindroid_web_panel(self) -> None:
        self.webview.reload()

    def reconnect_kindroid_web_panel(self) -> None:
        current_url = self.webview.url()
        current_text = current_url.toString() if current_url.isValid() else ""
        target_url = current_url if current_text and current_text != "about:blank" else getattr(self, "_kindroid_last_url", QUrl(TARGET_URL))
        self.webview.stop()
        self._kindroid_load_in_progress = False
        self._kindroid_load_watchdog.stop()
        self.profile.clearHttpCache()
        self.webview.setUrl(QUrl("about:blank"))
        QTimer.singleShot(250, lambda: self.webview.setUrl(target_url))

    def _on_kindroid_url_changed(self, _url: QUrl) -> None:
        url_text = _url.toString() if _url.isValid() else ""
        if url_text and url_text != "about:blank":
            self._kindroid_last_url = _url
        self._refresh_communication_avatar_for_url()

    def _kindroid_group_path_parts(self, url: QUrl) -> list[str]:
        parts = [p for p in url.path().split("/") if p]
        if parts and parts[0] == "v2":
            parts = parts[1:]
        return parts

    def _is_kindroid_group_url(self, url: QUrl) -> bool:
        parts = self._kindroid_group_path_parts(url)
        return len(parts) >= 3 and parts[0] in {"chat", "call"} and parts[1] == "group"

    def _kindroid_group_id_for_url(self, url: QUrl) -> str:
        parts = self._kindroid_group_path_parts(url)
        if len(parts) >= 3 and parts[0] in {"chat", "call"} and parts[1] == "group":
            return parts[2]
        return ""

    def _directory_entry_for_kindroid_url(self, url: QUrl) -> dict | None:
        path_parts = self._kindroid_group_path_parts(url)
        ai_id = ""
        if len(path_parts) >= 2 and path_parts[0] in {"chat", "call"} and path_parts[1] != "group":
            ai_id = path_parts[1]
        elif len(path_parts) >= 3 and path_parts[0] in {"chat", "call"} and path_parts[1] == "group":
            group_id = path_parts[2]
            ai_ids = self._participant_ai_ids_for_group(group_id)
            if len(ai_ids) == 1:
                ai_id = ai_ids[0]
        if not ai_id:
            return None
        for entry in self.get_directory_entries():
            if str(entry.get("ai_id", "")).strip() == ai_id:
                return entry
        return None

    def _participant_ai_ids_for_group(self, group_id: str) -> list[str]:
        clean_group_id = str(group_id).strip()
        if not clean_group_id:
            return []
        tab = getattr(self, "groupmaker_tab", None)
        raw_state = getattr(tab, "_state", {}) if tab is not None else {}
        raw_sessions = raw_state.get("sessions", []) if isinstance(raw_state, dict) else []
        if not isinstance(raw_sessions, list):
            raw_sessions = []
        if not isinstance(raw_sessions, list):
            return []
        for session in raw_sessions:
            if not isinstance(session, dict):
                continue
            candidate = str(session.get("group_id", "")).strip()
            if candidate != clean_group_id:
                continue
            raw_ai_ids = session.get("ai_list", [])
            if not isinstance(raw_ai_ids, list):
                return []
            return [str(item).strip() for item in raw_ai_ids if str(item).strip()]
        return []

    def _refresh_communication_avatar_for_url(self) -> None:
        panel = getattr(self, "communication_avatar_panel", None)
        if panel is None:
            return
        url = self.webview.url()
        if self._is_kindroid_group_url(url):
            self._start_group_communication_avatar_mode()
            return
        if getattr(self, "_group_avatar_window_requested", False):
            return
        self._stop_group_communication_avatar_mode()
        person = self._directory_entry_for_kindroid_url(url)
        person = self._entry_with_random_communication_pair(person)
        panel.set_person(person)
        if person is None:
            self._avatar_audio_probe_timer.stop()
            return
        if getattr(panel, "_person_has_video_pair", lambda _person: False)(person):
            self._avatar_audio_probe_timer.start()
        else:
            self._avatar_audio_probe_timer.stop()

    def _start_group_communication_avatar_mode(self) -> None:
        if getattr(self, "_group_avatar_window_requested", False):
            if not self._group_avatar_probe_timer.isActive():
                self._group_avatar_probe_timer.start()
            self._ensure_group_avatar_people()
        elif self._group_avatar_probe_timer.isActive():
            self._group_avatar_probe_timer.stop()

    def _stop_group_communication_avatar_mode(self) -> None:
        self._group_avatar_window_requested = False
        if hasattr(self, "_group_avatar_probe_timer"):
            self._group_avatar_probe_timer.stop()
        self._group_avatar_candidate_key = ""
        self._group_avatar_candidate_since_ms = 0
        self._group_avatar_loaded_key = ""
        self._group_avatar_last_snapshot = {}
        self._group_avatar_mute_until_ms = 0
        self._group_avatar_force_audio_until_ms = 0
        self._group_avatar_last_forced_audio_key = ""
        self._group_avatar_last_selected_name = ""
        self._group_avatar_last_good_candidate_ms = 0
        self._group_avatar_people_signature = ""

    def _entry_with_random_communication_pair(self, person: dict | None, scope_key: str | None = None, force_random: bool = False) -> dict | None:
        if not isinstance(person, dict):
            return None
        pairs = []
        pairs_key = "pregnancy_communication_video_pairs" if self.uses_pregnancy_communication_video_pairs(person) else "communication_video_pairs"
        raw_pairs = person.get(pairs_key, [])
        if isinstance(raw_pairs, list):
            for pair in raw_pairs:
                if not isinstance(pair, dict):
                    continue
                idle = str(pair.get("idle", pair.get("idle_path", ""))).strip()
                talking = str(pair.get("talking", pair.get("talking_path", ""))).strip()
                if idle and talking and Path(idle).is_file() and Path(talking).is_file():
                    pairs.append({"idle": idle, "talking": talking, "label": str(pair.get("label", "")).strip()})
        if not pairs:
            if pairs_key == "communication_video_pairs" and "communication_video_pairs" not in person:
                return person
            payload = dict(person)
            payload["communication_idle_video_path"] = ""
            payload["communication_talking_video_path"] = ""
            payload["communication_selected_pair_label"] = ""
            return payload
        day_bucket = int(time.time() // 86400)
        person_lock = person.get("communication_today_pair_lock", {})
        if not force_random and isinstance(person_lock, dict) and int(person_lock.get("day", -1) or -1) == day_bucket:
            locked_pairs_key = str(person_lock.get("pairs_key", "")).strip()
            if not locked_pairs_key or locked_pairs_key == pairs_key:
                locked_idle = str(person_lock.get("idle", "")).strip()
                locked_talking = str(person_lock.get("talking", "")).strip()
                for selected in pairs:
                    if selected.get("idle") == locked_idle and selected.get("talking") == locked_talking:
                        payload = dict(person)
                        payload["communication_idle_video_path"] = selected["idle"]
                        payload["communication_talking_video_path"] = selected["talking"]
                        payload["communication_selected_pair_label"] = selected.get("label", "")
                        return payload
                if locked_pairs_key or (not locked_idle and not locked_talking):
                    try:
                        locked_index = int(person_lock.get("index", -1))
                    except (TypeError, ValueError):
                        locked_index = -1
                    if 0 <= locked_index < len(pairs):
                        selected = pairs[locked_index]
                        payload = dict(person)
                        payload["communication_idle_video_path"] = selected["idle"]
                        payload["communication_talking_video_path"] = selected["talking"]
                        payload["communication_selected_pair_label"] = selected.get("label", "")
                        return payload
        key = scope_key or self._communication_pair_lock_key(person)
        selected = self._locked_communication_pair_for_key(key, pairs, pairs_key=pairs_key, force_random=force_random)
        payload = dict(person)
        payload["communication_idle_video_path"] = selected["idle"]
        payload["communication_talking_video_path"] = selected["talking"]
        payload["communication_selected_pair_label"] = selected.get("label", "")
        return payload

    def _communication_pair_lock_key(self, person: dict) -> str:
        identity = str(person.get("ai_id", "") or person.get("kindroid_id", "") or person.get("name", "")).strip()
        if not identity:
            identity = self.webview.url().toString().split("?", 1)[0]
        return f"person::{identity}"

    def _locked_communication_pair_for_key(
        self, key: str, pairs: list[dict[str, str]], pairs_key: str = "", force_random: bool = False
    ) -> dict[str, str]:
        day_bucket = int(time.time() // 86400)
        lock = self._communication_avatar_pair_locks.get(key)
        if not force_random and isinstance(lock, dict) and int(lock.get("day", -1) or -1) == day_bucket:
            locked_pairs_key = str(lock.get("pairs_key", "")).strip()
            if not locked_pairs_key or not pairs_key or locked_pairs_key == pairs_key:
                locked_idle = str(lock.get("idle", "")).strip()
                locked_talking = str(lock.get("talking", "")).strip()
                for selected in pairs:
                    if selected.get("idle") == locked_idle and selected.get("talking") == locked_talking:
                        self._communication_avatar_pair_by_url[key] = selected
                        return selected
                if locked_pairs_key or (not locked_idle and not locked_talking):
                    try:
                        index = int(lock.get("index", -1))
                    except (TypeError, ValueError):
                        index = -1
                    if 0 <= index < len(pairs):
                        selected = pairs[index]
                        self._communication_avatar_pair_by_url[key] = selected
                        return selected
        excluded_index = -1
        if force_random and isinstance(lock, dict):
            try:
                excluded_index = int(lock.get("index", -1))
            except (TypeError, ValueError):
                excluded_index = -1
        choices = [index for index in range(len(pairs)) if index != excluded_index]
        selected_index = random.choice(choices or list(range(len(pairs))))
        selected = pairs[selected_index]
        self._communication_avatar_pair_by_url[key] = selected
        self._communication_avatar_pair_locks[key] = {
            "day": day_bucket,
            "pairs_key": pairs_key,
            "index": selected_index,
            "idle": selected.get("idle", ""),
            "talking": selected.get("talking", ""),
            "label": selected.get("label", ""),
            "selected_at": int(time.time()),
        }
        self.config["communication_avatar_pair_locks"] = self._communication_avatar_pair_locks
        self._save_config(self.config)
        return selected

    @staticmethod
    def _normalize_group_avatar_name(value: object) -> str:
        return re.sub(r"[^\w\s'-]+", " ", str(value or "").casefold()).strip()

    @staticmethod
    def _entry_group_aliases(entry: dict) -> list[str]:
        aliases: list[str] = []
        for field in ("communication_group_aliases", "group_aliases", "aliases"):
            raw = entry.get(field, [])
            if isinstance(raw, str):
                aliases.extend(part.strip() for part in raw.split(","))
            elif isinstance(raw, list):
                aliases.extend(str(part).strip() for part in raw)
        return [alias for alias in aliases if alias]

    def _directory_entry_for_ai_id(self, ai_id: object) -> dict | None:
        clean_ai_id = str(ai_id or "").strip()
        if not clean_ai_id:
            return None
        for entry in self.get_directory_entries():
            if isinstance(entry, dict) and str(entry.get("ai_id", "")).strip() == clean_ai_id:
                return entry
        return None

    def _first_group_directory_entry(self) -> dict | None:
        group_id = self._kindroid_group_id_for_url(self.webview.url())
        for ai_id in self._participant_ai_ids_for_group(group_id):
            entry = self._directory_entry_for_ai_id(ai_id)
            if isinstance(entry, dict) and CommunicationAvatarPanel._person_has_video_pair(entry):
                return entry
        for ai_id in self._participant_ai_ids_for_group(group_id):
            entry = self._directory_entry_for_ai_id(ai_id)
            if isinstance(entry, dict):
                return entry
        return None

    def _expected_group_participant_names(self) -> list[str]:
        group_id = self._kindroid_group_id_for_url(self.webview.url())
        names: list[str] = []
        for ai_id in self._participant_ai_ids_for_group(group_id):
            entry = self._directory_entry_for_ai_id(ai_id)
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name", "")).strip()
            if name:
                names.append(name)
            for alias in self._entry_group_aliases(entry):
                if alias:
                    names.append(alias)
        return names

    def _group_person_key(self, person: dict) -> str:
        group_id = self._kindroid_group_id_for_url(self.webview.url())
        identity = str(person.get("ai_id", "") or person.get("name", "")).strip()
        return f"{group_id}:{identity}"

    def _ensure_group_avatar_people(self, force: bool = False) -> None:
        if not force and not getattr(self, "_group_avatar_window_requested", False):
            return
        panel = getattr(self, "communication_avatar_panel", None)
        if panel is None:
            return
        group_id = self._kindroid_group_id_for_url(self.webview.url())
        ai_ids = self._participant_ai_ids_for_group(group_id)
        signature = "|".join(ai_ids)
        if (
            not force
            and signature
            and signature == self._group_avatar_people_signature
            and getattr(panel, "isVisible", lambda: False)()
        ):
            return
        people: list[dict] = []
        for ai_id in ai_ids:
            entry = self._directory_entry_for_ai_id(ai_id)
            if not isinstance(entry, dict):
                continue
            pair_scope_key = (
                f"{self.webview.url().toString().split('?', 1)[0]}"
                f"::{str(entry.get('ai_id', '') or entry.get('name', '')).strip()}"
            )
            payload = self._entry_with_random_communication_pair(entry, scope_key=pair_scope_key)
            if not isinstance(payload, dict):
                continue
            payload = dict(payload)
            payload["_kxl_group_key"] = self._group_person_key(entry)
            payload["_kxl_pair_scope_key"] = pair_scope_key
            people.append(payload)
        if not people:
            return
        missing_video = [
            str(person.get("name", "")).strip() or str(person.get("ai_id", "")).strip()
            for person in people
            if not CommunicationAvatarPanel._person_has_video_pair(person)
        ]
        if missing_video:
            self._debug_group_avatar("group-window missing-video=" + ", ".join(missing_video[:12]))
        self._group_avatar_people_signature = signature
        panel.set_group_people(people)
        self._group_avatar_loaded_key = "group-grid"
        if any(CommunicationAvatarPanel._person_has_video_pair(person) for person in people):
            self._avatar_audio_probe_timer.start()
        self._debug_group_avatar(f"group-window participants={len(people)}")


    def _communication_pairs_for_person(self, person: dict) -> list[dict[str, object]]:
        pairs: list[dict[str, object]] = []
        pairs_key = "pregnancy_communication_video_pairs" if self.uses_pregnancy_communication_video_pairs(person) else "communication_video_pairs"
        raw_pairs = person.get(pairs_key, [])
        if isinstance(raw_pairs, list):
            for index, pair in enumerate(raw_pairs):
                if not isinstance(pair, dict):
                    continue
                idle = str(pair.get("idle", pair.get("idle_path", ""))).strip()
                talking = str(pair.get("talking", pair.get("talking_path", ""))).strip()
                if idle and talking and Path(idle).is_file() and Path(talking).is_file():
                    pairs.append({
                        "index": index,
                        "idle": idle,
                        "talking": talking,
                        "label": str(pair.get("label", f"Pair {index + 1}")).strip() or f"Pair {index + 1}",
                    })
        return pairs

    def _communication_pair_thumbnail(self, video_path: str, generate_missing: bool = True, timeout_seconds: int = 8) -> QPixmap:
        source = Path(video_path)
        cache_dir = APP_DATA_DIR / "communication_avatar_thumbnails"
        cache_dir.mkdir(parents=True, exist_ok=True)
        stat_token = ""
        try:
            stat = source.stat()
            stat_token = f"{stat.st_mtime_ns}:{stat.st_size}"
        except OSError:
            pass
        digest = hashlib.sha1(f"{source}:{stat_token}".encode("utf-8", errors="ignore")).hexdigest()
        thumb_path = cache_dir / f"{digest}.jpg"
        if generate_missing and not thumb_path.exists():
            ffmpeg = shutil.which("ffmpeg")
            if ffmpeg:
                try:
                    subprocess.run(
                        [ffmpeg, "-y", "-ss", "0.5", "-i", str(source), "-frames:v", "1", "-vf", "scale=180:-1", str(thumb_path)],
                        check=False,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=max(1, int(timeout_seconds)),
                    )
                except (OSError, subprocess.SubprocessError):
                    pass
        pixmap = QPixmap(str(thumb_path)) if thumb_path.exists() else QPixmap()
        if pixmap.isNull():
            pixmap = QPixmap(180, 104)
            pixmap.fill(QColor("#0b1424"))
        return pixmap.scaled(QSize(180, 104), Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)

    def _set_communication_pair_lock_for_key(self, key: str, pair: dict[str, object]) -> None:
        try:
            selected_index = int(pair.get("index", -1))
        except (TypeError, ValueError):
            selected_index = -1
        self._communication_avatar_pair_locks[key] = {
            "day": int(time.time() // 86400),
            "pairs_key": str(pair.get("pairs_key", "")),
            "index": selected_index,
            "idle": str(pair.get("idle", "")),
            "talking": str(pair.get("talking", "")),
            "label": str(pair.get("label", "")),
            "selected_at": int(time.time()),
        }
        self.config["communication_avatar_pair_locks"] = self._communication_avatar_pair_locks
        self._save_config(self.config)

    def _randomize_group_communication_pair(self, group_person_key: str) -> None:
        clean_group_person_key = str(group_person_key or "").strip()
        if not clean_group_person_key:
            return
        group_id = self._kindroid_group_id_for_url(self.webview.url())
        page_scope = self.webview.url().toString().split("?", 1)[0]
        for ai_id in self._participant_ai_ids_for_group(group_id):
            entry = self._directory_entry_for_ai_id(ai_id)
            if not isinstance(entry, dict) or self._group_person_key(entry) != clean_group_person_key:
                continue
            pairs = self._communication_pairs_for_person(entry)
            if not pairs:
                QMessageBox.information(self, "Choose Video Pair", "This person has no saved communication video pairs to choose from.")
                return
            pair_scope_key = f"{page_scope}::{str(entry.get('ai_id', '') or entry.get('name', '')).strip()}"
            self._show_group_pair_chooser(entry, pair_scope_key, pairs)
            return

    def _show_group_pair_chooser(self, person: dict, pair_scope_key: str, pairs: list[dict[str, object]]) -> None:
        panel = getattr(self, "communication_avatar_panel", None)
        dialog_parent = panel if panel is not None and panel.isVisible() else self
        dialog = QDialog(dialog_parent)
        dialog.setWindowTitle(f"Choose today's video pair • {person.get('name', 'Kindroid')}")
        dialog.setWindowModality(Qt.WindowModality.WindowModal)
        dialog.resize(720, 520)
        layout = QVBoxLayout(dialog)
        intro = QLabel("Choose the idle/talking video pair to use for this person today.", dialog)
        intro.setWordWrap(True)
        layout.addWidget(intro)
        scroll = QScrollArea(dialog)
        scroll.setWidgetResizable(True)
        content = QWidget(scroll)
        grid = QGridLayout(content)
        grid.setSpacing(12)
        selected: dict[str, object] = {}

        def choose(pair: dict[str, object]) -> None:
            selected.clear()
            selected.update(pair)
            dialog.accept()

        for idx, pair in enumerate(pairs):
            card = QFrame(content)
            card.setStyleSheet("QFrame { background:#08111f; border:1px solid #2b4773; border-radius:12px; } QLabel { color:#eaf3ff; }")
            card_layout = QVBoxLayout(card)
            title = QLabel(str(pair.get("label", f"Pair {idx + 1}")), card)
            title.setStyleSheet("font-weight:900; color:#7dd3fc;")
            thumb = QLabel(card)
            thumb.setAlignment(Qt.AlignmentFlag.AlignCenter)
            thumb.setPixmap(self._communication_pair_thumbnail(str(pair.get("idle", "")), generate_missing=False))
            files = QLabel(f"Idle: {Path(str(pair.get('idle', ''))).name}\nTalking: {Path(str(pair.get('talking', ''))).name}", card)
            files.setWordWrap(True)
            button = QPushButton("Use this pair today", card)
            button.clicked.connect(lambda _checked=False, p=pair: choose(p))
            card_layout.addWidget(title)
            card_layout.addWidget(thumb)
            card_layout.addWidget(files)
            card_layout.addWidget(button)
            grid.addWidget(card, idx // 3, idx % 3)
        scroll.setWidget(content)
        layout.addWidget(scroll, 1)
        cancel_row = QHBoxLayout()
        cancel_row.addStretch(1)
        cancel_btn = QPushButton("Cancel", dialog)
        cancel_btn.clicked.connect(dialog.reject)
        cancel_row.addWidget(cancel_btn)
        layout.addLayout(cancel_row)
        def finish(result: int) -> None:
            if result != int(QDialog.DialogCode.Accepted) or not selected:
                return
            self._set_communication_pair_lock_for_key(pair_scope_key, selected)
            self._group_avatar_people_signature = ""
            self._ensure_group_avatar_people(force=True)

        dialog.finished.connect(finish)
        self._group_pair_chooser_dialog = dialog
        dialog.open()
        dialog.raise_()
        dialog.activateWindow()

    def _suspend_group_communication_avatar_media(self) -> None:
        """Pause group avatar media before Kindroid navigation/reload.

        Sync Now used to clear the GROUP COMMS grid here, which destroys several
        QMediaPlayer/QVideoWidget objects immediately before Chromium navigates.
        That teardown race can terminate the whole Qt process without a Python
        traceback.  Keep the existing players alive, paused, and hidden during
        navigation; the normal refresh path can update/rebuild them after the
        call page settles.
        """
        if hasattr(self, "_group_avatar_probe_timer"):
            self._group_avatar_probe_timer.stop()
        if hasattr(self, "_avatar_audio_probe_timer"):
            self._avatar_audio_probe_timer.stop()
        self._group_avatar_candidate_key = ""
        self._group_avatar_candidate_since_ms = 0
        self._group_avatar_loaded_key = ""
        self._group_avatar_last_snapshot = {}
        self._group_avatar_mute_until_ms = 0
        self._group_avatar_force_audio_until_ms = 0
        self._group_avatar_last_forced_audio_key = ""
        self._group_avatar_last_selected_name = ""
        self._group_avatar_last_good_candidate_ms = 0
        self._group_avatar_people_signature = ""
        panel = getattr(self, "communication_avatar_panel", None)
        if panel is not None and hasattr(panel, "suspend_group_media_for_navigation"):
            panel.suspend_group_media_for_navigation()

    def _force_refresh_group_communication_avatar_people(self) -> None:
        self._group_avatar_window_requested = True
        self._debug_group_avatar("group-avatar-requested")
        if self._is_kindroid_group_url(self.webview.url()):
            if not self._group_avatar_probe_timer.isActive():
                self._group_avatar_probe_timer.start()
            panel = getattr(self, "communication_avatar_panel", None)
            if panel is not None and getattr(panel, "isVisible", lambda: False)() and self._group_avatar_people_signature:
                panel.show()
                panel.raise_()
                panel.activateWindow()
                self._ensure_group_avatar_people(force=False)
                return
            self._group_avatar_people_signature = ""
            self._ensure_group_avatar_people(force=True)

    def _on_communication_avatar_dismissed(self) -> None:
        self._communication_avatar_window_requested = False
        self._group_avatar_window_requested = False
        if hasattr(self, "_group_avatar_probe_timer"):
            self._group_avatar_probe_timer.stop()

    def _ensure_group_avatar_default_person(self) -> None:
        if self._group_avatar_loaded_key:
            return
        person = self._first_group_directory_entry()
        if not isinstance(person, dict):
            return
        participant = {
            "name": str(person.get("name", "")).strip(),
            "normalizedName": self._normalize_group_avatar_name(person.get("name", "")),
            "storageCharacterId": str(person.get("ai_id", "")).strip(),
            "selectedSource": "groupmaker-default",
        }
        candidate_key = f"{self._kindroid_group_id_for_url(self.webview.url())}:default:{participant['storageCharacterId']}"
        self._load_group_avatar_person(candidate_key, participant, person)
        self._debug_group_avatar(f"default-loaded={participant.get('name', '')}")

    def _directory_entry_for_group_participant(self, participant: dict) -> dict | None:
        entries = [entry for entry in self.get_directory_entries() if isinstance(entry, dict)]
        storage_id = str(participant.get("storageCharacterId", "")).strip()
        id_fields = (
            "ai_id", "kindroid_id", "kindroid_media_id", "kindroid_character_id",
            "communication_group_id", "communication_group_ids", "group_match_id", "group_match_ids",
        )
        group_ai_ids = set(self._participant_ai_ids_for_group(self._kindroid_group_id_for_url(self.webview.url())))

        def values_for(entry: dict, field: str) -> list[str]:
            raw = entry.get(field, "")
            if isinstance(raw, list):
                return [str(item).strip() for item in raw if str(item).strip()]
            return [str(raw).strip()] if str(raw).strip() else []

        matches: list[dict] = []
        if storage_id:
            for entry in entries:
                if any(storage_id in values_for(entry, field) for field in id_fields):
                    matches.append(entry)
        if not matches:
            names = {
                self._normalize_group_avatar_name(participant.get("name", "")),
                self._normalize_group_avatar_name(participant.get("imgAlt", "")),
                self._normalize_group_avatar_name(participant.get("normalizedName", "")),
            }
            names.discard("")

            def name_matches(left: str, right: str) -> bool:
                if not left or not right:
                    return False
                if left == right or left in right or right in left:
                    return True
                left_first = left.split()[0] if left.split() else ""
                right_first = right.split()[0] if right.split() else ""
                return bool(left_first and right_first and left_first == right_first)

            for entry in entries:
                entry_names = {self._normalize_group_avatar_name(entry.get("name", ""))}
                entry_names.update(self._normalize_group_avatar_name(alias) for alias in self._entry_group_aliases(entry))
                if any(name_matches(name, entry_name) for name in names for entry_name in entry_names):
                    matches.append(entry)
        if not matches:
            return None
        if group_ai_ids:
            scoped = [entry for entry in matches if str(entry.get("ai_id", "")).strip() in group_ai_ids]
            if scoped:
                matches = scoped
        video_matches = [entry for entry in matches if CommunicationAvatarPanel._person_has_video_pair(entry)]
        if len(video_matches) == 1:
            return video_matches[0]
        if len(matches) == 1:
            return matches[0]
        self._debug_group_avatar("ambiguous-match", participant)
        return None

    def _group_candidate_key(self, participant: dict) -> str:
        group_id = self._kindroid_group_id_for_url(self.webview.url())
        identity = str(participant.get("storageCharacterId", "")).strip()
        if not identity:
            identity = str(participant.get("normalizedName", "") or participant.get("name", "")).strip()
        return f"{group_id}:{identity}"

    def _group_candidate_key_for_person(self, person: dict) -> str:
        return self._group_person_key(person)

    def _group_pair_scope_key(self, person: dict, participant: dict) -> str:
        url = self.webview.url().toString().split("?", 1)[0]
        identity = str(person.get("ai_id", "") or participant.get("storageCharacterId", "") or person.get("name", "")).strip()
        return f"{url}::{identity}"

    def _poll_kindroid_group_participants(self) -> None:
        if not self._is_kindroid_group_url(self.webview.url()):
            self._stop_group_communication_avatar_mode()
            return
        if not getattr(self, "_group_avatar_window_requested", False):
            self._group_avatar_probe_timer.stop()
            return
        self._ensure_group_avatar_people()
        expected_names = self._expected_group_participant_names()
        group_probe_source = ""
        group_probe_path = APP_ROOT / "modules" / "kindroid_group_participant_probe.js"
        if group_probe_path.exists():
            try:
                group_probe_source = group_probe_path.read_text(encoding="utf-8")
            except OSError:
                group_probe_source = ""
        script = (
            "(() => { try {"
            f"window.__kxlExpectedGroupParticipantNames = {json.dumps(expected_names)};"
            f"window.__kxlGroupParticipantProbeConsoleDebugEnabled = {str(bool(getattr(self, '_group_avatar_debug_enabled', False))).lower()};"
            "if (!window.__kxlGroupParticipantProbe || !window.__kxlGroupParticipantProbe.snapshot) {"
            f"const probeSource = {json.dumps(group_probe_source)};"
            "if (probeSource) { (0, eval)(probeSource); }"
            "}"
            "if (!window.__kxlGroupParticipantProbe || !window.__kxlGroupParticipantProbe.snapshot) {"
            "return JSON.stringify({ ok: false, error: 'group participant probe not loaded' });"
            "}"
            "const result = window.__kxlGroupParticipantProbe.snapshot();"
            "window.__kxlGroupParticipantProbeLastSnapshot = result;"
            "return JSON.stringify(result);"
            "} catch (error) { return JSON.stringify({ ok: false, error: String(error && (error.stack || error.message || error)) }); } })();"
        )
        self.webpage.runJavaScript(script, self._handle_group_participant_snapshot)

    def _poll_groupmaker_sync_now_request(self) -> None:
        page = getattr(self, "webpage", None)
        if page is None:
            return
        script = (
            "(() => { try {"
            "const key = 'kxl:groupmaker-sync-now-request';"
            "const value = window.__KXL_GROUPMAKER_SYNC_NOW_REQUEST || localStorage.getItem(key) || '';"
            "if (!value) return '';"
            "window.__KXL_GROUPMAKER_SYNC_NOW_REQUEST = '';"
            "localStorage.removeItem(key);"
            "return String(value);"
            "} catch (_error) { return ''; } })();"
        )
        page.runJavaScript(script, self._handle_groupmaker_sync_now_request)

    def _handle_groupmaker_sync_now_request(self, request_id: object) -> None:
        if not str(request_id or "").strip():
            return
        page = getattr(self, "webpage", None)
        if page is not None and hasattr(page, "_request_groupmaker_sync_now"):
            page._request_groupmaker_sync_now()  # pylint: disable=protected-access


    def _force_group_avatar_audio_activity(self, active_key: str, duration_ms: int = 75) -> None:
        clean_key = str(active_key or "").strip()
        if not clean_key:
            return
        if clean_key == str(getattr(self, "_group_avatar_last_forced_audio_key", "") or ""):
            return
        now = int(time.monotonic() * 1000)
        self._group_avatar_last_forced_audio_key = clean_key
        self._group_avatar_force_audio_until_ms = now + max(25, int(duration_ms))
        # Do not directly set the panel audio level here. The real audio probe
        # should remain in charge; this only gives the next audio probe tick a
        # tiny bridge window when a speaker handoff and audio signal race.

    def _handle_group_participant_snapshot(self, result: object) -> None:
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except json.JSONDecodeError:
                self._debug_group_avatar(f"probe-json-error={result[:500]}")
                return
        if not isinstance(result, dict) or not result.get("ok"):
            self._debug_group_avatar(f"probe-error={result}")
            return
        self._group_avatar_last_snapshot = result
        self._debug_group_avatar_snapshot(result)
        selected = result.get("selectedParticipant")
        if not isinstance(selected, dict):
            self._group_avatar_last_forced_audio_key = ""
            self._maybe_clear_group_avatar_after_timeout()
            return
        selected_source = str(selected.get("selectedSource", "") or "")
        missing_expected_active = selected_source == "missing-expected-active"
        person = self._directory_entry_for_group_participant(selected)
        if not isinstance(person, dict):
            panel = getattr(self, "communication_avatar_panel", None)
            if panel is not None and hasattr(panel, "set_group_active_name"):
                active_name = str(selected.get("name", "") or selected.get("normalizedName", ""))
                if missing_expected_active and not self._missing_expected_group_candidate_stable(active_name):
                    return
                if panel.set_group_active_name(active_name):
                    self._force_group_avatar_audio_activity(active_name)
                    self._group_avatar_last_good_candidate_ms = int(time.monotonic() * 1000)
                    self._debug_group_avatar(f"active-name={selected.get('name', '')}")
                    return
            self._debug_group_avatar("no-directory-match", selected)
            self._maybe_clear_group_avatar_after_timeout()
            return
        if missing_expected_active:
            self._apply_group_avatar_candidate(selected, person, result)
            return
        panel = getattr(self, "communication_avatar_panel", None)
        if panel is not None and hasattr(panel, "set_group_active_key"):
            candidate_key = self._group_candidate_key_for_person(person)
            panel.set_group_active_key(candidate_key)
            self._force_group_avatar_audio_activity(candidate_key)
            if hasattr(panel, "set_group_active_name"):
                panel.set_group_active_name(str(selected.get("name", "") or selected.get("normalizedName", "")))
            self._group_avatar_candidate_key = candidate_key
            self._group_avatar_loaded_key = "group-grid"
            self._group_avatar_last_good_candidate_ms = int(time.monotonic() * 1000)
            self._debug_group_avatar(f"active={selected.get('name', '')} key={candidate_key}")
            return
        self._apply_group_avatar_candidate(selected, person, result)

    def _missing_expected_group_candidate_stable(self, active_name: str) -> bool:
        now = int(time.monotonic() * 1000)
        candidate_key = f"missing-name:{self._normalize_group_avatar_name(active_name)}"
        if candidate_key != self._group_avatar_candidate_key:
            self._group_avatar_candidate_key = candidate_key
            self._group_avatar_candidate_since_ms = now
            self._debug_group_avatar(f"candidate={active_name} source=missing-expected-active key={candidate_key}")
            return False
        return now - self._group_avatar_candidate_since_ms >= 220

    def _apply_group_avatar_candidate(self, selected: dict, person: dict, _snapshot: dict) -> None:
        now = int(time.monotonic() * 1000)
        candidate_key = self._group_candidate_key_for_person(person)
        if candidate_key != self._group_avatar_candidate_key:
            self._group_avatar_candidate_key = candidate_key
            self._group_avatar_candidate_since_ms = now
            self._debug_group_avatar(f"candidate={selected.get('name', '')} source={selected.get('selectedSource', '')} key={candidate_key}")
            return
        if now - self._group_avatar_candidate_since_ms < 220:
            return
        self._group_avatar_last_good_candidate_ms = now
        panel = getattr(self, "communication_avatar_panel", None)
        if panel is not None and hasattr(panel, "set_group_active_key"):
            panel.set_group_active_key(candidate_key)
            self._force_group_avatar_audio_activity(candidate_key)
            self._group_avatar_loaded_key = "group-grid"
            self._debug_group_avatar(f"active={selected.get('name', '')} key={candidate_key}")
            return
        if candidate_key == self._group_avatar_loaded_key:
            return
        self._load_group_avatar_person(candidate_key, selected, person)

    def _load_group_avatar_person(self, candidate_key: str, participant: dict, person: dict) -> None:
        panel = getattr(self, "communication_avatar_panel", None)
        if panel is None:
            return
        payload = self._entry_with_random_communication_pair(person, scope_key=self._group_pair_scope_key(person, participant))
        panel.set_person(payload)
        self._group_avatar_loaded_key = candidate_key
        now = int(time.monotonic() * 1000)
        self._group_avatar_last_good_candidate_ms = now
        panel.set_audio_level(0.0, now)
        self._group_avatar_mute_until_ms = now + 180
        label = payload.get("communication_selected_pair_label", "") if isinstance(payload, dict) else ""
        self._debug_group_avatar(f"loaded={participant.get('name', '')} pair={label}")
        if payload and CommunicationAvatarPanel._person_has_video_pair(payload):
            self._avatar_audio_probe_timer.start()
        else:
            self._avatar_audio_probe_timer.stop()

    def _maybe_clear_group_avatar_after_timeout(self) -> None:
        panel = getattr(self, "communication_avatar_panel", None)
        if panel is None:
            return
        now = int(time.monotonic() * 1000)
        if self._first_group_directory_entry() is not None:
            if self._group_avatar_loaded_key:
                panel.set_audio_level(0.0, now)
            return
        if self._group_avatar_last_good_candidate_ms and now - self._group_avatar_last_good_candidate_ms < 2500:
            panel.set_audio_level(0.0, now)
            return
        if self._group_avatar_loaded_key:
            panel.set_audio_level(0.0, now)
            panel.set_person(None)
            self._avatar_audio_probe_timer.stop()
            self._group_avatar_loaded_key = ""
            self._debug_group_avatar("cleared=no-reliable-candidate")

    def _debug_group_avatar(self, message: str, participant: dict | None = None) -> None:
        if not DEBUG_CONSOLE_OUTPUT or not getattr(self, "_group_avatar_debug_enabled", False):
            return
        if participant is not None:
            message = f"{message} name={participant.get('name', '')} id={participant.get('storageCharacterId', '')}"
        if message == getattr(self, "_group_avatar_last_debug_message", ""):
            return
        self._group_avatar_last_debug_message = message
        print(f"[GROUP AVATAR] {message}")

    def _debug_group_avatar_snapshot(self, snapshot: dict) -> None:
        if not DEBUG_CONSOLE_OUTPUT or not getattr(self, "_group_avatar_debug_enabled", False):
            return
        participants = snapshot.get("participants", [])
        if not isinstance(participants, list):
            return
        debug = snapshot.get("debug", {})
        if not isinstance(debug, dict):
            debug = {}
        expected = snapshot.get("expectedNames", [])
        missing = snapshot.get("missingExpected", [])
        if not isinstance(expected, list):
            expected = []
        if not isinstance(missing, list):
            missing = []
        lines = [f"page participants: detected={len(participants)} expected={len(expected)} missing={len(missing)}"]
        if expected:
            lines.append("expected=" + ", ".join(str(name) for name in expected[:12]))
        if missing:
            lines.append("missing=" + ", ".join(str(name) for name in missing[:12]))
        for participant in participants:
            if not isinstance(participant, dict):
                continue
            lines.append(
                f"- {participant.get('name', '')} class={participant.get('cardClass', '')} "
                f"selected={str(bool(participant.get('selected', False))).lower()} "
                f"source={participant.get('selectedSource', '')}"
            )
        lines.append(f"majority={debug.get('majorityClass', '')} outlier={debug.get('outlierClass', '')}")
        self._debug_group_avatar("\n".join(lines))

    def _poll_kindroid_audio_probe(self) -> None:
        if self._kindroid_page_recently_audible():
            self._handle_kindroid_audio_probe_result({"level": 1.0, "mode": "page_audible"})
            return
        script = (
            "(() => {"
            "if (window.__kxlAudioProbe && window.__kxlAudioProbe.snapshot) "
            "return window.__kxlAudioProbe.snapshot();"
            "return { level: 0, mode: 'probe_missing' };"
            "})()"
        )
        self.webpage.runJavaScript(script, self._handle_kindroid_audio_probe_result)

    def _kindroid_page_recently_audible(self) -> bool:
        recently_audible = getattr(self.webpage, "recentlyAudible", None)
        if callable(recently_audible):
            try:
                return bool(recently_audible())
            except TypeError:
                return False
        if recently_audible is not None:
            return bool(recently_audible)
        return False

    def _on_kindroid_recently_audible_changed(self, audible: bool) -> None:
        self._handle_kindroid_audio_probe_result({"level": 1.0 if audible else 0.0, "mode": "page_audible_signal"})

    def _handle_kindroid_audio_probe_result(self, result: object) -> None:
        level = 0.0
        if isinstance(result, dict):
            try:
                level = float(result.get("level", 0.0))
            except (TypeError, ValueError):
                level = 0.0
        now = int(time.monotonic() * 1000)
        if self._is_kindroid_group_url(self.webview.url()) and now < self._group_avatar_mute_until_ms:
            level = 0.0
        if self._is_kindroid_group_url(self.webview.url()) and now < int(getattr(self, "_group_avatar_force_audio_until_ms", 0) or 0):
            level = max(level, 1.0)
        self._on_communication_audio_level(level)
        panel = getattr(self, "communication_avatar_panel", None)
        if panel is not None:
            panel.set_audio_level(level, now)

    def _start_kindroid_tab_audio_probe(self) -> None:
        script = (
            "(() => {"
            "if (window.__kxlAudioProbe && window.__kxlAudioProbe.startTabCapture) "
            "return window.__kxlAudioProbe.startTabCapture();"
            "return false;"
            "})()"
        )
        self.webpage.runJavaScript(script)

    @Slot(float)
    def _on_communication_audio_level(self, level: float) -> None:
        self._communication_audio_level = max(0.0, min(float(level), 1.0))
        if hasattr(self, "communication_audio_indicator"):
            self.communication_audio_indicator.set_level(self._communication_audio_level)
        if hasattr(self, "settings_tab") and hasattr(self.settings_tab, "comm_mode_settings_indicator"):
            self.settings_tab.comm_mode_settings_indicator.set_level(self._communication_audio_level)

    @Slot(str)
    def _on_communication_audio_error(self, message: str) -> None:
        self._comm_stop_signal.emit()
        self._on_communication_audio_level(0.0)
        self._communication_mode_enabled = False
        self.config["communication_mode_enabled"] = False
        self._save_config(self.config)
        self.communication_mode_toggle.setChecked(False)
        self.communication_status_label.setText(message)
        if hasattr(self, "settings_tab") and hasattr(self.settings_tab, "comm_mode_settings_status"):
            self.settings_tab.comm_mode_settings_status.setText(message)

    def _is_trusted_origin(self, security_origin: QUrl) -> bool:
        host = security_origin.host().lower()
        return host == "kindroid.ai" or host.endswith(".kindroid.ai")

    def _enable_web_capture_settings(self) -> None:
        """Enable WebEngine features required by the Kindroid tab recorder."""
        try:
            settings = self.webpage.settings()
            attrs = getattr(QWebEngineSettings, "WebAttribute", QWebEngineSettings)
            for attr_name in (
                "ScreenCaptureEnabled",
                "FullScreenSupportEnabled",
                "PlaybackRequiresUserGesture",
            ):
                attr = getattr(attrs, attr_name, None)
                if attr is None:
                    continue
                settings.setAttribute(attr, attr_name != "PlaybackRequiresUserGesture")
        except Exception as exc:  # pragma: no cover - depends on Qt WebEngine runtime
            self._debug_group_avatar(f"web-capture-settings-error={exc}")

    def _handle_feature_permission_request(
        self,
        security_origin: QUrl,
        feature: QWebEnginePage.Feature,
    ) -> None:
        trusted_origin = self._is_trusted_origin(security_origin)
        allow_features = {
            QWebEnginePage.Feature.MediaAudioCapture,
            QWebEnginePage.Feature.MediaVideoCapture,
            QWebEnginePage.Feature.MediaAudioVideoCapture,
            QWebEnginePage.Feature.DesktopVideoCapture,
            QWebEnginePage.Feature.DesktopAudioVideoCapture,
        }
        policy = QWebEnginePage.PermissionPolicy.PermissionDeniedByUser
        if trusted_origin and feature in allow_features:
            policy = QWebEnginePage.PermissionPolicy.PermissionGrantedByUser
        page = self.sender()
        if isinstance(page, QWebEnginePage):
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore",
                    category=DeprecationWarning,
                    message=".*setFeaturePermission.*|.*QWebEnginePage::Feature.*|.*PermissionPolicy.*",
                )
                page.setFeaturePermission(security_origin, feature, policy)

    def _handle_desktop_media_request(self, request) -> None:
        """Accept Qt WebEngine getDisplayMedia requests.

        Qt 6.7+ does not show Chromium's native screen picker automatically for
        embedded QWebEnginePage. The app must answer desktopMediaRequested by
        selecting a screen/window, otherwise getDisplayMedia waits forever and
        the UI looks like it is waiting for a prompt that never appears.
        """
        try:
            screens_model = request.screensModel() if hasattr(request, "screensModel") else None
            if screens_model is not None and screens_model.rowCount() > 0:
                request.selectScreen(screens_model.index(0, 0))
                return
            windows_model = request.windowsModel() if hasattr(request, "windowsModel") else None
            if windows_model is not None and windows_model.rowCount() > 0:
                request.selectWindow(windows_model.index(0, 0))
                return
            if hasattr(request, "cancel"):
                request.cancel()
        except Exception as exc:  # pragma: no cover - depends on Qt WebEngine runtime
            self._debug_group_avatar(f"desktop-media-request-error={exc}")
            try:
                if hasattr(request, "cancel"):
                    request.cancel()
            except Exception:
                pass

    def _start_tab_recording(self) -> None:
        if self._tab_recording_active:
            QMessageBox.information(self, "Tab recording", "Recording is already running.")
            return
        audio_only = self.record_mode_combo.currentIndex() == 1
        self._tab_recording_start_checks = 0
        self.start_record_btn.setEnabled(False)
        script = f"""
(() => {{
  const existingRecorder = window.__kxlTabRecorder && window.__kxlTabRecorder.mediaRecorder;
  if (existingRecorder && existingRecorder.state === 'recording') {{
    return {{ ok: true, message: 'already-recording' }};
  }}
  const canCapture = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  if (!canCapture) {{
    return {{ ok: false, message: 'unsupported' }};
  }}
  const audioOnly = {str(True).lower() if audio_only else str(False).lower()};
  window.__kxlTabRecorderStatus = 'armed';

  const removeOverlay = () => {{
    const old = document.getElementById('__kxl_recorder_overlay');
    if (old) old.remove();
  }};

  const beginCapture = () => {{
    removeOverlay();
    window.__kxlTabRecorderStatus = 'starting';
    navigator.mediaDevices.getDisplayMedia({{
      video: audioOnly ? true : {{ frameRate: {{ ideal: 30, max: 60 }} }},
      audio: true,
      preferCurrentTab: true
    }}).then((stream) => {{
      const sourceStream = audioOnly
        ? new MediaStream(stream.getAudioTracks())
        : stream;
      const chunks = [];
      let mimeType = '';
      const mimeCandidates = audioOnly
        ? ['audio/webm;codecs=opus', 'audio/webm']
        : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
      for (const candidate of mimeCandidates) {{
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidate)) {{
          mimeType = candidate;
          break;
        }}
      }}
      const recorder = mimeType ? new MediaRecorder(sourceStream, {{ mimeType }}) : new MediaRecorder(sourceStream);
      recorder.ondataavailable = (event) => {{
        if (event.data && event.data.size > 0) chunks.push(event.data);
      }};
      recorder.onstop = () => {{
        const fallbackType = audioOnly ? 'audio/webm' : 'video/webm';
        const blob = new Blob(chunks, {{ type: recorder.mimeType || fallbackType }});
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const link = document.createElement('a');
        link.href = url;
        link.download = (audioOnly ? 'kindroid-audio-' : 'kindroid-tab-') + stamp + '.webm';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 8000);
        stream.getTracks().forEach((track) => track.stop());
        window.__kxlTabRecorder = null;
        window.__kxlTabRecorderStatus = 'stopped';
      }};
      stream.getVideoTracks().forEach((track) => {{
        track.onended = () => {{
          if (recorder.state !== 'inactive') recorder.stop();
        }};
      }});
      recorder.start(1000);
      window.__kxlTabRecorder = {{ stream, mediaRecorder: recorder, audioOnly }};
      window.__kxlTabRecorderStatus = 'started';
    }}).catch((error) => {{
      const name = error && error.name ? error.name : 'CaptureError';
      const message = error && error.message ? error.message : String(error || 'capture-failed');
      window.__kxlTabRecorderStatus = name + ': ' + message;
    }});
  }};

  removeOverlay();
  const overlay = document.createElement('div');
  overlay.id = '__kxl_recorder_overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(8,0,24,.72);display:flex;align-items:center;justify-content:center;font-family:Inter,Arial,sans-serif;';
  overlay.innerHTML = `
    <div style="background:#181022;color:#fff;border:2px solid #8b5cf6;border-radius:18px;box-shadow:0 16px 60px rgba(0,0,0,.45);padding:28px;max-width:520px;text-align:center;">
      <div style="font-size:22px;font-weight:800;margin-bottom:10px;">KINDROIDXL Recorder</div>
      <div style="font-size:14px;line-height:1.45;margin-bottom:18px;color:#ddd;">Clicking inside this page gives the browser the user gesture it requires before screen/audio capture can start.</div>
      <button id="__kxl_recorder_start" style="background:#7c3aed;color:white;border:0;border-radius:12px;padding:14px 22px;font-weight:900;font-size:15px;cursor:pointer;">START CAPTURE NOW</button>
      <button id="__kxl_recorder_cancel" style="margin-left:10px;background:#2d2438;color:#ddd;border:1px solid #665; border-radius:12px;padding:14px 18px;font-weight:800;cursor:pointer;">Cancel</button>
    </div>`;
  document.body.appendChild(overlay);
  const startButton = document.getElementById('__kxl_recorder_start');
  const cancelButton = document.getElementById('__kxl_recorder_cancel');
  if (!startButton || !cancelButton) {{
    window.__kxlTabRecorderStatus = 'overlay-button-missing';
    return {{ ok: false, message: 'overlay-button-missing' }};
  }}
  startButton.addEventListener('click', beginCapture, {{ once: true }});
  cancelButton.addEventListener('click', () => {{
    window.__kxlTabRecorderStatus = 'cancelled';
    removeOverlay();
  }}, {{ once: true }});
  return {{ ok: true, message: 'armed' }};
}})();
"""

        self.webview.page().runJavaScript(script, self._on_tab_recording_started)

    def _on_tab_recording_started(self, result) -> None:
        ok = isinstance(result, dict) and bool(result.get("ok"))
        if not ok:
            message = "Unable to arm tab recording inside the Kindroid page."
            if isinstance(result, dict) and str(result.get("message", "")).strip() == "unsupported":
                message = "This browser engine does not support tab capture in the current environment."
            QMessageBox.warning(self, "Tab recording", message)
            self.start_record_btn.setEnabled(True)
            self.stop_record_btn.setEnabled(False)
            return
        QMessageBox.information(
            self,
            "Tab recording ready",
            "A START CAPTURE NOW button was placed inside the Kindroid page. Click that in-page button to satisfy the browser's required user gesture and begin recording.",
        )
        QTimer.singleShot(500, self._finalize_tab_recording_start)

    def _finalize_tab_recording_start(self) -> None:
        script = """
(() => {
  const recorder = window.__kxlTabRecorder && window.__kxlTabRecorder.mediaRecorder;
  if (recorder && recorder.state === 'recording') {
    return { ok: true, message: 'started' };
  }
  return { ok: false, message: String(window.__kxlTabRecorderStatus || 'not-started') };
})();
"""
        self.webview.page().runJavaScript(script, self._handle_tab_recording_start_status)

    def _handle_tab_recording_start_status(self, result) -> None:
        ok = isinstance(result, dict) and bool(result.get("ok"))
        message_value = str(result.get("message", "")) if isinstance(result, dict) else ""
        if not ok and message_value in {"armed", "starting"} and getattr(self, "_tab_recording_start_checks", 0) < 240:
            self._tab_recording_start_checks += 1
            QTimer.singleShot(500, self._finalize_tab_recording_start)
            return
        if not ok:
            details = f"\n\nBrowser response: {message_value}" if message_value else ""
            message = (
                "Tab capture did not start. The embedded browser did not grant desktop capture. "
                "KINDROIDXL now enables Qt WebEngine screen capture directly; if your operating system still blocks it, "
                "allow this app in your system Screen Recording / Microphone privacy settings and try again."
                f"{details}"
            )
            QMessageBox.warning(self, "Tab recording", message)
            self._tab_recording_active = False
            self.start_record_btn.setEnabled(True)
            self.stop_record_btn.setEnabled(False)
            return
        self._tab_recording_active = True
        self.start_record_btn.setEnabled(False)
        self.stop_record_btn.setEnabled(True)
        QMessageBox.information(
            self,
            "Tab recording started",
            "Capture is running. Use Stop + Save when finished. If you chose Audio only, the saved file will contain the captured audio track.",
        )

    def _stop_tab_recording(self) -> None:
        if not self._tab_recording_active:
            QMessageBox.information(self, "Tab recording", "Recording is not running.")
            return
        script = """
(() => {
  const recorder = window.__kxlTabRecorder && window.__kxlTabRecorder.mediaRecorder;
  if (!recorder) return { ok: false, message: 'not-running' };
  if (recorder.state === 'inactive') return { ok: false, message: 'inactive' };
  recorder.stop();
  return { ok: true, message: 'stopped' };
})();
"""
        self.webview.page().runJavaScript(script, self._on_tab_recording_stopped)

    def _on_tab_recording_stopped(self, result) -> None:
        ok = isinstance(result, dict) and bool(result.get("ok"))
        self._tab_recording_active = False
        self._communication_mode_enabled = bool(self.config.get("communication_mode_enabled", False))
        self._communication_target_app = str(self.config.get("communication_target_app", "")).strip()
        self._communication_audio_level = 0.0
        self.start_record_btn.setEnabled(True)
        self.stop_record_btn.setEnabled(False)
        if ok:
            QMessageBox.information(
                self,
                "Recording saved",
                "Recording was stopped. Your browser download should save a .webm file locally.",
            )
            return
        QMessageBox.warning(
            self,
            "Tab recording",
            "Could not stop recording cleanly. If capture was ended from the share picker, no action is needed.",
        )

    def _apply_amoled_theme(self) -> None:
        self.setStyleSheet(
            """
            QMainWindow {
                background-color: #000000;
            }

            QTabWidget::pane {
                border: 1px solid #1d1d1d;
                border-radius: 18px;
                background: #000000;
                margin-top: 72px;
            }

            QTabBar::tab {
                min-width: 190px;
                min-height: 56px;
                margin-right: 10px;
                padding: 0 18px;
                border-radius: 16px;
                border: 1px solid #232323;
                background: #070707;
                font-size: 15px;
                font-weight: 800;
                letter-spacing: 0.6px;
            }

            QTabBar::tab:selected {
                color: #ffffff;
                border: 1px solid #7c3aed;
                background: qlineargradient(
                    x1:0, y1:0, x2:1, y2:1,
                    stop:0 #181127,
                    stop:1 #07070f
                );
            }

            QTabBar::tab:hover:!selected {
                background: #111111;
            }

            QToolBar {
                background: #000000;
                border: 1px solid #1d1d1d;
                border-radius: 14px;
                spacing: 12px;
                padding: 8px 12px;
                margin: 10px;
            }

            QCheckBox {
                color: #80ffea;
                font-size: 13px;
                font-weight: 600;
                spacing: 8px;
            }

            QCheckBox::indicator {
                width: 18px;
                height: 18px;
                border-radius: 6px;
                border: 1px solid #2f2f2f;
                background: #080808;
            }

            QCheckBox::indicator:checked {
                background: #00d084;
                border: 1px solid #20f2a3;
            }

            QPushButton {
                min-height: 42px;
                padding: 0 22px;
                border-radius: 12px;
                border: 1px solid #4f2eff;
                color: #ffffff;
                background: #160c33;
                font-size: 14px;
                font-weight: 700;
            }

            QPushButton:hover {
                background: #24134d;
            }

            QPushButton:pressed {
                background: #2d1860;
            }

            QLineEdit, QTextEdit, QComboBox {
                border: 1px solid #292929;
                border-radius: 12px;
                background: #07070a;
                color: #ecf1ff;
                selection-background-color: #3254d8;
                selection-color: #ffffff;
                min-height: 42px;
                padding: 7px 12px;
                font-size: 15px;
            }

            QComboBox::drop-down {
                border: none;
                width: 26px;
            }

            QComboBox QAbstractItemView {
                background: #060606;
                color: #ecf1ff;
                border: 1px solid #292929;
                selection-background-color: #2d4fc7;
                font-size: 14px;
                padding: 4px;
            }

            QListWidget {
                background: #07070a;
                border: 1px solid #202233;
                border-radius: 12px;
                padding: 8px;
                font-size: 15px;
                color: #f0f4ff;
                outline: none;
            }

            QListWidget::item {
                min-height: 30px;
                padding: 10px 12px;
                border-radius: 10px;
                margin: 2px 0;
            }

            QListWidget::item:selected {
                background: #223067;
                border: 1px solid #4567dc;
            }

            QListWidget::item:hover:!selected {
                background: #141b2f;
            }

            QAbstractScrollArea {
                background: transparent;
            }

            QScrollBar:vertical {
                border: none;
                background: #050507;
                width: 12px;
                margin: 6px 2px;
                border-radius: 6px;
            }

            QScrollBar::handle:vertical {
                background: #313a61;
                min-height: 32px;
                border-radius: 6px;
            }

            QScrollBar::handle:vertical:hover {
                background: #435390;
            }

            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical,
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {
                background: none;
                border: none;
                height: 0px;
            }

            QScrollBar:horizontal {
                border: none;
                background: #050507;
                height: 12px;
                margin: 2px 6px;
                border-radius: 6px;
            }

            QScrollBar::handle:horizontal {
                background: #313a61;
                min-width: 32px;
                border-radius: 6px;
            }

            QScrollBar::handle:horizontal:hover {
                background: #435390;
            }

            QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal,
            QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {
                background: none;
                border: none;
                width: 0px;
            }

            QLabel {
                color: #8ff7ff;
                font-size: 15px;
            }
            """
        )

    def _apply_tab_label_colors(self) -> None:
        palette = {
            "HOME": "#67E8F9",
            "KINDROID": "#00E5FF",
            "GROUPMAKER": "#60A5FA",
            "DIRECTORY": "#FF8A65",
            "HOUSE COUNCIL": "#A78BFA",
            "LOCATIONS": "#5EEAD4",
            "HOUSES": "#BA8CFF",
            "CALENDAR": "#22D3EE",
            "JOURNAL": "#FDE68A",
            "ADDONS": "#FF63D8",
            "FETCHER": "#C084FC",
            "FEEDER": "#F472B6",
            "SETTINGS": "#FCD34D",
        }
        tab_bar = self.tabs.tabBar()
        for index in range(self.tabs.count()):
            color = palette.get(self.tabs.tabText(index), "#d9e3ff")
            tab_bar.setTabTextColor(index, QColor(color))

    def _configure_primary_and_more_tabs(self) -> None:
        primary_tabs = {"HOME", "KINDROID", "GROUPMAKER", "DIRECTORY", "HOUSES", "CALENDAR"}
        tab_bar = self.tabs.tabBar()
        self.more_tabs_button = QToolButton(self.tabs)
        self.more_tabs_button.setText("MORE ▾")
        self.more_tabs_button.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.more_tabs_button.setCursor(Qt.PointingHandCursor)
        self.more_tabs_button.setStyleSheet(
            """
            QToolButton {
                min-width: 140px;
                min-height: 48px;
                padding: 0 16px;
                border-radius: 14px;
                border: 1px solid #36558a;
                color: #d9eaff;
                font-size: 14px;
                font-weight: 900;
                letter-spacing: 0.8px;
                background: qlineargradient(
                    x1:0, y1:0, x2:1, y2:1,
                    stop:0 #10203b,
                    stop:1 #1f2f4d
                );
            }
            QToolButton:hover {
                border: 1px solid #73a6ff;
                background: qlineargradient(
                    x1:0, y1:0, x2:1, y2:1,
                    stop:0 #1a335d,
                    stop:1 #2a4067
                );
            }
            """
        )
        more_menu = QMenu(self.more_tabs_button)
        more_menu.setStyleSheet(
            """
            QMenu {
                background: qlineargradient(
                    x1:0, y1:0, x2:1, y2:1,
                    stop:0 #060b18,
                    stop:1 #111b2f
                );
                border: 1px solid #2b3f63;
                border-radius: 16px;
                padding: 12px;
                color: #dce9ff;
                font-size: 14px;
                font-weight: 700;
            }
            QMenu::item {
                min-width: 280px;
                min-height: 34px;
                padding: 8px 14px;
                border-radius: 10px;
                margin: 4px 0;
            }
            QMenu::item:selected {
                background: #223e66;
                color: #ffffff;
            }
            """
        )

        for index in range(self.tabs.count()):
            name = self.tabs.tabText(index)
            is_primary = name in primary_tabs
            tab_bar.setTabVisible(index, is_primary)
            if is_primary:
                continue
            action = more_menu.addAction(f"Open {name}")
            action.triggered.connect(lambda _checked=False, idx=index: self.tabs.setCurrentIndex(idx))

        self.more_tabs_button.setMenu(more_menu)
        self.tabs.setCornerWidget(self.more_tabs_button, Qt.Corner.TopRightCorner)

    def _build_placeholder_tab(self, message: str) -> QWidget:
        tab = QWidget(self)
        layout = QVBoxLayout(tab)
        layout.setContentsMargins(28, 28, 28, 28)
        layout.setSpacing(14)

        title = QLabel("KINDROIDXL PANEL", tab)
        title.setAlignment(Qt.AlignmentFlag.AlignLeft)
        title.setStyleSheet("font-size: 20px; font-weight: 800; color: #f6f8ff;")

        label = QLabel(message, tab)
        label.setWordWrap(True)
        label.setStyleSheet(
            """
            padding: 18px;
            border: 1px solid #1d2437;
            border-radius: 14px;
            background: #090c15;
            """
        )

        layout.addWidget(title)
        layout.addWidget(label)
        layout.addStretch(1)
        return tab

    def get_directory_entries(self) -> list[dict[str, str]]:
        entries: list[dict[str, str]] = []
        raw_entries = self.config.get("directory_entries", [])
        if not isinstance(raw_entries, list):
            return entries
        generation_pregnancy_by_ai_id: dict[str, object] = {}
        generation_pregnancy_by_name: dict[str, object] = {}
        raw_people = self.config.get("generations_people", [])
        if isinstance(raw_people, list):
            for person in raw_people:
                if not isinstance(person, dict):
                    continue
                pregnancy = person.get("pregnancy")
                if not (isinstance(pregnancy, dict) and bool(pregnancy.get("active", False))):
                    continue
                person_ai_id = str(person.get("directory_ai_id", "")).strip()
                person_name = str(person.get("name", "")).strip().casefold()
                if person_ai_id:
                    generation_pregnancy_by_ai_id[person_ai_id] = pregnancy
                if person_name:
                    generation_pregnancy_by_name[person_name] = pregnancy
        for item in raw_entries:
            if not isinstance(item, dict):
                continue
            if bool(item.get("archived", False)):
                continue
            ai_id = str(item.get("ai_id", "")).strip()
            if ai_id.endswith("\\"):
                ai_id = ai_id.rstrip("\\").strip()
            name = str(item.get("name", "")).strip()
            if name:
                item_payload = dict(item)
                item_pregnancy = item_payload.get("pregnancy")
                if not (isinstance(item_pregnancy, dict) and bool(item_pregnancy.get("active", False))):
                    generation_pregnancy = generation_pregnancy_by_ai_id.get(ai_id) or generation_pregnancy_by_name.get(name.casefold())
                    if isinstance(generation_pregnancy, dict):
                        item_payload["pregnancy"] = dict(generation_pregnancy)
                fetch_rules: list[dict[str, str]] = []
                raw_rules = item.get("fetch_rules", [])
                if isinstance(raw_rules, list):
                    for rule in raw_rules:
                        if not isinstance(rule, dict):
                            continue
                        source_id = str(rule.get("source_id", "")).strip()
                        frequency = str(rule.get("frequency", "none")).strip() or "none"
                        if not source_id or frequency == "none":
                            continue
                        fetch_rules.append(
                            {
                                "source_id": source_id,
                                "frequency": frequency,
                                "time": str(rule.get("time", "09:00")).strip() or "09:00",
                                "last_sent_date": str(rule.get("last_sent_date", "")).strip(),
                            }
                        )
                if not fetch_rules:
                    legacy_source_id = str(item.get("fetch_source_id", "")).strip()
                    legacy_frequency = str(item.get("fetch_frequency", "none")).strip() or "none"
                    if legacy_source_id and legacy_frequency != "none":
                        fetch_rules.append(
                            {
                                "source_id": legacy_source_id,
                                "frequency": legacy_frequency,
                                "time": str(item.get("fetch_time", "09:00")).strip() or "09:00",
                                "last_sent_date": str(item.get("fetch_last_sent_date", "")).strip(),
                            }
                        )
                entries.append(
                    {
                        **COMMUNICATION_AVATAR_DEFAULTS,
                        **item_payload,
                        "ai_id": ai_id,
                        "name": name,
                        "location": str(item.get("location", "")).strip() or "home",
                        "position": str(item.get("position", "")).strip(),
                        "fetch_source_id": str(item.get("fetch_source_id", "")).strip(),
                        "fetch_frequency": str(item.get("fetch_frequency", "none")).strip() or "none",
                        "fetch_time": str(item.get("fetch_time", "09:00")).strip() or "09:00",
                        "fetch_last_sent_date": str(item.get("fetch_last_sent_date", "")).strip(),
                        "fetch_rules": fetch_rules,
                        "assets": 0,
                    }
                )
        return entries

    def save_directory_entries(self, entries: list[dict]) -> None:
        if not isinstance(entries, list):
            return
        self.config["directory_entries"] = entries
        self._save_config(self.config)
        self.directory_tab.refresh_entries()
        if hasattr(self, "calendar_tab_widget") and hasattr(
            self.calendar_tab_widget, "ensure_active_events_for_directory_people"
        ):
            self.calendar_tab_widget.ensure_active_events_for_directory_people()
        if hasattr(self, "home_tab_widget"):
            self.home_tab_widget.refresh_dashboard()
        self._refresh_directory_call_list()
        self._refresh_quick_call_buttons()
        self._notify_feeder_directory_changed()

    def _directory_position_names(self) -> set[str]:
        names: set[str] = set()
        raw_directory = self.config.get("directory_entries", [])
        if not isinstance(raw_directory, list):
            return names
        for person in raw_directory:
            if not isinstance(person, dict):
                continue
            position = self._normalize_location_name(str(person.get("position", "")).strip())
            activity = self._normalize_location_name(str(person.get("location", "")).strip())
            # A previous migration briefly copied activity/calendar values into position.
            # Treat un-sourced values that exactly match activity as activity noise, not an official place.
            if position and not (position == activity and not str(person.get("position_source", "")).strip()):
                names.add(position)
        return names

    def get_location_entries(self) -> list[dict[str, str]]:
        entries: list[dict[str, str]] = []
        position_names = self._directory_position_names()
        if not position_names:
            return entries

        raw_entries = self.config.get("location_entries", [])
        if not isinstance(raw_entries, list):
            raw_entries = []
        metadata_by_key: dict[str, dict] = {}
        for item in raw_entries:
            if not isinstance(item, dict):
                continue
            name = self._normalize_location_name(str(item.get("name", "")).strip())
            if not name:
                continue
            metadata_by_key.setdefault(name.casefold(), item)

        for name in sorted(position_names, key=str.casefold):
            item = metadata_by_key.get(name.casefold(), {})
            entries.append(
                {
                    **item,
                    "name": name,
                    "description": str(item.get("description", "")).strip(),
                    "image_file": str(item.get("image_file", "")).strip(),
                    "image_path": str(item.get("image_path", "")).strip(),
                    "event_history": item.get("event_history", []) if isinstance(item.get("event_history", []), list) else [],
                    "source": "directory_position",
                }
            )
        return entries

    @staticmethod
    def _normalize_location_name(raw_name: str) -> str:
        return str(raw_name or "").strip().upper()

    def save_location_entries(self, entries: list[dict]) -> None:
        if not isinstance(entries, list):
            return
        normalized_entries: list[dict] = []
        seen_keys: set[str] = set()
        for item in entries:
            if not isinstance(item, dict):
                continue
            name = self._normalize_location_name(str(item.get("name", "")).strip())
            if not name:
                continue
            key = name.casefold()
            if key in seen_keys:
                continue
            seen_keys.add(key)
            normalized_entries.append(
                {
                    **item,
                    "name": name,
                    "description": str(item.get("description", "")).strip(),
                    "image_file": str(item.get("image_file", "")).strip(),
                    "image_path": str(item.get("image_path", "")).strip(),
                    "event_history": item.get("event_history", []) if isinstance(item.get("event_history", []), list) else [],
                }
            )
        self.config["location_entries"] = normalized_entries
        self._save_config(self.config)
        if hasattr(self, "home_tab_widget"):
            self.home_tab_widget.refresh_dashboard()
        if hasattr(self, "locations_tab"):
            self.locations_tab.refresh_entries()

    def record_groupmaker_location_history(
        self,
        location_by_ai_id: dict[str, str],
        people: list[dict[str, str]],
        description: str,
        group_session_id: str = "",
    ) -> int:
        if not isinstance(location_by_ai_id, dict) or not location_by_ai_id:
            return 0
        name_by_ai_id = {
            str(person.get("ai_id", "")).strip(): str(person.get("name", "")).strip()
            for person in people
            if isinstance(person, dict) and str(person.get("ai_id", "")).strip()
        }
        grouped: dict[str, list[str]] = {}
        for ai_id, raw_location in location_by_ai_id.items():
            location = self._normalize_location_name(str(raw_location).strip())
            person_name = name_by_ai_id.get(str(ai_id).strip(), "")
            if location and person_name:
                grouped.setdefault(location, []).append(person_name)
        if not grouped:
            return 0
        entries = self.get_location_entries()
        entry_by_key = {str(entry.get("name", "")).strip().casefold(): entry for entry in entries if isinstance(entry, dict)}
        timestamp = datetime.now().isoformat(timespec="seconds")
        changed = 0
        for location, names in grouped.items():
            key = location.casefold()
            entry = entry_by_key.get(key)
            if entry is None:
                entry = {"name": location, "description": "", "image_file": "", "image_path": "", "source": "groupmaker"}
                entries.append(entry)
                entry_by_key[key] = entry
            history = entry.get("event_history", [])
            if not isinstance(history, list):
                history = []
            participant_text = ", ".join(dict.fromkeys(names))
            row = {
                "created_at": timestamp,
                "participants": participant_text,
                "description": str(description or "").strip(),
                "group_session_id": str(group_session_id or "").strip(),
            }
            if not history or any(str(history[-1].get(field, "")).strip() != row[field] for field in ("participants", "description", "group_session_id")):
                history.append(row)
                changed += 1
            entry["event_history"] = history[-100:]
        if changed:
            self.save_location_entries(entries)
        return changed

    def sync_locations_from_calendar_events(self) -> int:
        # Backward-compatible name: LOCATIONS are sourced only from DIRECTORY/GROUPMAKER
        # positions. Calendar/activity text must never create visible LOCATIONS rows.
        raw_entries = self.config.get("location_entries", [])
        if not isinstance(raw_entries, list):
            raw_entries = []
        previous_keys = {
            self._normalize_location_name(str(item.get("name", "")).strip()).casefold()
            for item in raw_entries
            if isinstance(item, dict) and str(item.get("name", "")).strip()
        }
        cleaned_directory = False
        raw_directory = self.config.get("directory_entries", [])
        if isinstance(raw_directory, list):
            for person in raw_directory:
                if not isinstance(person, dict):
                    continue
                position = self._normalize_location_name(str(person.get("position", "")).strip())
                activity = self._normalize_location_name(str(person.get("location", "")).strip())
                if position and position == activity and not str(person.get("position_source", "")).strip():
                    person["position"] = ""
                    cleaned_directory = True
            if cleaned_directory:
                self.config["directory_entries"] = raw_directory
                self._save_config(self.config)
        ordered_entries = self.get_location_entries()
        new_keys = {str(item.get("name", "")).strip().casefold() for item in ordered_entries}
        if ordered_entries != raw_entries:
            self.save_location_entries(ordered_entries)
        elif hasattr(self, "home_tab_widget"):
            self.home_tab_widget.refresh_dashboard()
        return len(new_keys - previous_keys)

    def get_fetcher_sources(self) -> list[dict[str, str]]:
        state = feeder._load_state()  # pylint: disable=protected-access
        raw = state.get("fetcher_sources", [])
        if not isinstance(raw, list):
            return []
        return [item for item in raw if isinstance(item, dict)]

    def _notify_feeder_directory_changed(self) -> None:
        if hasattr(self, "directory_tab") and hasattr(self.directory_tab, "_refresh_fetch_source_options"):
            self.directory_tab._refresh_fetch_source_options()  # pylint: disable=protected-access
        if hasattr(self, "home_tab_widget"):
            self.home_tab_widget.refresh_dashboard()
        for index in range(self.tabs.count()):
            widget = self.tabs.widget(index)
            if hasattr(widget, "refresh_directory_people"):
                widget.refresh_directory_people()

    def get_call_sfx_files(self) -> dict[str, str]:
        raw = self.config.get("call_sfx_files", {})
        if not isinstance(raw, dict):
            return {}
        allowed_keys = {item["key"] for item in CALL_SFX_TARGETS}
        cleaned: dict[str, str] = {}
        for key, value in raw.items():
            if key not in allowed_keys or not isinstance(value, str):
                continue
            normalized = value.strip()
            if not normalized:
                continue
            cleaned[key] = normalized
        return cleaned

    def set_call_sfx_file(self, target_key: str, file_path: str) -> None:
        allowed_keys = {item["key"] for item in CALL_SFX_TARGETS}
        if target_key not in allowed_keys:
            return
        mapping = self.get_call_sfx_files()
        normalized = str(file_path).strip()
        if normalized:
            source_path = Path(normalized)
            if not source_path.exists() or not source_path.is_file():
                raise OSError(f"File not found: {source_path}")
            storage_dir = APP_DATA_DIR / "call_sfx"
            storage_dir.mkdir(parents=True, exist_ok=True)
            suffix = source_path.suffix.strip().lower() or ".mp3"
            target_stem = Path(target_key).stem
            stored_path = storage_dir / f"{target_stem}{suffix}"
            shutil.copy2(source_path, stored_path)
            mapping[target_key] = str(stored_path)
        else:
            mapping.pop(target_key, None)
        self.config["call_sfx_files"] = mapping
        self._save_config(self.config)
        self._reload_scripts()

    def _call_sfx_data_url_for_target(self, target_key: str) -> str:
        path = self.get_call_sfx_files().get(target_key, "")
        if not path:
            return ""
        source_path = Path(path)
        if not source_path.exists() or not source_path.is_file():
            return ""
        try:
            payload = source_path.read_bytes()
        except OSError:
            return ""
        if not payload:
            return ""
        mime, _ = mimetypes.guess_type(source_path.name)
        if not mime:
            mime = "audio/mpeg"
        encoded = base64.b64encode(payload).decode("ascii")
        return f"data:{mime};base64,{encoded}"

    def _build_call_sfx_runtime_script(self) -> str:
        data_urls: dict[str, str] = {}
        for target in CALL_SFX_TARGETS:
            encoded = self._call_sfx_data_url_for_target(target["key"])
            if encoded:
                data_urls[target["key"]] = encoded

        payload = json.dumps(data_urls)
        return f"""
(() => {{
  'use strict';
  const TARGETS = {payload};
  const NON_INTERRUPTED = new Set(['call-en.mp3', 'call-begin.mp3']);
  const FALLBACKS = {{ 'call-end.mp3': 'call-en.mp3' }};

  const state = {{
    syncByOriginal: new WeakMap(),
    originalAudioState: new WeakMap(),
    boundMedia: new WeakSet(),
  }};

  const getTargetFromElement = (mediaEl) => {{
    const src = [mediaEl.currentSrc, mediaEl.src, mediaEl.getAttribute('src'), mediaEl.dataset?.src]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!src) return null;
    return Object.keys(TARGETS).find((key) => src.includes(key.toLowerCase())) || null;
  }};

  const getUploadForTarget = (targetKey) => {{
    const direct = TARGETS[targetKey];
    if (direct) return direct;
    const fallbackKey = FALLBACKS[targetKey];
    if (fallbackKey) return TARGETS[fallbackKey] || '';
    return '';
  }};

  const muteOriginal = (original) => {{
    if (!state.originalAudioState.has(original)) {{
      state.originalAudioState.set(original, {{ muted: original.muted, volume: original.volume }});
    }}
    original.muted = true;
    original.volume = 0;
  }};

  const unmuteOriginalIfNeeded = (original) => {{
    const existing = state.originalAudioState.get(original);
    if (!existing) return;
    original.muted = existing.muted;
    original.volume = existing.volume;
    state.originalAudioState.delete(original);
  }};

  const stopSyncedAudio = (original) => {{
    const synced = state.syncByOriginal.get(original);
    if (!synced) {{
      unmuteOriginalIfNeeded(original);
      return;
    }}
    try {{
      synced.pause();
      synced.currentTime = 0;
      synced.src = '';
      synced.remove();
    }} catch (_error) {{}}
    state.syncByOriginal.delete(original);
    unmuteOriginalIfNeeded(original);
  }};

  const startSyncedAudio = (original, dataUrl, targetKey) => {{
    stopSyncedAudio(original);
    muteOriginal(original);
    const custom = new Audio(dataUrl);
    custom.preload = 'auto';
    custom.volume = 1;
    custom.playbackRate = Number.isFinite(original.playbackRate) ? original.playbackRate : 1;
    custom.__kxlTargetKey = targetKey;
    custom.addEventListener('ended', () => {{
      if (state.syncByOriginal.get(original) !== custom) return;
      if (custom.__kxlTargetKey === 'ringtone.mp3' && !original.paused && original.ended !== true) {{
        muteOriginal(original);
        return;
      }}
      state.syncByOriginal.delete(original);
      unmuteOriginalIfNeeded(original);
    }});
    if (Number.isFinite(original.currentTime) && original.currentTime > 0) {{
      try {{ custom.currentTime = original.currentTime; }} catch (_error) {{}}
    }}
    state.syncByOriginal.set(original, custom);
    void custom.play().catch(() => null);
  }};

  const bindMediaListeners = (mediaEl) => {{
    if (!(mediaEl instanceof HTMLMediaElement)) return;
    if (state.boundMedia.has(mediaEl)) return;
    state.boundMedia.add(mediaEl);

    const shouldAllowNaturalEnd = () => {{
      const synced = state.syncByOriginal.get(mediaEl);
      if (!synced) return false;
      return NON_INTERRUPTED.has(synced.__kxlTargetKey || '');
    }};

    mediaEl.addEventListener('playing', () => {{
      const target = getTargetFromElement(mediaEl);
      if (!target) return;
      const upload = getUploadForTarget(target);
      if (!upload) {{
        stopSyncedAudio(mediaEl);
        return;
      }}
      startSyncedAudio(mediaEl, upload, target);
    }});
    mediaEl.addEventListener('pause', () => {{ if (!shouldAllowNaturalEnd()) stopSyncedAudio(mediaEl); }});
    mediaEl.addEventListener('ended', () => {{ if (!shouldAllowNaturalEnd()) stopSyncedAudio(mediaEl); }});
    mediaEl.addEventListener('abort', () => stopSyncedAudio(mediaEl));
    mediaEl.addEventListener('emptied', () => stopSyncedAudio(mediaEl));
    mediaEl.addEventListener('ratechange', () => {{
      const synced = state.syncByOriginal.get(mediaEl);
      if (synced) synced.playbackRate = Number.isFinite(mediaEl.playbackRate) ? mediaEl.playbackRate : 1;
    }});
    mediaEl.addEventListener('volumechange', () => {{ if (state.syncByOriginal.has(mediaEl)) muteOriginal(mediaEl); }});
  }};

  const bindAndMaybeStart = (mediaEl) => {{
    bindMediaListeners(mediaEl);
    const target = getTargetFromElement(mediaEl);
    if (!target) return;
    const upload = getUploadForTarget(target);
    if (!upload) {{
      stopSyncedAudio(mediaEl);
      return;
    }}
    startSyncedAudio(mediaEl, upload, target);
  }};

  const NativeAudio = window.Audio;
  window.Audio = function(...args) {{
    const instance = new NativeAudio(...args);
    bindMediaListeners(instance);
    return instance;
  }};
  window.Audio.prototype = NativeAudio.prototype;
  Object.setPrototypeOf(window.Audio, NativeAudio);

  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) {{
    bindAndMaybeStart(this);
    return nativePlay.apply(this, args);
  }};

  const bindMediaTree = (rootNode) => {{
    if (!(rootNode instanceof Element)) return;
    if (rootNode.matches('audio, video')) bindMediaListeners(rootNode);
    rootNode.querySelectorAll('audio, video').forEach(bindMediaListeners);
  }};

  document.querySelectorAll('audio, video').forEach(bindMediaListeners);
  const observer = new MutationObserver((mutations) => {{
    for (const mutation of mutations) {{
      for (const node of mutation.addedNodes) bindMediaTree(node);
    }}
  }});
  observer.observe(document.documentElement, {{ childList: true, subtree: true }});
}})();
"""

    def _load_config(self) -> dict:
        default_config = {
            "directory_entries": [],
            "location_entries": [],
            "calendar_events": [],
            "google_calendar_target_id": "primary",
            "window_geometry": {},
            "call_sfx_files": {},
            "house_council": {
                "manual_sponsorship_titles": [],
                "agenda_items": [],
                "last_rank_snapshot": {},
                "manual_rank_overrides": {},
                "legacy_sponsorship_events": [],
                "reproduction_requests": [],
            },
            "documents_backup_interval_minutes": 5,
            "documents_backup_retention": 7,
            "documents_full_backup_retention": 1,
            "documents_backup_mode": "critical",
        }
        legacy_config_dir = _legacy_documents_kindroid_dir() / "kindroidxl_data"
        config_sources = (
            CONFIG_PATH,
            CONFIG_BACKUP_PATH,
            legacy_config_dir / "config.json",
            legacy_config_dir / "config.backup.json",
        )
        if not any(source.exists() for source in config_sources):
            self._save_config(default_config)
            return default_config

        loaded_config: dict | None = None
        for source in config_sources:
            if not source.exists():
                continue
            try:
                with source.open("r", encoding="utf-8") as fh:
                    loaded = json.load(fh)
                if isinstance(loaded, dict):
                    loaded_config = loaded
                    break
            except (json.JSONDecodeError, OSError):
                continue

        if loaded_config is not None:
            default_config.update(loaded_config)
            repaired_config, repaired_paths = _remap_legacy_kindroid_paths(default_config)
            if isinstance(repaired_config, dict):
                default_config = repaired_config
            if repaired_paths or not CONFIG_PATH.exists() or not CONFIG_BACKUP_PATH.exists():
                self._save_config(default_config)

        return default_config

    def load_journal_entries(self) -> tuple[list[dict], Path, Path]:
        documents_path = journal.DOCUMENTS_JOURNAL_DIR / journal.JOURNAL_FILE_NAME
        local_path = journal.LOCAL_JOURNAL_DIR / journal.JOURNAL_FILE_NAME
        source = documents_path if documents_path.exists() else local_path
        if not source.exists():
            return [], documents_path, local_path
        try:
            with source.open("r", encoding="utf-8") as fh:
                loaded = json.load(fh)
        except (OSError, json.JSONDecodeError):
            loaded = []
        return (loaded if isinstance(loaded, list) else []), documents_path, local_path

    def save_journal_entries(self, entries: list[dict], documents_path: Path, local_path: Path) -> None:
        for target in (documents_path, local_path):
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("w", encoding="utf-8") as fh:
                json.dump(entries, fh, indent=2, ensure_ascii=False)

    def get_default_api_key(self) -> str:
        state = feeder._load_state()  # pylint: disable=protected-access
        if bool(state.get("remember_api_key", True)):
            return str(state.get("api_key", "")).strip()
        return ""

    def _save_config(self, data: dict) -> None:
        _atomic_write_json(CONFIG_PATH, data)
        _atomic_write_json(CONFIG_BACKUP_PATH, data)

    def _apply_saved_window_geometry(self) -> None:
        raw = self.config.get("window_geometry", {})
        if not isinstance(raw, dict):
            return
        encoded_qt_geometry = raw.get("qt_geometry")
        if isinstance(encoded_qt_geometry, str) and encoded_qt_geometry.strip():
            try:
                decoded = base64.b64decode(encoded_qt_geometry.encode("ascii"), validate=True)
                if decoded:
                    self.restoreGeometry(QByteArray(decoded))
                    return
            except (ValueError, OSError):
                pass
        x = raw.get("x")
        y = raw.get("y")
        width = raw.get("width")
        height = raw.get("height")
        if all(isinstance(value, int) for value in (x, y, width, height)):
            if width > 200 and height > 200:
                requested = QRect(x, y, width, height)
                self.setGeometry(self._clamp_window_geometry_to_screens(requested))
        if bool(raw.get("is_maximized", False)):
            self._restore_maximized_on_first_show = True

    def _store_window_geometry(self) -> None:
        if not self._window_geometry_ready:
            return
        if self.isMinimized():
            return
        normal_geometry = self.normalGeometry() if self.isMaximized() else self.geometry()
        if not normal_geometry.isValid():
            return
        clamped = self._clamp_window_geometry_to_screens(normal_geometry)
        qt_geometry = base64.b64encode(bytes(self.saveGeometry())).decode("ascii")
        new_geometry = {
            "x": int(clamped.x()),
            "y": int(clamped.y()),
            "width": int(clamped.width()),
            "height": int(clamped.height()),
            "is_maximized": bool(self.isMaximized()),
            "qt_geometry": qt_geometry,
        }
        if new_geometry["width"] < 200 or new_geometry["height"] < 200:
            return
        existing_geometry = self.config.get("window_geometry", {})
        if existing_geometry == new_geometry:
            return
        self.config["window_geometry"] = new_geometry
        self._save_config(self.config)

    def _clamp_window_geometry_to_screens(self, rect: QRect) -> QRect:
        reference = self._reference_screen()
        if reference is None:
            return rect
        target = QGuiApplication.screenAt(rect.center()) or reference
        available = target.availableGeometry()

        max_width = max(800, int(available.width() * 0.98))
        max_height = max(500, int(available.height() * 0.98))
        win_size = self._windows_primary_screen_size()
        if win_size is not None:
            max_width = min(max_width, max(800, int(win_size[0] * 0.98)))
            max_height = min(max_height, max(500, int(win_size[1] * 0.98)))
        width = min(rect.width(), max_width)
        height = min(rect.height(), max_height)
        x = min(max(rect.x(), available.left()), available.right() - width + 1)
        y = min(max(rect.y(), available.top()), available.bottom() - height + 1)
        return QRect(x, y, width, height)

    def _default_window_size(self) -> tuple[int, int]:
        primary = QGuiApplication.primaryScreen()
        if primary is None:
            return (1600, 900)

        available = primary.availableGeometry()
        target_width = int(available.width() * 0.8)
        target_height = int(round(target_width * 9 / 16))

        if target_height > int(available.height() * 0.85):
            target_height = int(available.height() * 0.85)
            target_width = int(round(target_height * 16 / 9))

        width = max(960, min(target_width, available.width()))
        height = max(540, min(target_height, available.height()))
        return (width, height)

    def _center_window_on_primary_screen(self) -> None:
        primary = QGuiApplication.primaryScreen()
        if primary is None:
            return
        available = primary.availableGeometry()
        frame = self.frameGeometry()
        frame.moveCenter(available.center())
        self.move(frame.topLeft())

    def _ensure_window_fits_visible_screen(self) -> None:
        current = self.geometry()
        clamped = self._clamp_window_geometry_to_screens(current)
        if clamped != current:
            self.setGeometry(clamped)

    def _reference_screen(self):
        return QGuiApplication.screenAt(QCursor.pos()) or QGuiApplication.primaryScreen()

    def _windows_primary_screen_size(self) -> tuple[int, int] | None:
        if not sys.platform.startswith("win"):
            return None
        try:
            user32 = ctypes.windll.user32
            width = int(user32.GetSystemMetrics(0))
            height = int(user32.GetSystemMetrics(1))
            if width <= 0 or height <= 0:
                return None
            return (width, height)
        except Exception:
            return None

    def _apply_cookie_policy(self, remember_enabled: bool) -> None:
        policy = (
            QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies
            if remember_enabled
            else QWebEngineProfile.PersistentCookiesPolicy.NoPersistentCookies
        )
        self.profile.setPersistentCookiesPolicy(policy)

    def _script_paths(self) -> list[Path]:
        return sorted(JAVASCRIPTS_DIR.glob("*.js"))

    def _sync_addons_config(self, loaded: dict | None) -> dict:
        installed_script_names = [path.name for path in self._script_paths()]
        enabled_by_name: dict[str, bool] = {}

        if isinstance(loaded, dict):
            loaded_scripts = loaded.get("scripts")
            if isinstance(loaded_scripts, list):
                for item in loaded_scripts:
                    if not isinstance(item, dict):
                        continue

                    name = item.get("name")
                    enabled = item.get("enabled")
                    if isinstance(name, str) and isinstance(enabled, bool):
                        enabled_by_name[name] = enabled

        ordered_names: list[str] = []
        ordered_names.extend(installed_script_names)
        for configured_name in enabled_by_name:
            if configured_name not in ordered_names:
                ordered_names.append(configured_name)

        return {
            "scripts": [
                {"name": script_name, "enabled": enabled_by_name.get(script_name, True)}
                for script_name in ordered_names
            ]
        }

    def _load_addons_config(self) -> dict:
        loaded: dict | None = None

        if ADDONS_PATH.exists():
            try:
                with ADDONS_PATH.open("r", encoding="utf-8") as fh:
                    parsed = json.load(fh)
                    if isinstance(parsed, dict):
                        loaded = parsed
            except (json.JSONDecodeError, OSError):
                loaded = None

        config = self._sync_addons_config(loaded)
        self._save_addons_config(config)
        return config

    def _save_addons_config(self, data: dict) -> None:
        with ADDONS_PATH.open("w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)

    def _enabled_script_paths(self) -> list[Path]:
        return addons.enabled_script_paths()

    def _inject_local_scripts(self, scripts=None) -> None:
        if scripts is None:
            scripts = self.webpage.scripts()
        scripts.clear()

        enabled_paths = [
            path for path in self._enabled_script_paths() if path.name != CALL_SFX_RUNTIME_DISABLED_SCRIPT_NAME
        ]
        for index, script_path in enumerate(enabled_paths, start=1):
            source = script_path.read_text(encoding="utf-8")
            script = QWebEngineScript()
            script.setName(f"local_script_{index}_{script_path.stem}")
            script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
            script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentReady)
            script.setRunsOnSubFrames(True)
            script.setSourceCode(source)
            scripts.insert(script)

        runtime_script = QWebEngineScript()
        runtime_script.setName("kindroidxl_runtime_custom_call_sfx")
        runtime_script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        runtime_script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentReady)
        runtime_script.setRunsOnSubFrames(True)
        runtime_script.setSourceCode(self._build_call_sfx_runtime_script())
        scripts.insert(runtime_script)

        audio_probe_path = APP_ROOT / "modules" / "kindroid_audio_probe.js"
        if audio_probe_path.exists():
            audio_probe_script = QWebEngineScript()
            audio_probe_script.setName("kindroidxl_audio_probe")
            audio_probe_script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
            audio_probe_script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
            audio_probe_script.setRunsOnSubFrames(True)
            audio_probe_script.setSourceCode(audio_probe_path.read_text(encoding="utf-8"))
            scripts.insert(audio_probe_script)

        group_probe_path = APP_ROOT / "modules" / "kindroid_group_participant_probe.js"
        if group_probe_path.exists():
            group_probe_script = QWebEngineScript()
            group_probe_script.setName("kindroidxl_group_participant_probe")
            group_probe_script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
            group_probe_script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentReady)
            group_probe_script.setRunsOnSubFrames(True)
            group_probe_script.setSourceCode(group_probe_path.read_text(encoding="utf-8"))
            scripts.insert(group_probe_script)

    def _reload_scripts(self) -> None:
        self._inject_local_scripts(self.webpage.scripts())
        self.webview.reload()


    def _is_sqlite_backup_source(self, source: Path) -> bool:
        return source.is_file() and source.suffix.lower() in SQLITE_BACKUP_SUFFIXES

    def _copy_backup_source(self, source: Path, target: Path) -> None:
        """Copy a backup source, using SQLite's online backup API for live DBs."""
        target.parent.mkdir(parents=True, exist_ok=True)
        if not self._is_sqlite_backup_source(source):
            shutil.copy2(source, target)
            return

        # SQLite opens an existing destination in-place. On Windows a previous
        # read-only backup file can make that open fail with "attempt to write
        # a readonly database" during startup. Always create a fresh target; if
        # the online backup API still cannot write, fall back to a normal file
        # copy so automatic backup never prevents the app from launching.
        try:
            target.chmod(0o666)
        except OSError:
            pass
        try:
            target.unlink(missing_ok=True)
        except OSError:
            pass

        try:
            with sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=30) as src_conn:
                with sqlite3.connect(target) as dest_conn:
                    src_conn.backup(dest_conn)
        except sqlite3.Error:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass
            shutil.copy2(source, target)

    def _write_backup_member(self, archive: zipfile.ZipFile, source: Path, arcname: str) -> None:
        """Write a file to a ZIP, snapshotting live SQLite databases safely."""
        if not self._is_sqlite_backup_source(source):
            archive.write(source, arcname=arcname)
            return
        temp_dir = APP_DATA_DIR / ".backup_tmp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        temp_path = temp_dir / f"{source.stem}_{os.getpid()}_{time.time_ns()}{source.suffix}"
        try:
            self._copy_backup_source(source, temp_path)
            archive.write(temp_path, arcname=arcname)
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass

    def _lifeline_memory_db_score(self, db_path: Path) -> int:
        """Return a validity-weighted score for a LIFELINE DB candidate."""
        return self._lifeline_memory_db_score_tuple(db_path)[0]

    def _lifeline_memory_db_score_tuple(self, db_path: Path) -> tuple[int, str]:
        if not db_path.is_file() or db_path.stat().st_size <= 0:
            return (0, "")
        tables = ("memory_events", "transcript_chunks", "keyword_nodes", "people")
        score = 0
        latest_ts = ""
        try:
            with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30) as conn:
                if str(conn.execute("PRAGMA integrity_check").fetchone()[0]).lower() != "ok":
                    return (0, "")
                existing = {
                    str(row[0])
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?,?,?)",
                        tables,
                    )
                }
                if not {"memory_events", "transcript_chunks", "keyword_nodes", "people"}.issubset(existing):
                    return (0, "")
                for table in tables:
                    score += int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] or 0)
                for table, column in (("memory_events", "created_at"), ("transcript_chunks", "created_at"), ("keyword_nodes", "updated_at"), ("people", "updated_at")):
                    value = conn.execute(f"SELECT MAX({column}) FROM {table}").fetchone()[0]
                    if value and str(value) > latest_ts:
                        latest_ts = str(value)
                has_app_settings = conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'"
                ).fetchone() is not None
                if has_app_settings:
                    marker = conn.execute("SELECT value FROM app_settings WHERE key='lifeline_memory_last_mutation_at'").fetchone()
                    if marker and marker[0] and str(marker[0]) > latest_ts:
                        latest_ts = str(marker[0])
        except (OSError, sqlite3.Error):
            return (0, "")
        return (score, latest_ts)


    def _lifeline_memory_db_restore_rank(self, db_path: Path) -> tuple[str, int]:
        """Rank DB candidates by latest mutation first, then row count.

        A cleared or pruned database can legitimately have fewer rows than an old
        backup. Using row count first resurrects deleted/corrupt memories on the
        next launch, so freshness must win.
        """
        score, latest_ts = self._lifeline_memory_db_score_tuple(db_path)
        return (latest_ts, score)

    def _iter_lifeline_memory_backup_candidates(self) -> list[Path]:
        if not DOCUMENTS_KINDROID_BACKUPS_DIR.exists():
            return []
        candidates: list[Path] = []
        relative_names = (
            Path("lifeline_memory.db"),
            Path("app_data") / "lifeline_memory.db",
            Path("app_root") / "lifeline_memory.db",
        )
        for snapshot in DOCUMENTS_KINDROID_BACKUPS_DIR.iterdir():
            if snapshot.is_dir() and snapshot.name != "LIFELINE_MEMORY":
                for relative in relative_names:
                    candidate = snapshot / relative
                    if candidate.is_file():
                        candidates.append(candidate)
        memory_root = DOCUMENTS_KINDROID_BACKUPS_DIR / "LIFELINE_MEMORY"
        if memory_root.exists():
            candidates.extend(child for child in memory_root.glob("lifeline_memory*.db") if child.is_file())
        mirror = APP_DATA_DIR / "lifeline_memory.latest.db"
        if mirror.is_file():
            candidates.append(mirror)
        return candidates

    def _best_lifeline_memory_database_backup(self) -> Path | None:
        best_path: Path | None = None
        best_rank = ("", 0)
        for candidate in self._iter_lifeline_memory_backup_candidates():
            rank = self._lifeline_memory_db_restore_rank(candidate)
            if rank > best_rank:
                best_path = candidate
                best_rank = rank
        return best_path

    def _restore_lifeline_memory_database_from_safety_backup(self) -> None:
        """Restore the canonical app-data DB from the best valid external source."""
        LIFELINE_MEMORY_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        best_backup = self._best_lifeline_memory_database_backup()
        candidates = [LEGACY_LIFELINE_MEMORY_DB_PATH, best_backup]
        active_tuple = self._lifeline_memory_db_score_tuple(LIFELINE_MEMORY_DB_PATH)
        legacy_tuple = self._lifeline_memory_db_score_tuple(LEGACY_LIFELINE_MEMORY_DB_PATH)
        backup_tuple = self._lifeline_memory_db_score_tuple(best_backup) if best_backup else (0, "")
        print(f"[LIFELINE DB] canonical path: {LIFELINE_MEMORY_DB_PATH}")
        print(f"[LIFELINE DB] active score: {active_tuple}")
        print(f"[LIFELINE DB] legacy source score: {legacy_tuple}")
        print(f"[LIFELINE DB] best backup score: {backup_tuple}")
        best_source: Path | None = None
        best_rank = self._lifeline_memory_db_restore_rank(LIFELINE_MEMORY_DB_PATH)
        for candidate in candidates:
            if candidate is None or candidate.resolve() == LIFELINE_MEMORY_DB_PATH.resolve():
                continue
            candidate_rank = self._lifeline_memory_db_restore_rank(candidate)
            if candidate_rank > best_rank:
                best_source = candidate
                best_rank = candidate_rank
        if best_source is None:
            print("[LIFELINE DB] restored from: none")
            return
        try:
            self._copy_backup_source(best_source, LIFELINE_MEMORY_DB_PATH)
            print(f"[LIFELINE DB] restored from: {best_source}")
        except OSError as exc:
            print(f"[LIFELINE DB] restored from: failed ({best_source}: {exc})")

    def _iter_backup_sources(self) -> list[tuple[Path, str]]:
        sources: list[tuple[Path, str]] = [
            (APP_DATA_DIR, "app_data"),
            (ADDONS_PATH, "app_root/addons.json"),
            (APP_ROOT / "google_calendar_token.json", "app_root/google_calendar_token.json"),
            (APP_ROOT / "collector" / "collector.json", "app_root/collector/collector.json"),
            (LIFELINE_MEMORY_DB_PATH, "app_data/lifeline_memory.db"),
            (APP_ROOT / "KINDROIDXL" / "journal", "app_root/KINDROIDXL/journal"),
            (journal.LOCAL_TRANSCRIPTS_DIR, "app_root/KINDROIDXL/transcripts"),
            (journal.DOCUMENTS_JOURNAL_DIR, "documents/journal"),
            (journal.DOCUMENTS_TRANSCRIPTS_DIR, "documents/transcripts"),
            (APP_ROOT / "javascripts", "app_root/javascripts"),
        ]
        result: list[tuple[Path, str]] = []
        seen: set[Path] = set()
        for source, archive_root in sources:
            if not source.exists():
                continue
            resolved = source.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            result.append((source, archive_root))
        return result

    def _critical_backup_sources(self) -> list[tuple[Path, Path]]:
        """Return small, high-value files for automatic safety backups.

        Full browser profiles, caches, avatars, and media can be very large. Those are
        still covered by manual Export Full Backup, but the timer should only protect
        state that changes frequently and is cheap to retain.
        """
        sources = [
            CONFIG_PATH,
            CONFIG_BACKUP_PATH,
            ADDONS_PATH,
            APP_ROOT / "google_calendar_token.json",
            APP_ROOT / "collector" / "collector.json",
            LIFELINE_MEMORY_DB_PATH,
            LEGACY_LIFELINE_MEMORY_DB_PATH,
        ]
        sources.extend(APP_DATA_DIR.glob("*.db"))
        sources.extend(APP_DATA_DIR.glob("*.sqlite"))
        sources.extend(APP_DATA_DIR.glob("*.sqlite3"))
        critical_dirs = [
            journal.LOCAL_JOURNAL_DIR,
            journal.LOCAL_TRANSCRIPTS_DIR,
            journal.DOCUMENTS_JOURNAL_DIR,
            journal.DOCUMENTS_TRANSCRIPTS_DIR,
            DIRECTORY_VOICE_SAMPLES_DIR,
        ]
        for directory in critical_dirs:
            if directory.exists():
                sources.extend(child for child in directory.rglob("*") if child.is_file())

        result: list[tuple[Path, Path]] = []
        seen_sources: set[Path] = set()
        for source in sources:
            if not source.exists() or not source.is_file():
                continue
            resolved = source.resolve()
            if resolved in seen_sources:
                continue
            seen_sources.add(resolved)
            try:
                relative = source.relative_to(APP_ROOT)
            except ValueError:
                try:
                    relative = source.relative_to(DOCUMENTS_KINDROID_DIR)
                except ValueError:
                    relative = Path(source.name)
            result.append((source, relative))
        return result

    def _cleanup_automatic_backups(self, destination_root: Path) -> None:
        critical_snapshots = sorted(
            [child for child in destination_root.iterdir() if child.is_dir() and child.name.startswith("KINDROIDXL_CRITICAL_")],
            key=lambda path: path.name,
            reverse=True,
        )
        for old_snapshot in critical_snapshots[self._documents_backup_retention :]:
            shutil.rmtree(old_snapshot, ignore_errors=True)

        legacy_full_snapshots = sorted(
            [
                child
                for child in destination_root.iterdir()
                if child.is_dir()
                and child.name.startswith("KINDROIDXL_")
                and not child.name.startswith("KINDROIDXL_CRITICAL_")
            ],
            key=lambda path: path.name,
            reverse=True,
        )
        for old_snapshot in legacy_full_snapshots[self._documents_full_backup_retention :]:
            shutil.rmtree(old_snapshot, ignore_errors=True)

    def _backup_documents_kindroidxl(self) -> None:
        destination_root = DOCUMENTS_KINDROID_BACKUPS_DIR
        if not bool(self.config.get("documents_backup_enabled", True)):
            self._cleanup_automatic_backups(destination_root)
            return
        destination_root.mkdir(parents=True, exist_ok=True)
        self._restore_lifeline_memory_database_from_safety_backup()
        stamp = time.strftime("%Y%m%d_%H%M%S")

        if self._documents_backup_mode == "full":
            source = DOCUMENTS_KINDROID_DIR
            if not source.exists() or not source.is_dir():
                return
            snapshot_target = destination_root / f"KINDROIDXL_{stamp}"
            try:
                shutil.copytree(source, snapshot_target)
            except OSError:
                return
            self._cleanup_automatic_backups(destination_root)
            return

        snapshot_target = destination_root / f"KINDROIDXL_CRITICAL_{stamp}"
        try:
            snapshot_target.mkdir(parents=True, exist_ok=False)
            copied = 0
            for source, relative in self._critical_backup_sources():
                target = snapshot_target / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                self._copy_backup_source(source, target)
                copied += 1
            if copied == 0:
                shutil.rmtree(snapshot_target, ignore_errors=True)
                return
        except (OSError, sqlite3.Error):
            shutil.rmtree(snapshot_target, ignore_errors=True)
            return
        self._cleanup_automatic_backups(destination_root)

    def export_full_backup(self) -> None:
        stamp = time.strftime("%Y%m%d_%H%M%S")
        default_name = f"kindroidxl_full_backup_{stamp}.zip"
        target_path, _ = QFileDialog.getSaveFileName(
            self,
            "Export Full Backup",
            str(APP_DATA_DIR / default_name),
            "ZIP files (*.zip)",
        )
        if not target_path:
            return
        target = Path(target_path)
        if target.suffix.lower() != ".zip":
            target = target.with_suffix(".zip")
        target.parent.mkdir(parents=True, exist_ok=True)

        sources = self._iter_backup_sources()
        skipped_files: list[str] = []
        try:
            with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for source, archive_root in sources:
                    if source.is_dir():
                        for child in source.rglob("*"):
                            if child.is_dir():
                                continue
                            try:
                                rel_to_app_data = child.relative_to(APP_DATA_DIR)
                                if rel_to_app_data.parts and rel_to_app_data.parts[0] == "web_profile":
                                    lower_name = child.name.lower()
                                    if lower_name in {"cookies", "cookies-journal", "lock"}:
                                        skipped_files.append(str(child))
                                        continue
                            except ValueError:
                                pass
                            rel = child.relative_to(source)
                            try:
                                self._write_backup_member(archive, child, str(Path(archive_root) / rel))
                            except OSError:
                                skipped_files.append(str(child))
                    else:
                        try:
                            self._write_backup_member(archive, source, archive_root)
                        except OSError:
                            skipped_files.append(str(source))
        except OSError as exc:
            QMessageBox.critical(self, "Backup Failed", f"Could not create backup archive:\n{exc}")
            return
        if skipped_files:
            preview = "\n".join(skipped_files[:12])
            if len(skipped_files) > 12:
                preview += f"\n...and {len(skipped_files) - 12} more"
            QMessageBox.warning(
                self,
                "Backup Complete (with skipped files)",
                f"Backup archive created:\n{target}\n\nSome files were in use and skipped:\n{preview}",
            )
            return
        QMessageBox.information(self, "Backup Complete", f"Backup archive created:\n{target}")

    def restore_full_backup(self) -> None:
        source_path, _ = QFileDialog.getOpenFileName(
            self,
            "Restore Full Backup",
            str(APP_DATA_DIR),
            "ZIP files (*.zip)",
        )
        if not source_path:
            return
        answer = QMessageBox.warning(
            self,
            "Confirm Restore",
            "Restoring a backup will overwrite current local data.\n\nContinue?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return

        mapping: list[tuple[str, Path]] = [
            ("app_data", APP_DATA_DIR),
            ("app_root/addons.json", ADDONS_PATH),
            ("app_root/google_calendar_token.json", APP_ROOT / "google_calendar_token.json"),
            ("app_root/collector/collector.json", APP_ROOT / "collector" / "collector.json"),
            ("app_data/lifeline_memory.db", LIFELINE_MEMORY_DB_PATH),
            ("app_root/lifeline_memory.db", LIFELINE_MEMORY_DB_PATH),
            ("app_root/KINDROIDXL/journal", APP_ROOT / "KINDROIDXL" / "journal"),
            ("app_root/KINDROIDXL/transcripts", journal.LOCAL_TRANSCRIPTS_DIR),
            ("documents/journal", journal.DOCUMENTS_JOURNAL_DIR),
            ("documents/transcripts", journal.DOCUMENTS_TRANSCRIPTS_DIR),
            ("app_root/javascripts", APP_ROOT / "javascripts"),
        ]
        extracted_any = False
        skipped_files: list[str] = []
        try:
            with zipfile.ZipFile(source_path, "r") as archive:
                for member in archive.namelist():
                    safe_member = member.strip("/")
                    if not safe_member or safe_member.endswith("/"):
                        continue
                    for prefix, destination in mapping:
                        if safe_member == prefix:
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            try:
                                with archive.open(member) as src, destination.open("wb") as dest_fh:
                                    shutil.copyfileobj(src, dest_fh)
                            except OSError:
                                skipped_files.append(str(destination))
                                break
                            extracted_any = True
                            break
                        if safe_member.startswith(prefix + "/"):
                            relative = Path(safe_member).relative_to(prefix)
                            final_path = destination / relative
                            final_path.parent.mkdir(parents=True, exist_ok=True)
                            try:
                                with archive.open(member) as src, final_path.open("wb") as dest_fh:
                                    shutil.copyfileobj(src, dest_fh)
                            except OSError:
                                skipped_files.append(str(final_path))
                                break
                            extracted_any = True
                            break
        except (OSError, zipfile.BadZipFile) as exc:
            QMessageBox.critical(self, "Restore Failed", f"Could not restore backup archive:\n{exc}")
            return

        if not extracted_any:
            QMessageBox.warning(
                self,
                "Restore Incomplete",
                "No recognized KINDROIDXL backup files were found in this archive.",
            )
            return

        self.config = self._load_config()
        if hasattr(self, "settings_tab"):
            self.settings_tab.refresh_values()
        if hasattr(self, "directory_tab"):
            self.directory_tab.refresh_entries()
        if hasattr(self, "locations_tab"):
            self.locations_tab.refresh_entries()
        self._reload_scripts()
        if skipped_files:
            preview = "\n".join(skipped_files[:12])
            if len(skipped_files) > 12:
                preview += f"\n...and {len(skipped_files) - 12} more"
            QMessageBox.warning(
                self,
                "Restore Complete (with skipped files)",
                "Backup restored, but some files were in use and could not be overwritten right now.\n\n"
                f"{preview}\n\nFor best results, close and restart KINDROIDXL, then restore again.",
            )
            return
        QMessageBox.information(self, "Restore Complete", "Backup restored successfully.\n\nFor best results, restart KINDROIDXL.")


def main() -> int:
    app = QApplication(sys.argv)
    if QSystemTrayIcon.isSystemTrayAvailable():
        # Keep the background process alive when the last visible window closes.
        # Users should explicitly quit from the tray menu.
        app.setQuitOnLastWindowClosed(False)
    global _INSTANCE_GUARD
    instance_guard = QSharedMemory("KINDROIDXL_SINGLE_INSTANCE_GUARD")
    if not instance_guard.create(1):
        if instance_guard.error() == QSharedMemory.SharedMemoryError.AlreadyExists:
            QMessageBox.information(
                None,
                "KINDROIDXL already running",
                "Another KINDROIDXL instance is already running. Use the existing app from the system tray.",
            )
            return 0
        print(f"[WARN] Single-instance guard unavailable: {instance_guard.errorString()}")
    _INSTANCE_GUARD = instance_guard
    app.setStyle("Fusion")
    app.setFont(QFont("Inter", 10))
    window = KindroidMainWindow()
    if window.apply_startup_launch_behavior():
        window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
