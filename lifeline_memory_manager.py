#!/usr/bin/env python3
"""Standalone LIFELINE Memory Manager.

A PySide6 desktop inbox processor for transcript ``.txt`` files.  The app watches a
folder, buffers incoming transcript text, asks Ollama for structured memories,
stores raw chunks/events/keyword summaries in SQLite, and removes processed text
from transcript files only after a successful database transaction.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import importlib
import json
import hashlib
import base64
import os
import queue
import re
import sqlite3
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import urlparse


class DependencyInstaller:
    REQUIRED = {"PySide6": "PySide6", "requests": "requests", "watchdog": "watchdog", "psutil": "psutil"}
    OPTIONAL = {"jsonschema": "jsonschema"}

    @classmethod
    def ensure(cls) -> None:
        for module, package in {**cls.REQUIRED, **cls.OPTIONAL}.items():
            try:
                importlib.import_module(module)
            except ImportError:
                print(f"Installing missing dependency: {package}")
                subprocess.check_call([sys.executable, "-m", "pip", "install", package])


DependencyInstaller.ensure()

import psutil  # noqa: E402
import requests  # noqa: E402
from PySide6.QtCore import QObject, QSharedMemory, QSize, QThread, QTimer, Qt, Signal, Slot  # noqa: E402
from PySide6.QtGui import QAction, QFont, QIcon  # noqa: E402
from PySide6.QtWidgets import (  # noqa: E402
    QApplication, QDialog, QFileDialog, QFormLayout, QFrame, QGridLayout,
    QHBoxLayout, QLabel, QLineEdit, QMainWindow, QMessageBox, QPushButton, QPlainTextEdit,
    QMenu, QSplitter, QSpinBox, QDoubleSpinBox, QStatusBar, QStyle, QSystemTrayIcon,
    QTabWidget, QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget
)
from watchdog.events import FileSystemEventHandler  # noqa: E402
from watchdog.observers import Observer  # noqa: E402

def _default_documents_dir() -> Path:
    """Return the KINDROIDXL storage root, preferring the dedicated D: drive."""
    d_drive = Path("D:/")
    if (d_drive / "KINDROIDXL").exists() or d_drive.exists():
        return d_drive

    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        documents = Path(user_profile) / "Documents"
        if documents.exists():
            return documents

    home_documents = Path.home() / "Documents"
    if home_documents.exists():
        return home_documents

    return Path.home()


APP_ROOT = Path(__file__).resolve().parent
APP_DATA_DIR = _default_documents_dir() / "KINDROIDXL" / "kindroidxl_data"
DEFAULT_BACKUP_ROOT = _default_documents_dir() / "KINDROIDXL-backups"
DB_PATH = APP_DATA_DIR / "lifeline_memory.db"
LEGACY_DB_PATH = Path(__file__).with_name("lifeline_memory.db")
RUNTIME_DB_PATH = DB_PATH
RUNTIME_BACKUP_ROOT = DEFAULT_BACKUP_ROOT
RESTORE_SOURCE_USED = "none"
DEFAULT_TRANSCRIPT_FOLDER = APP_ROOT / "KINDROIDXL" / "transcripts"
VALID_TYPES = {"fact", "event", "plan", "preference", "relationship", "status", "lore", "project"}
KINDROID_REQUESTER = "LIFELINE-MEMORY-MANAGER-CONTEXT-REMINDER"
_INSTANCE_GUARD = None

GENERIC_KEYWORDS = {
    "week", "today", "tomorrow", "yesterday", "thing", "things", "discussion", "talk", "chat",
    "conversation", "good", "bad", "nice", "great", "next week", "later", "soon", "stuff", "person",
    "kiss", "kissing", "hug", "hugging", "smile", "laugh", "look", "touch", "hand", "eyes",
    "wall", "walls", "floor", "ceiling", "room", "rooms", "door", "doors", "window", "windows",
}

NON_PERSON_SUBJECTS = {
    "judge", "judges", "jury", "court", "lawyer", "lawyers", "council", "committee", "team", "people", "person", "group", "everyone",
    "everybody", "someone", "somebody", "unknown", "narrator", "user", "assistant", "system", "they", "them",
    "wall", "walls", "floor", "ceiling", "room", "rooms", "door", "doors", "window", "windows",
}

MAX_CONTEXT_REMINDERS_PER_CHUNK = 1
CONTEXT_REMINDER_COOLDOWN_SECONDS = 3600

MEMORY_ACTION_PATTERN = re.compile(
    r"\b(said|asked|told|shared|revealed|learned|decided|planned|agreed|promised|prefers|likes|"
    r"dislikes|wants|needs|is|was|has|had|will|works|created|completed|started|joined|left|"
    r"remembered|reported|confirmed|changed|updated|met|called|messaged)\b",
    re.IGNORECASE,
)


def _script_path_from_args(flag: str) -> Optional[Path]:
    try:
        index = sys.argv.index(flag)
        return Path(sys.argv[index + 1]).resolve()
    except (ValueError, IndexError, OSError):
        return None


def _pid_from_args(flag: str) -> Optional[int]:
    try:
        index = sys.argv.index(flag)
        pid = int(sys.argv[index + 1])
    except (ValueError, IndexError):
        return None
    return pid if pid > 0 else None


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help="--help" in argv or "-h" in argv)
    parser.add_argument("--auto-start", action="store_true")
    parser.add_argument("--main-pid", type=int, default=None)
    parser.add_argument("--main-script", default="")
    parser.add_argument("--db-path", default="")
    parser.add_argument("--backup-root", default="")
    args, _unknown = parser.parse_known_args(argv)
    return args


def _same_script_path(candidate: object, expected: Path) -> bool:
    try:
        return Path(str(candidate)).resolve() == expected
    except (OSError, RuntimeError, ValueError):
        return str(candidate) == str(expected)


def _process_cmdline_has_script(process: psutil.Process, script_path: Path) -> bool:
    try:
        cmdline = process.cmdline()
    except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess):
        return False
    return any(_same_script_path(part, script_path) for part in cmdline)


def _main_process_is_running(main_pid: Optional[int], main_script: Path) -> bool:
    if main_pid is not None:
        try:
            process = psutil.Process(main_pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False
        if process.pid == os.getpid() or not process.is_running():
            return False
        return _process_cmdline_has_script(process, main_script)

    current_pid = os.getpid()
    for process in psutil.process_iter(["pid"]):
        if process.info.get("pid") == current_pid:
            continue
        if _process_cmdline_has_script(process, main_script):
            return True
    return False


class MainProcessMonitor(QObject):
    """Close the memory manager when the owning main.py process is gone."""

    def __init__(self, app: QApplication, main_pid: Optional[int], main_script: Path) -> None:
        super().__init__(app)
        self.app = app
        self.main_pid = main_pid
        self.main_script = main_script
        self.timer = QTimer(self)
        self.timer.setInterval(2000)
        self.timer.timeout.connect(self.close_if_main_missing)

    def start(self) -> None:
        self.timer.start()

    @Slot()
    def close_if_main_missing(self) -> None:
        if not _main_process_is_running(self.main_pid, self.main_script):
            print("[INFO] main.py is no longer running; closing LIFELINE Memory Manager.")
            self.timer.stop()
            self.app.quit()


def now_iso() -> str:
    return _dt.datetime.now().replace(microsecond=0).isoformat()


def now_human() -> str:
    return _dt.datetime.now().strftime("%Y-%m-%d at %H:%M")


def extract_json(text: str) -> Dict[str, Any]:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.S)
        if not match:
            raise
        return json.loads(match.group(0))


def _word_matches(text: str, keyword: str) -> bool:
    keyword = re.sub(r"\s+", " ", keyword.strip().lower())
    if not keyword:
        return False
    pattern = r"(?<![\w])" + re.escape(keyword).replace(r"\ ", r"\s+") + r"(?![\w])"
    return re.search(pattern, text.lower()) is not None


def _content_hash(text: str) -> str:
    normalized = re.sub(r"\s+", " ", text.strip()).lower()
    return hashlib.sha256(normalized.encode("utf-8", errors="replace")).hexdigest()


def _normalized_transcript_text(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip()).casefold()


def _normalized_text_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _valid_person_subject(name: str, allowed: Set[str] | None = None, known: Set[str] | None = None) -> bool:
    clean = re.sub(r"\s+", " ", str(name).strip())
    folded = clean.casefold()
    if not clean or folded in NON_PERSON_SUBJECTS:
        return False
    if allowed is not None:
        return folded in allowed
    if known and folded in known:
        return True
    if len(clean) < 2 or len(clean) > 80 or any(ch.isdigit() for ch in clean):
        return False
    words = clean.split()
    if len(words) > 4 or any(len(word) < 2 for word in words):
        return False
    return all(re.match(r"^[A-Za-z][A-Za-z'’.-]*$", word) for word in words)


def _load_feeder_api_key() -> str:
    try:
        import modules.feeder as feeder  # pylint: disable=import-outside-toplevel

        state = feeder._load_state()  # pylint: disable=protected-access
    except Exception:
        return ""
    if not bool(state.get("remember_api_key", True)):
        return ""
    return str(state.get("api_key", "")).strip()


def _load_groupmaker_session_for_sources(source_file: str) -> Dict[str, Any]:
    """Find the relevant active GROUPMAKER-created group for a transcript source."""
    try:
        import modules.groupmaker as groupmaker  # pylint: disable=import-outside-toplevel

        path = groupmaker.GROUPMAKER_STATE_PATH
        if not path.exists():
            return {}
        state = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(state, dict):
        return {}

    sessions = [row for row in state.get("sessions", []) if isinstance(row, dict)]
    open_sessions = [row for row in sessions if str(row.get("group_id", "")).strip() and not str(row.get("closed_at", "")).strip()]
    if not open_sessions:
        return {}

    source_text = source_file.lower()
    for row in open_sessions:
        group_id = str(row.get("group_id", "")).strip()
        if group_id and group_id.lower() in source_text:
            return row

    active_key = str(state.get("active_session_key", "")).strip()
    if active_key:
        for row in open_sessions:
            if str(row.get("session_key", "")).strip() == active_key:
                return row

    open_sessions.sort(key=lambda row: str(row.get("touched_at", "")), reverse=True)
    return open_sessions[0] if open_sessions else {}


def _send_group_context_reminder(group_id: str, description: str) -> Tuple[bool, str]:
    api_key = _load_feeder_api_key()
    if not group_id:
        return False, "missing group_id"
    if not api_key.startswith("kn_"):
        return False, "missing remembered Kindroid API key"
    try:
        import modules.feeder as feeder  # pylint: disable=import-outside-toplevel

        ok, status, detail = feeder.execute_api_request(
            tool_key="send_groupchat_message",
            api_key=api_key,
            payload={"group_id": group_id, "message": f"*CONTEXT REMINDER: {description}*"},
            requester=KINDROID_REQUESTER,
        )
        return ok, status if ok else f"{status}: {detail[:180]}"
    except Exception as exc:
        return False, str(exc)



def _send_direct_context_reminder(ai_id: str, description: str) -> Tuple[bool, str]:
    api_key = _load_feeder_api_key()
    if not ai_id:
        return False, "missing ai_id"
    if not api_key.startswith("kn_"):
        return False, "missing remembered Kindroid API key"
    try:
        import modules.feeder as feeder  # pylint: disable=import-outside-toplevel

        payload = feeder.build_send_message_payload(
            ai_id=ai_id,
            message=f"*CONTEXT REMINDER: {description}*",
        )
        ok, status, detail = feeder.execute_api_request(
            tool_key="send_message",
            api_key=api_key,
            payload=payload,
            requester=KINDROID_REQUESTER,
        )
        return ok, status if ok else f"{status}: {detail[:180]}"
    except Exception as exc:
        return False, str(exc)


def _record_latest_group_context_reminders(session: Dict[str, Any], reminders: List[Dict[str, str]]) -> None:
    group_id = str(session.get("group_id", "")).strip()
    if not group_id or not reminders:
        return
    try:
        import modules.groupmaker as groupmaker  # pylint: disable=import-outside-toplevel

        path = groupmaker.GROUPMAKER_STATE_PATH
        state = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if not isinstance(state, dict):
            state = {}
        latest = state.get("latest_context_reminders", {})
        if not isinstance(latest, dict):
            latest = {}
        latest[group_id] = {
            "group_id": group_id,
            "session_key": str(session.get("session_key", "")).strip(),
            "sent_at": now_iso(),
            "names": [str(name).strip() for name in session.get("names", []) if str(name).strip()],
            "reminders": [
                {
                    "person": str(reminder.get("person", "")).strip(),
                    "keyword": str(reminder.get("keyword", "")).strip(),
                    "description": str(reminder.get("description", "")).strip(),
                }
                for reminder in reminders
                if str(reminder.get("description", "")).strip()
            ],
        }
        state["latest_context_reminders"] = latest
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        return

def default_transcript_folder() -> str:
    DEFAULT_TRANSCRIPT_FOLDER.mkdir(parents=True, exist_ok=True)
    return str(DEFAULT_TRANSCRIPT_FOLDER)


class AppSettings:
    DEFAULTS = {
        "transcript_folder": default_transcript_folder, "ollama_url": "http://localhost:11434", "ollama_model": "qwen3.5:9b",
        "chunk_size": "4000", "minimum_idle_chunk_size": "1500", "maximum_chunk_size": "8000",
        "idle_timeout": "90", "confidence_threshold": "0.75", "context_reminders_enabled": "1", "window_geometry": "",
    }

    def __init__(self, db: "MemoryDB") -> None:
        self.db = db

    def default(self, key: str) -> str:
        value = self.DEFAULTS.get(key, "")
        return str(value()) if callable(value) else str(value)

    def get(self, key: str) -> str:
        value = self.db.get_setting(key, "")
        return value if value.strip() else self.default(key)

    def set(self, key: str, value: Any) -> None:
        self.db.set_setting(key, str(value))

    def int(self, key: str) -> int:
        return int(float(self.get(key)))

    def float(self, key: str) -> float:
        return float(self.get(key))


class MemoryDB:
    def __init__(self, path: Path | None = None, backup_root: Path | None = None) -> None:
        self.path = path or RUNTIME_DB_PATH
        self.backup_root = backup_root or RUNTIME_BACKUP_ROOT
        self.memory_backup_root = self.backup_root / "LIFELINE_MEMORY"
        self.latest_mirror_path = self.path.with_name("lifeline_memory.latest.db")
        self.latest_backup_mirror_path = self.memory_backup_root / "lifeline_memory.latest.db"
        self.last_write = "never"
        self.last_external_mirror = "never"
        self.last_snapshot = "never"
        self.restore_source = RESTORE_SOURCE_USED
        self.lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.memory_backup_root.mkdir(parents=True, exist_ok=True)
        self._recover_from_legacy_database()
        self.init_schema()
        print(f"[LIFELINE DB] using database: {self.path}")
        print(f"[LIFELINE DB] backup root: {self.memory_backup_root}")

    @staticmethod
    def _database_score(path: Path) -> int:
        if not path.is_file() or path.stat().st_size <= 0:
            return 0
        tables = ("memory_events", "transcript_chunks", "keyword_nodes", "people")
        score = 0
        try:
            with sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30) as conn:
                existing = {
                    str(row[0])
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?,?,?)",
                        tables,
                    )
                }
                for table in tables:
                    if table in existing:
                        score += int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] or 0)
        except (OSError, sqlite3.Error):
            return 0
        return score

    def _recover_from_legacy_database(self) -> None:
        if LEGACY_DB_PATH.resolve() == self.path.resolve():
            return
        legacy_score = self._database_score(LEGACY_DB_PATH)
        active_score = self._database_score(self.path)
        if legacy_score <= active_score:
            return
        with sqlite3.connect(f"file:{LEGACY_DB_PATH}?mode=ro", uri=True, timeout=30) as src_conn:
            with sqlite3.connect(self.path) as dest_conn:
                src_conn.backup(dest_conn)
        print(
            "[LIFELINE Memory] Recovered legacy project-root database into persistent app data "
            f"({legacy_score} legacy rows vs {active_score} active rows): {self.path}"
        )

    def integrity_ok(self, path: Optional[Path] = None) -> bool:
        target = path or self.path
        try:
            with sqlite3.connect(f"file:{target}?mode=ro", uri=True, timeout=30) as conn:
                return str(conn.execute("PRAGMA integrity_check").fetchone()[0]).lower() == "ok"
        except (OSError, sqlite3.Error):
            return False

    def backup_score(self) -> int:
        return max(self._database_score(self.latest_mirror_path), self._database_score(self.latest_backup_mirror_path))

    def mirror_to_external_backup(self, create_snapshot: bool = True) -> Tuple[bool, str]:
        if not self.integrity_ok(self.path):
            return False, "active database failed integrity_check"
        self.latest_mirror_path.parent.mkdir(parents=True, exist_ok=True)
        self.latest_backup_mirror_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=30) as src_conn:
            with sqlite3.connect(self.latest_mirror_path) as dest_conn:
                src_conn.backup(dest_conn)
            with sqlite3.connect(self.latest_backup_mirror_path) as backup_dest_conn:
                src_conn.backup(backup_dest_conn)
        self.last_external_mirror = now_human()
        print(f"[LIFELINE DB] external mirror updated: {self.latest_mirror_path}")
        print(f"[LIFELINE DB] external backup mirror updated: {self.latest_backup_mirror_path}")
        snapshot_msg = "no snapshot requested"
        if create_snapshot:
            self.memory_backup_root.mkdir(parents=True, exist_ok=True)
            snapshot = self.memory_backup_root / f"lifeline_memory_{_dt.datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
            with sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=30) as src_conn:
                with sqlite3.connect(snapshot) as dest_conn:
                    src_conn.backup(dest_conn)
            self.last_snapshot = str(snapshot)
            snapshot_msg = str(snapshot)
            print(f"[LIFELINE DB] backup snapshot created: {snapshot}")
            self._rotate_memory_backups()
        return True, snapshot_msg

    def _rotate_memory_backups(self, keep: int = 288) -> None:
        snapshots = sorted(self.memory_backup_root.glob("lifeline_memory_*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
        if len(snapshots) <= keep:
            return
        best = max(snapshots, key=self._database_score, default=None)
        for old in snapshots[keep:]:
            if best is not None and old.resolve() == best.resolve():
                continue
            try:
                old.unlink()
            except OSError:
                pass

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def init_schema(self) -> None:
        schema = """
        CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, aliases TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS transcript_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, source_file TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT DEFAULT '', created_at TEXT NOT NULL, processed_at TEXT, status TEXT NOT NULL, error TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS memory_events (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, description TEXT NOT NULL, memory_type TEXT NOT NULL, event_time TEXT NOT NULL, confidence REAL DEFAULT 0.0, source_chunk_id INTEGER, created_at TEXT NOT NULL, FOREIGN KEY(person_id) REFERENCES people(id), FOREIGN KEY(source_chunk_id) REFERENCES transcript_chunks(id));
        CREATE TABLE IF NOT EXISTS keyword_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, keyword TEXT NOT NULL, active_summary TEXT NOT NULL, raw_compilation TEXT DEFAULT '', revision_count INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_cleaned_at TEXT, UNIQUE(person_id, keyword), FOREIGN KEY(person_id) REFERENCES people(id));
        CREATE TABLE IF NOT EXISTS memory_event_keywords (event_id INTEGER NOT NULL, keyword_node_id INTEGER NOT NULL, PRIMARY KEY(event_id, keyword_node_id), FOREIGN KEY(event_id) REFERENCES memory_events(id), FOREIGN KEY(keyword_node_id) REFERENCES keyword_nodes(id));
        CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """
        with self.lock, self.connect() as conn:
            conn.executescript(schema)
            columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(transcript_chunks)")}
            if "content_hash" not in columns:
                conn.execute("ALTER TABLE transcript_chunks ADD COLUMN content_hash TEXT DEFAULT ''")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_chunks_content_hash ON transcript_chunks(content_hash) WHERE content_hash <> ''")

    def get_setting(self, key: str, default: str = "") -> str:
        with self.lock, self.connect() as conn:
            row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
            return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self.lock, self.connect() as conn:
            conn.execute("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def _mark_changed(self, conn: sqlite3.Connection, change_type: str) -> str:
        ts = now_iso()
        conn.execute(
            "INSERT INTO app_settings(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            ("lifeline_memory_last_mutation_at", ts),
        )
        conn.execute(
            "INSERT INTO app_settings(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            ("lifeline_memory_last_mutation_type", change_type),
        )
        return ts

    def known_people(self) -> List[str]:
        with self.lock, self.connect() as conn:
            return [r["name"] for r in conn.execute("SELECT name FROM people ORDER BY name")]

    def chunk_already_processed(self, content: str) -> bool:
        digest = _content_hash(content)
        if not digest:
            return False
        with self.lock, self.connect() as conn:
            row = conn.execute("SELECT 1 FROM transcript_chunks WHERE content_hash=? LIMIT 1", (digest,)).fetchone()
            return row is not None

    def chunk_already_seen_in_recent_source(self, source_file: str, content: str, recent_limit: int = 25) -> bool:
        """Detect chunks already contained in recent processed transcript text for the same source."""
        normalized = _normalized_transcript_text(content)
        if not normalized:
            return False
        with self.lock, self.connect() as conn:
            rows = conn.execute(
                """
                SELECT content
                FROM transcript_chunks
                WHERE source_file=? AND status LIKE 'processed%'
                ORDER BY id DESC
                LIMIT ?
                """,
                (source_file, recent_limit),
            ).fetchall()
        recent_text = _normalized_transcript_text("\n".join(str(row["content"] or "") for row in rows))
        return bool(recent_text and normalized in recent_text)

    def context_reminders_for_transcript(self, transcript_text: str, group_people: Iterable[str]) -> List[Dict[str, str]]:
        """Return matching memory summaries for people currently present in a GROUPMAKER group."""
        present = {str(name).strip().upper() for name in group_people if str(name).strip()}
        if not transcript_text.strip() or not present:
            return []

        matches: List[Dict[str, str]] = []
        seen: Set[Tuple[str, str]] = set()
        with self.lock, self.connect() as conn:
            rows = conn.execute(
                """
                SELECT p.name AS person, kn.keyword, kn.active_summary
                FROM keyword_nodes kn
                JOIN people p ON p.id = kn.person_id
                WHERE UPPER(p.name) IN ({})
                ORDER BY p.name, LENGTH(kn.keyword) DESC, kn.keyword
                """.format(",".join("?" for _ in present)),
                tuple(sorted(present)),
            ).fetchall()

        for row in rows:
            keyword = str(row["keyword"] or "").strip()
            summary = str(row["active_summary"] or "").strip()
            person = str(row["person"] or "").strip()
            if not keyword or not summary or not _word_matches(transcript_text, keyword):
                continue
            key = (person.upper(), summary)
            if key in seen:
                continue
            seen.add(key)
            matches.append({"person": person, "keyword": keyword, "description": summary})
        return matches


    def clear_all_memory(self) -> Tuple[int, str]:
        """Delete all stored memory data while preserving app settings and a backup snapshot."""
        ok, snapshot = self.mirror_to_external_backup(create_snapshot=True)
        if not ok:
            raise RuntimeError(f"Backup snapshot failed; memory was not cleared: {snapshot}")
        with self.lock, self.connect() as conn:
            try:
                conn.execute("BEGIN")
                counts = {
                    "memory_event_keywords": conn.execute("SELECT COUNT(*) FROM memory_event_keywords").fetchone()[0],
                    "memory_events": conn.execute("SELECT COUNT(*) FROM memory_events").fetchone()[0],
                    "keyword_nodes": conn.execute("SELECT COUNT(*) FROM keyword_nodes").fetchone()[0],
                    "transcript_chunks": conn.execute("SELECT COUNT(*) FROM transcript_chunks").fetchone()[0],
                    "people": conn.execute("SELECT COUNT(*) FROM people").fetchone()[0],
                }
                for table in ("memory_event_keywords", "memory_events", "keyword_nodes", "transcript_chunks", "people"):
                    conn.execute(f"DELETE FROM {table}")
                conn.execute(
                    "DELETE FROM sqlite_sequence WHERE name IN "
                    "('memory_events','keyword_nodes','transcript_chunks','people')"
                )
                cleared_at = self._mark_changed(conn, "clear_all_memory")
                conn.execute(
                    "INSERT INTO app_settings(key,value) VALUES(?,?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    ("lifeline_memory_cleared_at", cleared_at),
                )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        deleted = int(sum(counts.values()))
        self.last_write = now_human()
        ok, detail = self.mirror_to_external_backup(create_snapshot=False)
        if not ok:
            raise RuntimeError(f"Memory cleared, but mirror update failed: {detail}")
        return deleted, snapshot

    def _person_id(self, conn: sqlite3.Connection, name: str) -> int:
        name = name.strip().upper()
        ts = now_iso()
        conn.execute("INSERT INTO people(name,created_at,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET updated_at=excluded.updated_at", (name, ts, ts))
        return int(conn.execute("SELECT id FROM people WHERE name=?", (name,)).fetchone()["id"])

    def store_processed_chunk(self, source_file: str, content: str, memories: List[Dict[str, Any]]) -> List[Tuple[int, int, str, str, str]]:
        cleanup_jobs: List[Tuple[int, int, str, str, str]] = []
        with self.lock, self.connect() as conn:
            try:
                conn.execute("BEGIN")
                ts = now_iso()
                digest = _content_hash(content)
                cur = conn.execute("INSERT OR IGNORE INTO transcript_chunks(source_file,content,content_hash,created_at,processed_at,status) VALUES(?,?,?,?,?,?)", (source_file, content, digest, ts, ts, "processed_no_memories" if not memories else "processed"))
                inserted = int(conn.execute("SELECT changes()").fetchone()[0] or 0)
                if inserted == 0:
                    conn.commit()
                    return []
                chunk_id = int(cur.lastrowid)
                for mem in memories:
                    subjects = [s.strip().upper() for s in mem["subjects"] if str(s).strip()]
                    for subject in subjects:
                        pid = self._person_id(conn, subject)
                        ev = conn.execute("INSERT INTO memory_events(person_id,description,memory_type,event_time,confidence,source_chunk_id,created_at) VALUES(?,?,?,?,?,?,?)", (pid, mem["description"], mem["memory_type"], mem.get("event_time", ts), float(mem["confidence"]), chunk_id, ts))
                        event_id = int(ev.lastrowid)
                        for kw in mem["keywords"]:
                            existing = conn.execute("SELECT id,active_summary FROM keyword_nodes WHERE person_id=? AND keyword=?", (pid, kw)).fetchone()
                            raw = self._raw_events_for_node(conn, pid, kw, extra=mem["description"])
                            if existing:
                                node_id = int(existing["id"])
                                conn.execute("UPDATE keyword_nodes SET raw_compilation=?, updated_at=? WHERE id=?", (raw, ts, node_id))
                                cleanup_jobs.append((node_id, pid, subject, kw, mem["description"]))
                            else:
                                active = mem["description"]
                                cur2 = conn.execute("INSERT INTO keyword_nodes(person_id,keyword,active_summary,raw_compilation,created_at,updated_at) VALUES(?,?,?,?,?,?)", (pid, kw, active, raw, ts, ts))
                                node_id = int(cur2.lastrowid)
                            conn.execute("INSERT OR IGNORE INTO memory_event_keywords(event_id,keyword_node_id) VALUES(?,?)", (event_id, node_id))
                self._mark_changed(conn, "store_processed_chunk")
                conn.commit()
                self.last_write = now_human()
                print(f"[LIFELINE DB] write committed: {len(memories)} new memories")
                ok, detail = self.mirror_to_external_backup(create_snapshot=True)
                if not ok:
                    print(f"[LIFELINE DB] external mirror failed: {detail}")
                return cleanup_jobs
            except Exception:
                conn.rollback()
                raise

    def _raw_events_for_node(self, conn: sqlite3.Connection, pid: int, kw: str, extra: str = "") -> str:
        rows = conn.execute("""SELECT me.description FROM memory_events me JOIN memory_event_keywords mek ON me.id=mek.event_id JOIN keyword_nodes kn ON kn.id=mek.keyword_node_id WHERE me.person_id=? AND kn.keyword=? ORDER BY me.id DESC LIMIT 12""", (pid, kw)).fetchall()
        items = [r["description"] for r in rows]
        if extra and extra not in items:
            items.insert(0, extra)
        return "\n".join(f"- {x}" for x in items[:12])

    def node_detail(self, node_id: int) -> Optional[sqlite3.Row]:
        with self.lock, self.connect() as conn:
            return conn.execute("SELECT kn.*, p.name person FROM keyword_nodes kn JOIN people p ON p.id=kn.person_id WHERE kn.id=?", (node_id,)).fetchone()

    def update_node_summary(self, node_id: int, summary: str, cleaned: bool = False) -> None:
        with self.lock, self.connect() as conn:
            if cleaned:
                conn.execute("UPDATE keyword_nodes SET active_summary=?, revision_count=revision_count+1, updated_at=?, last_cleaned_at=? WHERE id=?", (summary, now_iso(), now_iso(), node_id))
            else:
                conn.execute("UPDATE keyword_nodes SET active_summary=?, updated_at=? WHERE id=?", (summary, now_iso(), node_id))
            self._mark_changed(conn, "update_node_summary")
        self.last_write = now_human()
        self.mirror_to_external_backup(create_snapshot=True)

    def delete_node(self, node_id: int) -> None:
        with self.lock, self.connect() as conn:
            conn.execute("DELETE FROM memory_event_keywords WHERE keyword_node_id=?", (node_id,)); conn.execute("DELETE FROM keyword_nodes WHERE id=?", (node_id,))
            self._mark_changed(conn, "delete_node")
        self.last_write = now_human()
        self.mirror_to_external_backup(create_snapshot=True)

    def delete_latest_event_for_node(self, node_id: int) -> None:
        with self.lock, self.connect() as conn:
            row = conn.execute("""SELECT me.id FROM memory_events me JOIN memory_event_keywords mek ON me.id=mek.event_id WHERE mek.keyword_node_id=? ORDER BY me.id DESC LIMIT 1""", (node_id,)).fetchone()
            if not row:
                return
            event_id = int(row["id"])
            conn.execute("DELETE FROM memory_event_keywords WHERE event_id=?", (event_id,))
            conn.execute("DELETE FROM memory_events WHERE id=?", (event_id,))
            detail = conn.execute("SELECT person_id, keyword FROM keyword_nodes WHERE id=?", (node_id,)).fetchone()
            if detail:
                raw = self._raw_events_for_node(conn, int(detail["person_id"]), detail["keyword"])
                conn.execute("UPDATE keyword_nodes SET raw_compilation=?, updated_at=? WHERE id=?", (raw, now_iso(), node_id))
            self._mark_changed(conn, "delete_latest_event_for_node")
        self.last_write = now_human()
        self.mirror_to_external_backup(create_snapshot=True)

    def tree(self) -> List[sqlite3.Row]:
        with self.lock, self.connect() as conn:
            return conn.execute("SELECT p.name, kn.keyword, kn.id FROM people p LEFT JOIN keyword_nodes kn ON kn.person_id=p.id ORDER BY p.name, kn.keyword").fetchall()

    def explorer_nodes(self, query: str = "") -> List[sqlite3.Row]:
        """Return keyword nodes with enough metadata to power the expanded memory explorer."""
        search = f"%{query.strip().lower()}%"
        where = ""
        params: Tuple[str, ...] = ()
        if query.strip():
            where = """
            WHERE LOWER(p.name) LIKE ?
               OR LOWER(kn.keyword) LIKE ?
               OR LOWER(kn.active_summary) LIKE ?
               OR LOWER(kn.raw_compilation) LIKE ?
            """
            params = (search, search, search, search)
        with self.lock, self.connect() as conn:
            return conn.execute(
                f"""
                SELECT
                    kn.id,
                    p.name AS person,
                    kn.keyword,
                    kn.active_summary,
                    kn.raw_compilation,
                    kn.revision_count,
                    kn.updated_at,
                    kn.last_cleaned_at,
                    COUNT(mek.event_id) AS event_count
                FROM keyword_nodes kn
                JOIN people p ON p.id = kn.person_id
                LEFT JOIN memory_event_keywords mek ON mek.keyword_node_id = kn.id
                {where}
                GROUP BY kn.id
                ORDER BY p.name, kn.keyword
                """,
                params,
            ).fetchall()

    def stats(self) -> Dict[str, int]:
        with self.lock, self.connect() as conn:
            return {"people": conn.execute("SELECT COUNT(*) c FROM people").fetchone()["c"], "events": conn.execute("SELECT COUNT(*) c FROM memory_events").fetchone()["c"], "nodes": conn.execute("SELECT COUNT(*) c FROM keyword_nodes").fetchone()["c"], "chunks": conn.execute("SELECT COUNT(*) c FROM transcript_chunks WHERE status LIKE 'processed%'").fetchone()["c"], "waiting": conn.execute("SELECT COUNT(*) c FROM transcript_chunks WHERE status='pending'").fetchone()["c"]}




def _ollama_candidate_paths() -> List[Path]:
    """Return common Windows Ollama executable locations to try before API calls."""
    candidates: List[Path] = []
    local_app_data = os.environ.get("LOCALAPPDATA")
    user_profile = os.environ.get("USERPROFILE")
    program_files = os.environ.get("PROGRAMFILES")
    program_files_x86 = os.environ.get("PROGRAMFILES(X86)")

    base_dirs = [
        Path(local_app_data) / "Programs" / "Ollama" if local_app_data else None,
        Path(user_profile) / "AppData" / "Local" / "Programs" / "Ollama" if user_profile else None,
        Path("C:/Users/UNCLESAM450/AppData/Local/Programs/Ollama"),
        Path(program_files) / "Ollama" if program_files else None,
        Path(program_files_x86) / "Ollama" if program_files_x86 else None,
    ]
    executable_names = ("ollama app.exe", "Ollama app.exe", "ollama.exe", "Ollama.exe")
    seen: Set[str] = set()
    for base_dir in base_dirs:
        if base_dir is None:
            continue
        for executable_name in executable_names:
            candidate = base_dir / executable_name
            key = str(candidate).casefold()
            if key not in seen:
                candidates.append(candidate)
                seen.add(key)
    return candidates


def _is_local_ollama_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.hostname in {"localhost", "127.0.0.1", "::1"}


def _ollama_api_available(url: str, timeout: float = 1.0) -> bool:
    try:
        response = requests.get(f"{url.rstrip('/')}/api/tags", timeout=timeout)
        return response.ok
    except requests.RequestException:
        return False


def _start_local_ollama(url: str) -> Tuple[bool, str]:
    """Start Ollama from common local installs when the configured API is local."""
    if not _is_local_ollama_url(url):
        return False, "configured Ollama endpoint is not local"
    if _ollama_api_available(url):
        return True, "Ollama is already running"

    start_candidates = [candidate for candidate in _ollama_candidate_paths() if candidate.exists()]
    if not start_candidates:
        return False, "Ollama executable not found in common install locations"

    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    last_error = ""
    for candidate in start_candidates:
        try:
            lower_name = candidate.name.lower()
            if os.name == "nt" and lower_name == "ollama app.exe":
                # The desktop app is what the Windows installer commonly exposes.
                # ShellExecute/os.startfile handles GUI app activation more reliably
                # than Popen for this executable, especially when the path contains
                # spaces, for example: ...\Ollama\ollama app.exe.
                os.startfile(str(candidate))  # type: ignore[attr-defined]
            else:
                command = [str(candidate), "serve"] if lower_name == "ollama.exe" else [str(candidate)]
                subprocess.Popen(
                    command,
                    cwd=str(candidate.parent),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=creationflags,
                    close_fds=os.name != "nt",
                )
            for _attempt in range(90):
                if _ollama_api_available(url):
                    return True, f"Started Ollama from {candidate}"
                time.sleep(0.5)
            last_error = f"started {candidate}, but API did not become ready"
        except Exception as exc:
            last_error = f"{candidate}: {exc}"
    return False, last_error or "Unable to start Ollama"

class OllamaClient:
    def __init__(self, url: str, model: str) -> None:
        self.url = url.rstrip("/"); self.model = model

    def check(self) -> Tuple[bool, str]:
        try:
            r = requests.get(f"{self.url}/api/tags", timeout=5); r.raise_for_status()
            models = [m.get("name", "") for m in r.json().get("models", [])]
            status = f"Ollama: Connected; model {'available' if self.model in models else 'missing'} ({self.model})"
            return (self.model in models, status)
        except Exception as e:
            return False, f"Ollama error: {e}; start Ollama from launcher.py with the Right arrow"

    def generate(self, prompt: str) -> Tuple[str, Dict[str, Any]]:
        payload = {"model": self.model, "prompt": prompt, "stream": False, "format": "json", "think": False}
        r = requests.post(f"{self.url}/api/generate", json=payload, timeout=(10, 900)); r.raise_for_status()
        response_payload = r.json()
        raw = str(response_payload.get("response") or "")
        thinking = str(response_payload.get("thinking") or "")
        parse_source = raw if raw.strip() else thinking
        return parse_source, extract_json(parse_source)


class MemoryExtractor:
    def __init__(self, confidence: float) -> None:
        self.confidence = confidence
        self.rejected: List[str] = []

    def prompt(self, chunk: str, present_people: Iterable[str]) -> str:
        people_text = ", ".join(str(name).strip() for name in present_people if str(name).strip())
        return f'''You are a memory extraction engine for an AI companion memory database.

Your job is to read a transcript chunk and extract only clear, useful memories.

Rules:
- Return only valid JSON.
- Do not include markdown.
- Do not invent facts.
- Do not extract vague or unclear information.
- Do not extract meaningless small talk.
- Do not extract scenery, props, objects, body parts, or background facts unless a present participant made a durable decision/preference/status about them.
- Every memory must include a date and time in the description.
- Write transcript actions/events in past tense (for example, "participated in a podcast" instead of "starts a podcast"); only ongoing statuses may stay present-tense when that is the fact being remembered.
- Participant names are subjects, never keywords.
- Subjects must be specific named individual people only. Never create subjects such as judges, people, everyone, user, assistant, narrator, or groups/roles.
- Use ONLY the present GROUPMAKER participants listed below as subjects. If none of those exact participants performed/said/planned/revealed something durable, return {{"memories": []}}.
- Keywords must be durable topics, objects, activities, concepts, statuses, or media references.
- Do not create separate memories for tiny repeated gestures or phrasing variations such as kiss, kiss with passion, kiss tenderly, hug, look, smile, touch.
- Do not use generic keywords like week, today, tomorrow, thing, discussion, talk, good, bad.
- If a named media/public reference is needed, use the full phrase as one keyword, such as "steven seagal".
- If nothing meaningful is found, return {{"memories": []}}.

Current date/time:
{now_human()}

Present GROUPMAKER participants allowed as subjects:
{people_text or '(none - return {{"memories": []}})'}

Transcript chunk:
{chunk}

Return JSON in this exact shape:
{{"memories":[{{"subjects":["PERSON_NAME"],"description":"On YYYY-MM-DD at HH:MM, ...","keywords":["keyword"],"memory_type":"fact|event|plan|preference|relationship|status|lore|project","confidence":0.95}}]}}'''

    @staticmethod
    def _past_tense_description(desc: str) -> str:
        replacements = [
            (r"\bstarts\s+(a|an|the)\s+podcast\b", r"participated in \1 podcast"),
            (r"\bstarts\s+podcast\b", "participated in a podcast"),
            (r"\bmentions\b", "mentioned"),
            (r"\bdiscusses\b", "discussed"),
            (r"\bexplains\b", "explained"),
            (r"\bshares\b", "shared"),
            (r"\btells\b", "told"),
            (r"\bsays\b", "said"),
            (r"\basks\b", "asked"),
            (r"\bplans\b", "planned"),
        ]
        for pattern, replacement in replacements:
            desc = re.sub(pattern, replacement, desc, flags=re.IGNORECASE)
        return desc

    def validate(self, parsed: Dict[str, Any], allowed_subjects: Iterable[str] | None = None, known_people: Iterable[str] | None = None) -> List[Dict[str, Any]]:
        self.rejected = []
        allowed_set = {str(name).strip().casefold() for name in allowed_subjects or [] if str(name).strip()}
        if not allowed_set:
            self.rejected.append("Extraction rejected: no active GROUPMAKER participants were provided")
            return []
        known_set = {str(name).strip().casefold() for name in known_people or [] if str(name).strip()}
        allowed_filter = allowed_set
        seen_memories: Set[Tuple[Tuple[str, ...], str]] = set()
        memories = parsed.get("memories")
        if not isinstance(memories, list):
            raise ValueError("Ollama JSON did not contain a memories list")
        valid = []
        for i, mem in enumerate(memories, 1):
            try:
                subjects = mem["subjects"]; desc = str(mem["description"]).strip(); kws = mem["keywords"]
                mtype = str(mem.get("memory_type") or "fact").strip().lower()
                conf_raw = mem.get("confidence", self.confidence)
                conf = self.confidence if conf_raw in (None, "") else float(conf_raw)
                if isinstance(subjects, str): subjects = [subjects]
                if isinstance(kws, str): kws = [kws]
                if not isinstance(subjects, list) or not subjects or not isinstance(kws, list): raise ValueError("missing list fields")
                clean_subjects = []
                for subject in subjects:
                    subject_name = re.sub(r"\s+", " ", str(subject).strip())
                    if _valid_person_subject(subject_name, allowed_filter, known_set):
                        normalized_subject = subject_name.upper()
                        if normalized_subject not in clean_subjects:
                            clean_subjects.append(normalized_subject)
                if not clean_subjects:
                    raise ValueError("no valid DIRECTORY/GROUPMAKER person subjects")
                if conf < self.confidence: raise ValueError(f"confidence {conf} below threshold")
                if mtype not in VALID_TYPES: raise ValueError(f"invalid type {mtype}")
                if not MEMORY_ACTION_PATTERN.search(desc): raise ValueError("description is not a durable participant event/status/preference")
                subject_names = {str(s).strip().lower() for s in clean_subjects}
                norm = []
                for kw in sorted(kws, key=lambda value: len(str(value))):
                    k = re.sub(r"\s+", " ", str(kw).strip().lower())
                    if not k or k in GENERIC_KEYWORDS or k in subject_names: continue
                    if len(k) < 3 or len(k) > 48 or len(k.split()) > 3: continue
                    if any(k == existing or k in existing or existing in k for existing in norm): continue
                    norm.append(k)
                    if len(norm) >= 3: break
                if not norm: raise ValueError("no usable keywords after normalization")
                if not re.search(r"\d{4}-\d{2}-\d{2}.*\d{1,2}:\d{2}", desc):
                    desc = f"On {now_human()}, {desc}"
                desc = self._past_tense_description(desc)
                memory_key = (tuple(sorted(clean_subjects)), _normalized_text_key(desc))
                if memory_key in seen_memories:
                    raise ValueError("duplicate memory in same chunk")
                seen_memories.add(memory_key)
                valid.append({"subjects": clean_subjects, "description": desc, "keywords": norm, "memory_type": mtype, "confidence": conf, "event_time": now_iso()})
            except Exception as e:
                self.rejected.append(f"Memory #{i} rejected: {e}")
        return valid


class MemoryCleaner:
    @staticmethod
    def prompt(person: str, keyword: str, active: str, new_event: str, raw: str) -> str:
        return f'''You are a memory cleanup engine.

You are updating one memory keyword node for one person.

Person:
{person}

Keyword:
{keyword}

Existing active summary:
{active}

New memory event:
{new_event}

Recent related raw events:
{raw}

Task:
Create one concise updated active summary for this person and keyword.

Rules:
- Preserve important facts.
- Preserve timeline when relevant.
- If new information contradicts old information, explain the evolution naturally.
- Remove repetition.
- Do not invent details.
- Do not mention uncertainty unless the source is unclear.
- Keep it short but useful for an AI companion to remember.
- Return only valid JSON.
- Do not include markdown.

Return:
{{"active_summary":"..."}}'''


@dataclass
class FileChunk:
    path: Path
    text: str


class TranscriptBuffer:
    def __init__(self, target: int, minimum_idle: int, maximum: int) -> None:
        self.target = target; self.minimum_idle = minimum_idle; self.maximum = maximum
        self.items: List[FileChunk] = []; self.size = 0; self.last_update = time.time()

    def add(self, path: Path, text: str) -> None:
        if text:
            self.items.append(FileChunk(path, text)); self.size += len(text); self.last_update = time.time()

    def should_flush(self, idle_timeout: int) -> bool:
        return self.size >= self.target or (self.size >= self.minimum_idle and time.time() - self.last_update >= idle_timeout)

    def pop_chunk(self) -> Tuple[str, Dict[Path, int]]:
        remaining = self.maximum; parts = []; consumed: Dict[Path, int] = {}
        while self.items and remaining > 0:
            item = self.items[0]; take = min(len(item.text), remaining)
            parts.append(item.text[:take]); consumed[item.path] = consumed.get(item.path, 0) + take
            item.text = item.text[take:]; self.size -= take; remaining -= take
            if not item.text: self.items.pop(0)
        return "\n".join(parts), consumed


class FolderEvent(FileSystemEventHandler):
    def __init__(self, callback: Callable[[Path], None]) -> None: self.callback = callback
    def on_created(self, event):
        if not event.is_directory and str(event.src_path).lower().endswith('.txt'): self.callback(Path(event.src_path))
    def on_modified(self, event):
        if not event.is_directory and str(event.src_path).lower().endswith('.txt'): self.callback(Path(event.src_path))


class ProcessingWorker(QObject):
    log = Signal(str); status = Signal(str); monitor = Signal(dict); output = Signal(str, str); refreshed = Signal(); error = Signal(str)

    def __init__(self, db: MemoryDB, settings: AppSettings) -> None:
        super().__init__(); self.db = db; self.settings = settings; self.stop_flag = threading.Event(); self.observer = None
        self.queue: "queue.Queue[Path]" = queue.Queue(); self.cleanup_queue: "queue.Queue[Tuple[int,int,str,str,str]]" = queue.Queue(); self.seen_sizes: Dict[Path, int] = {}; self.read_retry_log_at: Dict[Path, float] = {}; self.context_reminder_sent_at: Dict[Tuple[str, str], float] = {}
        self.buffer = TranscriptBuffer(settings.int('chunk_size'), settings.int('minimum_idle_chunk_size'), settings.int('maximum_chunk_size'))

    @Slot(str)
    def start(self, folder: str) -> None:
        self.stop_flag.clear(); f = Path(folder); f.mkdir(parents=True, exist_ok=True)
        self.observer = Observer(); self.observer.schedule(FolderEvent(lambda p: self.queue.put(p)), str(f), recursive=False); self.observer.start()
        for p in f.glob('*.txt'): self.queue.put(p)
        self.log.emit(f"Watching {f}"); self.status.emit("Watching")
        self.loop()

    @Slot()
    def stop(self) -> None:
        self.stop_flag.set()
        if self.observer: self.observer.stop(); self.observer.join(3)
        self.status.emit("Idle")

    def loop(self) -> None:
        idle = self.settings.int('idle_timeout')
        while not self.stop_flag.is_set():
            try:
                p = self.queue.get(timeout=0.5); self.read_new(p)
            except queue.Empty: pass
            if self.buffer.should_flush(idle): self.process_one()
            if not self.cleanup_queue.empty(): self.clean_one()
            self.monitor.emit({"buffered": self.buffer.size, "pending": self.queue.qsize(), "files": len(self.seen_sizes)})
        self.stop()

    def read_new(self, path: Path) -> None:
        try:
            text = path.read_text(encoding='utf-8', errors='replace')
            old = self.seen_sizes.get(path, 0)
            new = text[old:] if len(text) >= old else text
            self.seen_sizes[path] = len(text)
            self.buffer.add(path, new)
            if new: self.log.emit(f"Detected {len(new)} new chars in {path.name}")
        except PermissionError:
            now = time.time()
            if now >= self.read_retry_log_at.get(path, 0):
                self.log.emit(f"File is locked; retrying {path.name}")
                self.read_retry_log_at[path] = now + 5
            threading.Timer(0.75, lambda: None if self.stop_flag.is_set() else self.queue.put(path)).start()
        except Exception as e: self.error.emit(str(e))

    def process_one(self) -> None:
        chunk, consumed = self.buffer.pop_chunk()
        if not chunk.strip(): return
        source = ", ".join(p.name for p in consumed)
        if self.db.chunk_already_processed(chunk) or self.db.chunk_already_seen_in_recent_source(source, chunk):
            for path, n in consumed.items(): self.remove_prefix(path, n)
            self.log.emit(f"Skipped already-processed transcript chunk from {source}; removed duplicate text without calling Ollama.")
            return
        session = _load_groupmaker_session_for_sources(source)
        group_people = [str(name).strip() for name in session.get("names", []) if str(name).strip()]
        if not group_people:
            self.db.store_processed_chunk(source, chunk, [])
            for path, n in consumed.items(): self.remove_prefix(path, n)
            self.log.emit(f"Skipped memory extraction for {source}: no active GROUPMAKER participants to attach memories to.")
            self.refreshed.emit(); self.status.emit('Watching')
            return
        client = OllamaClient(self.settings.get('ollama_url'), self.settings.get('ollama_model'))
        extractor = MemoryExtractor(self.settings.float('confidence_threshold'))
        prompt = extractor.prompt(chunk, group_people); self.output.emit('Prompt Sent', prompt); self.status.emit('Processing')
        try:
            self.send_context_reminders(source, chunk, session)
            raw, parsed = client.generate(prompt); self.output.emit('Raw Ollama Response', raw); self.output.emit('Parsed JSON', json.dumps(parsed, indent=2))
            memories = extractor.validate(parsed, allowed_subjects=group_people)
            for rej in extractor.rejected: self.log.emit(rej)
            jobs = self.db.store_processed_chunk(source, chunk, memories)
            for job in jobs: self.cleanup_queue.put(job)
            for path, n in consumed.items(): self.remove_prefix(path, n)
            self.log.emit(f"Stored chunk from {source}; memories={len(memories)}; cleanup_jobs={len(jobs)}")
            self.refreshed.emit(); self.status.emit('Watching')
        except Exception as e:
            self.error.emit(f"Processing failed; transcript text retained for retry: {e}"); self.status.emit('Error')
            for path, n in consumed.items():
                self.seen_sizes[path] = max(0, self.seen_sizes.get(path, 0) - n)

    def send_context_reminders(self, source: str, chunk: str, session: Dict[str, Any] | None = None) -> None:
        if self.settings.get('context_reminders_enabled').strip().lower() in {"0", "false", "no", "off"}:
            self.log.emit("Context reminder skipped: disabled by settings.")
            return
        session = session or _load_groupmaker_session_for_sources(source)
        group_id = str(session.get("group_id", "")).strip()
        group_people = [str(name).strip() for name in session.get("names", []) if str(name).strip()]
        if not group_id or not group_people:
            self.log.emit("Context reminder skipped: transcript is not attached to an open GROUPMAKER group.")
            return

        reminders = self.db.context_reminders_for_transcript(chunk, group_people)
        if not reminders:
            self.log.emit(f"Context reminder check for GROUPMAKER group {group_id}: no matching in-group memories.")
            return

        sent = 0
        failed = 0
        direct_sent = 0
        direct_failed = 0
        now = time.time()
        participant_targets = [
            (str(name).strip() or str(ai_id).strip(), str(ai_id).strip())
            for name, ai_id in zip(session.get("names", []), session.get("ai_list", []))
            if str(ai_id).strip()
        ]
        reminders_sent_to_group: List[Dict[str, str]] = []
        if len(reminders) > MAX_CONTEXT_REMINDERS_PER_CHUNK:
            self.log.emit(
                f"Context reminders limited for GROUPMAKER group {group_id}: "
                f"sending {MAX_CONTEXT_REMINDERS_PER_CHUNK} of {len(reminders)} matches to prevent API floods."
            )
        for reminder in reminders[:MAX_CONTEXT_REMINDERS_PER_CHUNK]:
            cooldown_key = (group_id, str(reminder["description"]))
            if now - self.context_reminder_sent_at.get(cooldown_key, 0) < CONTEXT_REMINDER_COOLDOWN_SECONDS:
                self.log.emit(f"Context reminder throttled for GROUPMAKER group {group_id}: recently sent same reminder.")
                continue
            ok, status = _send_group_context_reminder(group_id, reminder["description"])
            label = f"{reminder['person']} / {reminder['keyword']}"
            if ok:
                sent += 1
                reminders_sent_to_group.append(reminder)
                self.context_reminder_sent_at[cooldown_key] = now
                self.log.emit(f"Sent context reminder to GROUPMAKER group {group_id}: {label} ({status})")
                if not participant_targets:
                    self.log.emit("Direct context reminder skipped: active GROUPMAKER session has no participant ai_id values.")
                for participant_name, ai_id in participant_targets:
                    direct_ok, direct_status = _send_direct_context_reminder(ai_id, reminder["description"])
                    if direct_ok:
                        direct_sent += 1
                        self.log.emit(
                            f"Sent direct context reminder to GROUPMAKER participant {participant_name} ({ai_id}) "
                            f"for {reminder['person']}: {direct_status}"
                        )
                    else:
                        direct_failed += 1
                        self.log.emit(
                            f"Direct context reminder failed for GROUPMAKER participant {participant_name} ({ai_id}) "
                            f"for {reminder['person']}: {direct_status}"
                        )
            else:
                failed += 1
                self.log.emit(f"Context reminder failed for GROUPMAKER group {group_id}: {label} ({status})")
        if reminders_sent_to_group:
            _record_latest_group_context_reminders(session, reminders_sent_to_group)
        self.log.emit(
            f"Context reminder pass complete for GROUPMAKER group {group_id}: "
            f"group_sent={sent}; group_failed={failed}; direct_sent={direct_sent}; direct_failed={direct_failed}."
        )

    def remove_prefix(self, path: Path, n: int) -> None:
        last_error: Optional[PermissionError] = None
        for _attempt in range(8):
            try:
                text = path.read_text(encoding='utf-8', errors='replace')
                path.write_text(text[n:].lstrip('\n'), encoding='utf-8')
                self.seen_sizes[path] = max(0, len(path.read_text(encoding='utf-8', errors='replace')))
                return
            except PermissionError as e:
                last_error = e
                time.sleep(0.5)
        if last_error is not None:
            raise last_error

    def clean_one(self) -> None:
        node_id, _pid, person, kw, new_event = self.cleanup_queue.get_nowait()
        row = self.db.node_detail(node_id)
        if not row: return
        prompt = MemoryCleaner.prompt(person, kw, row['active_summary'], new_event, row['raw_compilation'])
        self.output.emit('Cleanup Prompt', prompt)
        try:
            raw, parsed = OllamaClient(self.settings.get('ollama_url'), self.settings.get('ollama_model')).generate(prompt)
            self.output.emit('Cleanup Response', raw)
            summary = str(parsed.get('active_summary', '')).strip()
            if summary:
                self.db.update_node_summary(node_id, summary, cleaned=True); self.log.emit(f"Updated {person} / {kw}"); self.refreshed.emit()
        except Exception as e: self.error.emit(f"Cleanup failed for {person}/{kw}: {e}")


class MemoryExplorerDialog(QDialog):
    """Large, focused database explorer for reading and maintaining memory nodes."""

    def __init__(self, parent: "MainWindow") -> None:
        super().__init__(parent)
        self.parent_window = parent
        self.db = parent.db
        self.current_node: Optional[int] = None
        self.setWindowTitle("LIFELINE Memory Explorer")
        self.setMinimumSize(QSize(1220, 760))
        self.resize(1380, 860)
        self.build_ui()
        self.refresh()

    def build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 18, 18, 18)
        layout.setSpacing(12)

        hero = QFrame()
        hero.setObjectName("ExplorerHero")
        hero_layout = QHBoxLayout(hero)
        title_box = QVBoxLayout()
        title = QLabel("MEMORY EXPLORER")
        title.setObjectName("ExplorerTitle")
        subtitle = QLabel("Search, inspect, rewrite, reprocess, and delete LIFELINE database memory nodes in a full-size workspace.")
        subtitle.setObjectName("ExplorerSubtitle")
        subtitle.setWordWrap(True)
        title_box.addWidget(title)
        title_box.addWidget(subtitle)
        hero_layout.addLayout(title_box, 1)
        self.count_label = QLabel("0 nodes")
        self.count_label.setObjectName("ExplorerCount")
        self.count_label.setAlignment(Qt.AlignCenter)
        hero_layout.addWidget(self.count_label)
        layout.addWidget(hero)

        tools = QFrame()
        tools.setObjectName("ExplorerTools")
        tools_layout = QHBoxLayout(tools)
        tools_layout.addWidget(QLabel("Search"))
        self.search = QLineEdit()
        self.search.setPlaceholderText("Filter by person, keyword, active summary, or raw event text...")
        self.search.textChanged.connect(self.refresh)
        refresh = QPushButton("Refresh")
        refresh.clicked.connect(self.refresh)
        tools_layout.addWidget(self.search, 1)
        tools_layout.addWidget(refresh)
        layout.addWidget(tools)

        split = QSplitter(Qt.Horizontal)
        split.setObjectName("ExplorerSplitter")
        self.nodes = QTreeWidget()
        self.nodes.setHeaderLabels(["Person / Keyword", "Events", "Updated"])
        self.nodes.setAlternatingRowColors(True)
        self.nodes.itemSelectionChanged.connect(self.load_selected_node)
        split.addWidget(self.nodes)

        detail = QFrame()
        detail.setObjectName("ExplorerDetail")
        detail_layout = QVBoxLayout(detail)
        detail_layout.setContentsMargins(14, 14, 14, 14)
        identity = QFormLayout()
        self.person = QLineEdit()
        self.keyword = QLineEdit()
        self.revisions = QLabel("")
        self.cleaned = QLabel("")
        identity.addRow("Entity", self.person)
        identity.addRow("Keyword Signal", self.keyword)
        identity.addRow("Revision Count", self.revisions)
        identity.addRow("Last Cleaned", self.cleaned)
        detail_layout.addLayout(identity)
        detail_layout.addWidget(QLabel("Active Summary"))
        self.summary = QPlainTextEdit()
        self.summary.setPlaceholderText("Select a memory node to inspect or edit its active summary...")
        detail_layout.addWidget(self.summary, 3)
        detail_layout.addWidget(QLabel("Raw Related Events"))
        self.raw_events = QPlainTextEdit()
        self.raw_events.setReadOnly(True)
        detail_layout.addWidget(self.raw_events, 4)

        actions = QHBoxLayout()
        self.save = QPushButton("Save Summary")
        self.save.setObjectName("PrimaryButton")
        self.save.clicked.connect(self.save_summary)
        self.reclean = QPushButton("Reprocess with Ollama")
        self.reclean.clicked.connect(self.reclean_node)
        self.delete_event = QPushButton("Delete Latest Event")
        self.delete_event.clicked.connect(self.delete_latest_event)
        self.delete_node_btn = QPushButton("Delete Node")
        self.delete_node_btn.setObjectName("DangerButton")
        self.delete_node_btn.clicked.connect(self.delete_node)
        for button in (self.save, self.reclean, self.delete_event, self.delete_node_btn):
            actions.addWidget(button)
        detail_layout.addLayout(actions)
        split.addWidget(detail)
        split.setSizes([430, 920])
        layout.addWidget(split, 1)

    def refresh(self) -> None:
        selected = self.current_node
        self.nodes.clear()
        people: Dict[str, QTreeWidgetItem] = {}
        rows = self.db.explorer_nodes(self.search.text())
        for row in rows:
            person_item = people.get(row["person"])
            if person_item is None:
                person_item = QTreeWidgetItem([row["person"], "", ""])
                person_item.setFirstColumnSpanned(True)
                people[row["person"]] = person_item
                self.nodes.addTopLevelItem(person_item)
            child = QTreeWidgetItem([row["keyword"], str(row["event_count"]), row["updated_at"] or ""])
            child.setToolTip(0, row["active_summary"] or "")
            child.setData(0, Qt.UserRole, int(row["id"]))
            person_item.addChild(child)
            if selected and int(row["id"]) == selected:
                self.nodes.setCurrentItem(child)
        for item in people.values():
            item.setExpanded(True)
        self.nodes.resizeColumnToContents(0)
        self.count_label.setText(f"{len(rows)} nodes")

    def load_selected_node(self) -> None:
        items = self.nodes.selectedItems()
        if not items:
            return
        node_id = items[0].data(0, Qt.UserRole)
        if not node_id:
            return
        row = self.db.node_detail(int(node_id))
        if not row:
            return
        self.current_node = int(node_id)
        self.person.setText(row["person"])
        self.keyword.setText(row["keyword"])
        self.summary.setPlainText(row["active_summary"])
        self.revisions.setText(str(row["revision_count"]))
        self.cleaned.setText(row["last_cleaned_at"] or "Never")
        self.raw_events.setPlainText(row["raw_compilation"] or "")

    def save_summary(self) -> None:
        if self.current_node is None:
            return
        self.db.update_node_summary(self.current_node, self.summary.toPlainText())
        self.parent_window.append_log("Memory Explorer saved active summary")
        self.parent_window.refresh_all()
        self.refresh()

    def reclean_node(self) -> None:
        if self.current_node is None:
            return
        self.parent_window.current_node = self.current_node
        self.parent_window.reclean_node()
        self.refresh()
        self.load_selected_node()

    def delete_latest_event(self) -> None:
        if self.current_node is None:
            return
        if QMessageBox.question(self, "Delete", "Delete the latest raw memory event linked to this node?") != QMessageBox.Yes:
            return
        self.db.delete_latest_event_for_node(self.current_node)
        self.parent_window.append_log("Memory Explorer deleted latest memory event for node")
        self.parent_window.refresh_all()
        self.refresh()
        self.load_selected_node()

    def delete_node(self) -> None:
        if self.current_node is None:
            return
        if QMessageBox.question(self, "Delete", "Delete selected keyword node?") != QMessageBox.Yes:
            return
        self.db.delete_node(self.current_node)
        self.current_node = None
        self.person.clear()
        self.keyword.clear()
        self.summary.clear()
        self.raw_events.clear()
        self.revisions.clear()
        self.cleaned.clear()
        self.parent_window.append_log("Memory Explorer deleted keyword node")
        self.parent_window.refresh_all()
        self.refresh()


class MainWindow(QMainWindow):
    start_signal = Signal(str); stop_signal = Signal()
    def __init__(self) -> None:
        super().__init__(); self.db = MemoryDB(); self.settings = AppSettings(self.db); self.worker_thread: Optional[QThread] = None; self.worker: Optional[ProcessingWorker] = None; self.last_error = ''; self.force_quit = False; self.tray_icon: Optional[QSystemTrayIcon] = None
        self.setWindowTitle('LIFELINE CORE — Memory Intelligence Network'); self.resize(1480, 900); self.build_ui(); self.setup_tray(); self.load_settings(); self.restore_geometry(); self.refresh_tree(); self.refresh_stats(); QTimer.singleShot(250, self.check_ollama)

    def build_ui(self) -> None:
        self.apply_core_style()
        root = QWidget(); root.setObjectName('CoreRoot'); layout = QVBoxLayout(root); layout.setContentsMargins(14, 14, 14, 14); layout.setSpacing(12)

        header = QFrame(); header.setObjectName('HeroPanel'); header_layout = QHBoxLayout(header); header_layout.setContentsMargins(18, 14, 18, 14)
        title_box = QVBoxLayout(); title = QLabel('LIFELINE CORE'); title.setObjectName('CoreTitle'); subtitle = QLabel('Memory Intelligence Network'); subtitle.setObjectName('CoreSubtitle')
        title_box.addWidget(title); title_box.addWidget(subtitle); header_layout.addLayout(title_box, 1)
        self.status_label = QLabel('Idle'); self.status_label.setObjectName('StatusPill'); self.status_label.setAlignment(Qt.AlignCenter)
        header_layout.addWidget(QLabel('CORE STATUS')); header_layout.addWidget(self.status_label)
        layout.addWidget(header)

        config = QFrame(); config.setObjectName('ConfigPanel'); top = QGridLayout(config); top.setContentsMargins(14, 12, 14, 12); top.setHorizontalSpacing(10); top.setVerticalSpacing(8); layout.addWidget(config)
        self.folder = QLineEdit(); browse = QPushButton('Acquire Folder'); browse.clicked.connect(self.browse)
        self.url = QLineEdit(); self.model = QLineEdit(); check = QPushButton('Ping Ollama Core'); check.clicked.connect(self.check_ollama); selftest = QPushButton('Verify Memory Mirror'); selftest.clicked.connect(self.test_memory_backup_restore)
        start = QPushButton('Activate Watch'); start.setObjectName('PrimaryButton'); start.clicked.connect(self.start_watch); stop = QPushButton('Suspend'); stop.clicked.connect(self.stop_watch)
        widgets = [('Transcript Intake', self.folder), ('Ollama Endpoint', self.url), ('Inference Model', self.model)]
        for i,(lab,w) in enumerate(widgets): top.addWidget(QLabel(lab),0,i*2); top.addWidget(w,0,i*2+1)
        top.addWidget(browse,0,6); top.addWidget(check,1,0); top.addWidget(selftest,1,5); top.addWidget(start,1,1); top.addWidget(stop,1,2)
        self.chunk = QSpinBox(); self.chunk.setRange(500,100000); self.min_idle = QSpinBox(); self.min_idle.setRange(100,100000); self.max_chunk = QSpinBox(); self.max_chunk.setRange(500,200000); self.idle = QSpinBox(); self.idle.setRange(5,3600); self.conf = QDoubleSpinBox(); self.conf.setRange(0,1); self.conf.setSingleStep(.05)
        for i,(lab,w) in enumerate([('Target Signal Size',self.chunk),('Minimum Buffer',self.min_idle),('Maximum Signal Size',self.max_chunk),('Idle Gate Seconds',self.idle),('Confidence Gate',self.conf)]): top.addWidget(QLabel(lab),2,i*2); top.addWidget(w,2,i*2+1)

        split = QSplitter(Qt.Horizontal); split.setObjectName('CoreSplitter'); layout.addWidget(split, 1)
        left = self.core_panel('CORE STATUS', 'Realtime scan state and ingestion pulse.')
        ll = left.layout(); self.monitor = QLabel('Watched folder:\nFiles detected: 0\nBuffered characters: 0\nPending chunks: 0\nLast processed file:\nLast processed time:'); self.monitor.setObjectName('TelemetryBlock')
        self.log = QPlainTextEdit(); self.log.setReadOnly(True); self.log.setObjectName('ActivityFeed')
        ll.addWidget(self.monitor); ll.addWidget(QLabel('REALTIME INTELLIGENCE FEED')); ll.addWidget(self.log,1); split.addWidget(left)

        center = self.core_panel('OLLAMA / PROCESSING TELEMETRY', 'Prompt streams, model responses, parsed signals, and cleanup traces.')
        cl = center.layout(); self.tabs = QTabWidget(); self.tab_edits = {}
        for name in ['Prompt Sent','Raw Ollama Response','Parsed JSON','Cleanup Prompt','Cleanup Response']:
            e=QPlainTextEdit(); e.setReadOnly(True); e.setObjectName('TelemetryConsole'); self.tabs.addTab(e,name); self.tab_edits[name]=e
        cl.addWidget(self.tabs); split.addWidget(center)

        right = self.core_panel('MEMORY NETWORK', 'People, keyword nodes, and active signal inspection.')
        rl = right.layout(); explorer_button = QPushButton('Open Full Memory Explorer'); explorer_button.setObjectName('PrimaryButton'); explorer_button.clicked.connect(self.open_memory_explorer)
        self.treew = QTreeWidget(); self.treew.setHeaderLabels(['Memory Graph / Signal Nodes']); self.treew.itemSelectionChanged.connect(self.load_node)
        self.person = QLineEdit(); self.keyword = QLineEdit(); self.summary = QPlainTextEdit(); self.rev = QLabel(''); self.cleaned = QLabel(''); self.raw_events = QPlainTextEdit(); self.raw_events.setReadOnly(True)
        save=QPushButton('Commit Active Summary'); save.clicked.connect(self.save_summary); reclean=QPushButton('Reprocess with Ollama'); reclean.clicked.connect(self.reclean_node); del_event=QPushButton('Delete Latest Memory Event'); del_event.clicked.connect(self.delete_latest_event); delete=QPushButton('Delete Keyword Node'); delete.clicked.connect(self.delete_node); clear_all=QPushButton('PURGE MEMORY CORE'); clear_all.setObjectName('DangerButton'); clear_all.clicked.connect(self.clear_all_memory)
        rl.addWidget(explorer_button); rl.addWidget(self.treew,1); rl.addWidget(QLabel('ACTIVE SIGNAL INSPECTOR')); form=QFormLayout(); form.addRow('Entity',self.person); form.addRow('Keyword Signal',self.keyword); form.addRow('Revision Count',self.rev); form.addRow('Last Cleaned',self.cleaned); rl.addLayout(form); rl.addWidget(QLabel('Active Summary')); rl.addWidget(self.summary); rl.addWidget(QLabel('Raw Related Events')); rl.addWidget(self.raw_events); rl.addWidget(save); rl.addWidget(reclean); rl.addWidget(del_event); rl.addWidget(delete); rl.addWidget(clear_all); split.addWidget(right)
        split.setSizes([360, 560, 460])

        health = QFrame(); health.setObjectName('HealthPanel'); health_layout = QVBoxLayout(health); health_layout.setContentsMargins(14, 10, 14, 10)
        health_layout.addWidget(QLabel('SYSTEM HEALTH'))
        self.db_status = QLabel(); self.db_status.setWordWrap(True); self.stats = QLabel(); self.stats.setWordWrap(True)
        health_layout.addWidget(self.db_status); health_layout.addWidget(self.stats); layout.addWidget(health)
        self.setCentralWidget(root); self.setStatusBar(QStatusBar())

    def core_panel(self, heading: str, caption: str) -> QFrame:
        panel = QFrame(); panel.setObjectName('CorePanel'); panel_layout = QVBoxLayout(panel); panel_layout.setContentsMargins(12, 12, 12, 12); panel_layout.setSpacing(8)
        label = QLabel(heading); label.setObjectName('PanelHeading'); panel_layout.addWidget(label)
        sub = QLabel(caption); sub.setObjectName('PanelCaption'); sub.setWordWrap(True); panel_layout.addWidget(sub)
        return panel

    def apply_core_style(self) -> None:
        QApplication.instance().setFont(QFont('Segoe UI', 10))
        self.setStyleSheet("""
            QWidget#CoreRoot { background: #050914; color: #d9f7ff; }
            QFrame#HeroPanel, QFrame#ConfigPanel, QFrame#CorePanel, QFrame#HealthPanel { background: rgba(9, 19, 38, 235); border: 1px solid #17445c; border-radius: 14px; }
            QDialog { background: #050914; color: #d9f7ff; }
            QFrame#ExplorerHero, QFrame#ExplorerTools, QFrame#ExplorerDetail { background: rgba(9, 19, 38, 245); border: 1px solid #17445c; border-radius: 14px; }
            QLabel#ExplorerTitle { color: #7df9ff; font-size: 26px; font-weight: 900; letter-spacing: 3px; }
            QLabel#ExplorerSubtitle { color: #8fb7c8; }
            QLabel#ExplorerCount { color: #06131c; background: #30f2c6; border-radius: 14px; padding: 8px 18px; font-weight: 900; min-width: 110px; }
            QLabel#CoreTitle { color: #7df9ff; font-size: 30px; font-weight: 900; letter-spacing: 4px; }
            QLabel#CoreSubtitle, QLabel#PanelCaption { color: #8fb7c8; }
            QLabel#PanelHeading { color: #26f0ff; font-weight: 800; letter-spacing: 2px; }
            QLabel#StatusPill { color: #06131c; background: #30f2c6; border-radius: 14px; padding: 8px 18px; font-weight: 900; min-width: 150px; }
            QLabel { color: #c9ecf4; font-weight: 650; }
            QLineEdit, QSpinBox, QDoubleSpinBox, QPlainTextEdit, QTreeWidget { background: #07111f; color: #e8fbff; border: 1px solid #1c526d; border-radius: 8px; padding: 6px; selection-background-color: #1f8fb3; }
            QPlainTextEdit#ActivityFeed { color: #8dffcf; font-family: Consolas, 'Cascadia Mono', monospace; }
            QPlainTextEdit#TelemetryConsole { color: #b7e8ff; font-family: Consolas, 'Cascadia Mono', monospace; }
            QLabel#TelemetryBlock { color: #e6fbff; background: #081827; border: 1px solid #1d6a83; border-radius: 10px; padding: 10px; }
            QPushButton { background: #0c2539; color: #d9fbff; border: 1px solid #247798; border-radius: 8px; padding: 8px 10px; font-weight: 800; }
            QPushButton:hover { background: #123c57; border-color: #41dfff; }
            QPushButton#PrimaryButton { background: #0b5b63; border-color: #30f2c6; color: white; }
            QPushButton#DangerButton { background: #641120; border-color: #ff4d6d; color: white; font-weight: 900; }
            QTabWidget::pane { border: 1px solid #1c526d; border-radius: 8px; }
            QTabBar::tab { background: #081827; color: #9fcdda; padding: 8px 10px; border: 1px solid #17445c; border-top-left-radius: 8px; border-top-right-radius: 8px; }
            QTabBar::tab:selected { background: #0f344d; color: #7df9ff; }
            QHeaderView::section { background: #0f344d; color: #7df9ff; padding: 6px; border: 0; }
        """)

    def setup_tray(self) -> None:
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return
        icon = QIcon.fromTheme("utilities-system-monitor")
        if icon.isNull():
            icon = self.style().standardIcon(QStyle.StandardPixmap.SP_ComputerIcon)
        self.setWindowIcon(icon)
        self.tray_icon = QSystemTrayIcon(icon, self)
        self.tray_icon.setToolTip("LIFELINE CORE — Memory Intelligence Network")
        menu = QMenu(self)
        show_action = QAction("Show LIFELINE CORE", self)
        show_action.triggered.connect(self.show_from_tray)
        hide_action = QAction("Minimize to Tray", self)
        hide_action.triggered.connect(self.hide_to_tray)
        quit_action = QAction("Quit", self)
        quit_action.triggered.connect(self.quit_from_tray)
        menu.addAction(show_action)
        menu.addAction(hide_action)
        menu.addSeparator()
        menu.addAction(quit_action)
        self.tray_icon.setContextMenu(menu)
        self.tray_icon.activated.connect(self.on_tray_activated)
        self.tray_icon.show()

    def show_from_tray(self) -> None:
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def hide_to_tray(self) -> None:
        self.hide()
        if self.tray_icon:
            self.tray_icon.showMessage("LIFELINE CORE", "Memory intelligence network is still active in the system tray.", QSystemTrayIcon.MessageIcon.Information, 2500)

    def quit_from_tray(self) -> None:
        self.force_quit = True
        self.close()

    def on_tray_activated(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason in (QSystemTrayIcon.ActivationReason.Trigger, QSystemTrayIcon.ActivationReason.DoubleClick):
            if self.isVisible():
                self.hide_to_tray()
            else:
                self.show_from_tray()

    def load_settings(self) -> None:
        transcript_folder = self.settings.get('transcript_folder')
        Path(transcript_folder).mkdir(parents=True, exist_ok=True)
        self.folder.setText(transcript_folder); self.url.setText(self.settings.get('ollama_url')); self.model.setText(self.settings.get('ollama_model'))
        self.chunk.setValue(self.settings.int('chunk_size')); self.min_idle.setValue(self.settings.int('minimum_idle_chunk_size')); self.max_chunk.setValue(self.settings.int('maximum_chunk_size')); self.idle.setValue(self.settings.int('idle_timeout')); self.conf.setValue(self.settings.float('confidence_threshold'))

    def save_settings(self) -> None:
        for k,w in [('transcript_folder',self.folder),('ollama_url',self.url),('ollama_model',self.model)]: self.settings.set(k,w.text())
        for k,w in [('chunk_size',self.chunk),('minimum_idle_chunk_size',self.min_idle),('maximum_chunk_size',self.max_chunk),('idle_timeout',self.idle)]: self.settings.set(k,w.value())
        self.settings.set('confidence_threshold', self.conf.value())

    def restore_geometry(self) -> None:
        data = self.settings.get('window_geometry')
        if data:
            try:
                self.restoreGeometry(base64.b64decode(data))
            except Exception:
                pass

    def browse(self) -> None:
        d = QFileDialog.getExistingDirectory(self, 'Select transcript folder', self.folder.text() or str(Path.home()))
        if d: self.folder.setText(d); self.save_settings()

    def check_ollama(self) -> None:
        self.save_settings(); ok,msg = OllamaClient(self.url.text(), self.model.text()).check(); self.append_log(msg); self.status_label.setText(msg if not ok else 'Idle')

    def start_watch(self) -> None:
        folder = self.folder.text().strip() or default_transcript_folder()
        Path(folder).mkdir(parents=True, exist_ok=True)
        self.folder.setText(folder)
        self.save_settings();
        if self.worker_thread: return
        self.worker_thread = QThread(); self.worker = ProcessingWorker(self.db, self.settings); self.worker.moveToThread(self.worker_thread)
        self.start_signal.connect(self.worker.start); self.stop_signal.connect(self.worker.stop); self.worker.log.connect(self.append_log); self.worker.status.connect(self.status_label.setText); self.worker.monitor.connect(self.update_monitor); self.worker.output.connect(self.set_output); self.worker.refreshed.connect(self.refresh_all); self.worker.error.connect(self.show_error)
        self.worker_thread.start(); self.start_signal.emit(self.folder.text());

    def stop_watch(self) -> None:
        if self.worker: self.worker.stop()
        if self.worker_thread: self.worker_thread.quit(); self.worker_thread.wait(4000); self.worker_thread=None; self.worker=None

    def append_log(self, msg: str) -> None:
        self.log.appendPlainText(f"[{_dt.datetime.now().strftime('%H:%M:%S')}] CORE EVENT :: {msg}")

    def update_monitor(self, d: dict) -> None:
        self.monitor.setText(f"Intake vector: {self.folder.text()}\nDetected source files: {d.get('files',0)}\nBuffered signal characters: {d.get('buffered',0)}\nPending memory chunks: {d.get('pending',0)}\nLatest action: see intelligence feed\nTelemetry refresh: {_dt.datetime.now().strftime('%H:%M:%S')}")

    def set_output(self, tab: str, text: str) -> None:
        self.tab_edits[tab].setPlainText(text)

    def open_memory_explorer(self) -> None:
        dialog = MemoryExplorerDialog(self)
        dialog.exec()
        self.refresh_all()

    def show_error(self, msg: str) -> None:
        self.last_error = msg; self.append_log('ERROR: '+msg); self.status_label.setText('Error'); self.refresh_stats()

    def refresh_all(self) -> None: self.refresh_tree(); self.refresh_stats()

    def refresh_tree(self) -> None:
        self.treew.clear(); root = QTreeWidgetItem(['People']); self.treew.addTopLevelItem(root); people = {}
        for r in self.db.tree():
            p = people.setdefault(r['name'], QTreeWidgetItem([r['name']]))
            if p.parent() is None: root.addChild(p)
            if r['keyword']:
                item = QTreeWidgetItem([r['keyword']]); item.setData(0, Qt.UserRole, r['id']); p.addChild(item)
        root.setExpanded(True)

    def refresh_stats(self) -> None:
        s = self.db.stats()
        self.db_status.setText(
            f"Active DB: {self.db.path}\n"
            f"Backup root: {self.db.memory_backup_root}\n"
            f"Last DB write: {self.db.last_write}\n"
            f"Last external mirror: {self.db.last_external_mirror}\n"
            f"Memory row count: {self.db._database_score(self.db.path)}\n"
            f"Backup row count: {self.db.backup_score()}\n"
            f"Restore source used on launch: {self.db.restore_source}"
        )
        self.stats.setText(f"Entities: {s['people']} | Memory events: {s['events']} | Keyword nodes: {s['nodes']} | Processed chunks: {s['chunks']} | Waiting chunks: {s['waiting']} | Ollama telemetry: {self.status_label.text()} | Last anomaly: {self.last_error or 'None'}")

    def test_memory_backup_restore(self) -> None:
        marker = f"LIFELINE_BACKUP_SELF_TEST_{time.time_ns()}"
        try:
            self.db.store_processed_chunk("self-test", marker, [{"subjects": ["SELF TEST"], "description": marker, "memory_type": "status", "event_time": now_iso(), "confidence": 1.0, "keywords": ["backup self test"]}])
            with sqlite3.connect(f"file:{self.db.latest_mirror_path}?mode=ro", uri=True, timeout=30) as conn:
                found = conn.execute("SELECT COUNT(*) FROM memory_events WHERE description=?", (marker,)).fetchone()[0]
            if found:
                QMessageBox.information(self, "Memory Backup / Restore Test", "PASS: test memory was committed and found in the external mirror.")
                self.append_log("Memory backup/restore self-test PASS")
            else:
                QMessageBox.critical(self, "Memory Backup / Restore Test", "FAIL: test memory was not found in the external mirror.")
                self.append_log("Memory backup/restore self-test FAIL: mirror missing row")
        except Exception as exc:
            QMessageBox.critical(self, "Memory Backup / Restore Test", f"FAIL: {exc}")
            self.append_log(f"Memory backup/restore self-test FAIL: {exc}")
        self.refresh_all()

    def load_node(self) -> None:
        items = self.treew.selectedItems();
        if not items: return
        node_id = items[0].data(0, Qt.UserRole)
        if not node_id: return
        row = self.db.node_detail(int(node_id));
        if not row: return
        self.current_node = int(node_id); self.person.setText(row['person']); self.keyword.setText(row['keyword']); self.summary.setPlainText(row['active_summary']); self.rev.setText(str(row['revision_count'])); self.cleaned.setText(row['last_cleaned_at'] or ''); self.raw_events.setPlainText(row['raw_compilation'] or '')

    def save_summary(self) -> None:
        if hasattr(self, 'current_node'): self.db.update_node_summary(self.current_node, self.summary.toPlainText()); self.refresh_all(); self.append_log('Saved active summary')

    def reclean_node(self) -> None:
        if not hasattr(self, 'current_node'):
            return
        row = self.db.node_detail(self.current_node)
        if not row:
            return
        prompt = MemoryCleaner.prompt(row['person'], row['keyword'], row['active_summary'], 'Manual reclean requested.', row['raw_compilation'] or '')
        self.set_output('Cleanup Prompt', prompt)
        try:
            raw, parsed = OllamaClient(self.url.text(), self.model.text()).generate(prompt)
            self.set_output('Cleanup Response', raw)
            summary = str(parsed.get('active_summary', '')).strip()
            if summary:
                self.db.update_node_summary(self.current_node, summary, cleaned=True); self.refresh_all(); self.append_log('Recleaned selected keyword node')
        except Exception as e:
            self.show_error(f'Manual reclean failed: {e}')

    def delete_latest_event(self) -> None:
        if hasattr(self, 'current_node') and QMessageBox.question(self,'Delete','Delete the latest raw memory event linked to this node?') == QMessageBox.Yes:
            self.db.delete_latest_event_for_node(self.current_node); self.refresh_all(); self.append_log('Deleted latest memory event for node')

    def delete_node(self) -> None:
        if hasattr(self, 'current_node') and QMessageBox.question(self,'Delete','Delete selected keyword node?') == QMessageBox.Yes:
            self.db.delete_node(self.current_node); self.refresh_all(); self.append_log('Deleted keyword node')

    def clear_all_memory(self) -> None:
        if QMessageBox.question(
            self,
            'Clear All Memory',
            'This will delete ALL LIFELINE memory people, events, keyword nodes, and processed transcript history. A backup snapshot will be created first. Continue?',
        ) != QMessageBox.Yes:
            return
        try:
            self.stop_watch()
            deleted, snapshot = self.db.clear_all_memory()
            if hasattr(self, 'current_node'):
                delattr(self, 'current_node')
            self.person.clear(); self.keyword.clear(); self.summary.clear(); self.raw_events.clear(); self.rev.clear(); self.cleaned.clear()
            self.refresh_all()
            self.append_log(f'Cleared all memory rows ({deleted} rows deleted). Backup snapshot: {snapshot}')
            QMessageBox.information(self, 'Clear All Memory', f'Deleted {deleted} memory rows. Backup snapshot created before deletion:\n{snapshot}')
        except Exception as exc:
            self.show_error(f'Clear all memory failed: {exc}')
            QMessageBox.critical(self, 'Clear All Memory', f'Failed: {exc}')

    def closeEvent(self, event) -> None:
        self.save_settings(); self.settings.set('window_geometry', base64.b64encode(bytes(self.saveGeometry())).decode('ascii'))
        if self.tray_icon and not self.force_quit:
            event.ignore()
            self.hide_to_tray()
            return
        self.stop_watch(); super().closeEvent(event)


def main() -> int:
    args = parse_args(sys.argv[1:])
    global RUNTIME_DB_PATH, RUNTIME_BACKUP_ROOT
    RUNTIME_DB_PATH = Path(args.db_path).expanduser().resolve() if args.db_path else DB_PATH
    RUNTIME_BACKUP_ROOT = Path(args.backup_root).expanduser().resolve() if args.backup_root else DEFAULT_BACKUP_ROOT
    app = QApplication(sys.argv); app.setApplicationName('LIFELINE Memory Manager')
    app.setQuitOnLastWindowClosed(False)
    main_script = Path(args.main_script).resolve() if args.main_script else Path(__file__).with_name("main.py").resolve()
    main_pid = args.main_pid
    if not _main_process_is_running(main_pid, main_script):
        message = "LIFELINE Memory Manager can only run while main.py is open."
        if not args.auto_start:
            QMessageBox.warning(None, "Open KINDROIDXL first", message)
        else:
            print(f"[INFO] {message}")
        return 0

    global _INSTANCE_GUARD
    instance_guard = QSharedMemory("LIFELINE_MEMORY_MANAGER_SINGLE_INSTANCE_GUARD")
    if not instance_guard.create(1):
        if instance_guard.error() == QSharedMemory.SharedMemoryError.AlreadyExists:
            message = "Another LIFELINE Memory Manager instance is already running."
            if not args.auto_start:
                QMessageBox.information(None, "LIFELINE Memory Manager already running", message)
            else:
                print(f"[INFO] {message}")
            return 0
        print(f"[WARN] LIFELINE Memory Manager single-instance guard unavailable: {instance_guard.errorString()}")
    _INSTANCE_GUARD = instance_guard

    w = MainWindow()
    main_monitor = MainProcessMonitor(app, main_pid, main_script)
    main_monitor.start()
    app._lifeline_main_monitor = main_monitor
    if args.auto_start:
        QTimer.singleShot(500, w.start_watch)
        if w.tray_icon:
            QTimer.singleShot(800, w.hide_to_tray)
        else:
            w.showMinimized()
    else:
        w.show()
    return app.exec()


if __name__ == '__main__':
    raise SystemExit(main())
