import datetime as dt
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from lifeline_memory_manager import (
    MEMORY_HELPER_ACTIVITY_WINDOW_SECONDS,
    GitHubBridge,
    MainWindow,
    MemoryDB,
    ProcessingWorker,
    SituationRecapComposer,
    _participant_ai_map,
    _decode_bridge_config,
    open_minimized_to_tray,
)


class BridgeBackupTests(unittest.TestCase):
    @patch.object(GitHubBridge, "read_bytes")
    @patch.object(GitHubBridge, "write_bytes", return_value="ab1891c9f4b427ab75fb1123c6dc24e211ca4885")
    def test_bridge_upload_uses_accepted_blob_sha_without_stale_readback(self, write_bytes, read_bytes) -> None:
        bridge = GitHubBridge("token")
        bridge.write_and_verify_bytes("memory/latest.db", b"database", "backup")
        write_bytes.assert_called_once_with("memory/latest.db", b"database", "backup")
        read_bytes.assert_not_called()

    @patch.object(GitHubBridge, "read_bytes", return_value=(b"database", "sha"))
    @patch.object(GitHubBridge, "write_bytes")
    def test_bridge_upload_is_read_back_and_verified(self, write_bytes, read_bytes) -> None:
        bridge = GitHubBridge("token")
        bridge.write_and_verify_bytes("memory/latest.db", b"database", "backup")
        write_bytes.assert_called_once_with("memory/latest.db", b"database", "backup")
        read_bytes.assert_called_once_with("memory/latest.db")

    @patch.object(GitHubBridge, "read_bytes", return_value=(b"corrupt", "sha"))
    @patch.object(GitHubBridge, "write_bytes")
    def test_bridge_upload_rejects_mismatched_readback(self, _write_bytes, _read_bytes) -> None:
        bridge = GitHubBridge("token")
        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            bridge.write_and_verify_bytes("memory/latest.db", b"database", "backup")

    def test_checked_backup_records_missing_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {}, clear=True):
            root = Path(directory)
            db = MemoryDB(root / "memory.db", root / "backups")
            db.bridge = GitHubBridge("")
            ok, detail = db.checked_bridge_backup()
            self.assertFalse(ok)
            self.assertIn("token", detail)
            self.assertNotEqual(db.last_bridge_check, "never")

    def test_worker_backup_failure_is_logged_without_worker_error(self) -> None:
        worker = ProcessingWorker.__new__(ProcessingWorker)
        worker.db = Mock()
        worker.db.checked_bridge_backup.return_value = (False, "write access denied")
        worker.log = Mock()
        worker.error = Mock()

        worker.backup_bridge_database()

        worker.log.emit.assert_called_once()
        self.assertIn("monitoring continues", worker.log.emit.call_args.args[0])
        worker.error.emit.assert_not_called()


class WorkerTestCase(unittest.TestCase):
    def make_worker(self) -> ProcessingWorker:
        worker = ProcessingWorker.__new__(ProcessingWorker)
        worker.settings = Mock()
        worker.settings.get.return_value = "1"
        worker.log = Mock()
        worker.helper_delivery = Mock()
        worker.output = Mock()
        worker.db = Mock()
        worker.memory_helper_sent_at = {}
        return worker


class MemoryHelperActivityTests(WorkerTestCase):
    def test_stale_transcript_does_not_check_or_send_helpers(self) -> None:
        worker = self.make_worker()
        worker.send_memory_helpers(
            "transcripts/group/transcript.json", "old transcript",
            {"group_id": "group", "names": ["Kin"], "ai_list": []},
            last_incoming_at=time.time() - MEMORY_HELPER_ACTIVITY_WINDOW_SECONDS - 1,
        )
        worker.db.memory_helpers_for_transcript.assert_not_called()
        self.assertIn("no incoming transcript activity", worker.log.emit.call_args.args[0])

    def test_recent_transcript_reaches_helper_matching(self) -> None:
        worker = self.make_worker()
        worker.db.memory_helpers_for_transcript.return_value = []
        worker.send_memory_helpers(
            "transcripts/group/transcript.json", "recent transcript",
            {"group_id": "group", "names": ["Kin"], "ai_list": []},
            last_incoming_at=time.time(),
        )
        worker.db.memory_helpers_for_transcript.assert_called_once_with("recent transcript", ["Kin"])

    @patch("lifeline_memory_manager._send_direct_message", return_value=(True, "ok"))
    @patch("lifeline_memory_manager._send_group_message", return_value=(True, "ok"))
    def test_helper_is_sent_directly_only_to_its_target_person(self, group_send, direct_send) -> None:
        worker = self.make_worker()
        worker.db.memory_helpers_for_transcript.return_value = [{
            "person": "KIN", "keyword": "launch", "description": "Kin launched it.",
        }]
        worker.send_memory_helpers(
            "transcripts/group/transcript.json", "launch",
            {"group_id": "group", "names": ["Kin", "Nova"], "ai_list": ["ai-kin", "ai-nova"]},
            last_incoming_at=time.time(),
        )

        group_send.assert_called_once_with("group", "MEMORY HELPER", "Kin launched it.")
        direct_send.assert_called_once_with("ai-kin", "MEMORY HELPER", "Kin launched it.")
        audit_lines = [call.args[0] for call in worker.helper_delivery.emit.call_args_list]
        self.assertTrue(any("GROUP SENT" in line and "TRIGGER='launch'" in line for line in audit_lines))
        self.assertTrue(any(
            "DIRECT SENT" in line and "TARGET=KIN" in line and "AI_ID=ai-kin" in line
            for line in audit_lines
        ))

    def test_directory_mapping_fills_missing_group_participant_ids(self) -> None:
        config = {
            "directory_entries": [
                {"name": "Kin", "ai_id": "directory-kin"},
                {"name": "Nova", "ai_id": "directory-nova"},
            ],
            "groupmaker_sessions": [{
                "group_id": "group", "names": ["Kin"], "ai_list": ["session-kin"],
            }],
        }

        mapping = _participant_ai_map(config, "group")

        self.assertEqual(mapping["kin"], "session-kin")
        self.assertEqual(mapping["nova"], "directory-nova")

    def test_family_map_and_legacy_bridge_data_recover_ids(self) -> None:
        legacy = _decode_bridge_config(b'[{"name":"Kin","ai_id":"legacy-kin"}]')
        family_only = {
            "generations_people": [{"name": "Nova", "directory_ai_id": "family-nova"}],
        }

        self.assertEqual(_participant_ai_map(legacy, "group")["kin"], "legacy-kin")
        self.assertEqual(_participant_ai_map(family_only, "group")["nova"], "family-nova")


class SituationRecapTests(WorkerTestCase):
    def test_hourly_throttle_prevents_llm_call(self) -> None:
        worker = self.make_worker()
        worker.db.situation_recap_due.return_value = False
        client = Mock()
        worker.send_situation_recap(
            "transcripts/group/transcript.json",
            {"group_id": "group", "names": ["Kin"], "ai_list": ["ai-1"]}, client,
        )
        client.generate.assert_not_called()
        worker.db.updated_keyword_memories.assert_not_called()

    @patch("lifeline_memory_manager._send_direct_message", return_value=(True, "ok"))
    @patch("lifeline_memory_manager._send_group_message", return_value=(True, "ok"))
    def test_recap_is_separate_llm_call_and_sent_to_group_and_people(self, group_send, direct_send) -> None:
        worker = self.make_worker()
        worker.db.situation_recap_due.return_value = True
        worker.db.updated_keyword_memories.return_value = [{
            "person": "KIN", "keyword": "launch", "active_summary": "Kin launched it.",
            "updated_at": "2026-07-28T10:00:00",
        }]
        client = Mock()
        client.generate.return_value = ('{"recap":"Kin launched it."}', {"recap": "Kin launched it."})
        session = {"group_id": "group", "names": ["Kin", "Nova"], "ai_list": ["ai-1", "ai-2"]}

        worker.send_situation_recap("transcripts/group/transcript.json", session, client)

        client.generate.assert_called_once()
        self.assertIn("separate recap task", client.generate.call_args.args[0])
        group_send.assert_called_once_with("group", "SITUATION RECAP", "Kin launched it.")
        self.assertEqual(direct_send.call_count, 2)
        worker.db.record_situation_recap.assert_called_once_with(
            "group", ["Kin", "Nova"], "Kin launched it.",
            "transcripts/group/transcript.json", True, 2,
        )

    def test_prompt_rejects_invention_and_database_language(self) -> None:
        prompt = SituationRecapComposer.prompt([{
            "person": "KIN", "keyword": "plan", "active_summary": "Kin planned a trip.",
            "updated_at": "2026-07-28T10:00:00",
        }], ["Kin"])
        self.assertIn("Do not invent facts", prompt)
        self.assertIn("ordered from oldest to newest", prompt)
        self.assertIn("Omit database terms", prompt)


class RecapPersistenceTests(unittest.TestCase):
    def test_recap_throttle_is_persisted_per_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = MemoryDB(root / "memory.db", root / "backups")
            self.assertTrue(db.situation_recap_due("group-a"))
            db.record_situation_recap("group-a", ["Kin"], "Recap", "source", True, 1)
            self.assertFalse(db.situation_recap_due("group-a"))
            self.assertTrue(db.situation_recap_due("group-b"))


class TelemetryOutputTests(unittest.TestCase):
    @patch("lifeline_memory_manager.QPlainTextEdit")
    def test_unknown_worker_output_creates_a_telemetry_tab(self, editor_class) -> None:
        window = Mock()
        window.tab_edits = {}
        window.telemetry_tabs = Mock()
        editor = editor_class.return_value

        MainWindow.set_output(window, "Future Output Channel", "payload")

        editor.setReadOnly.assert_called_once_with(True)
        editor.setObjectName.assert_called_once_with("TelemetryConsole")
        window.telemetry_tabs.addTab.assert_called_once_with(editor, "Future Output Channel")
        editor.setPlainText.assert_called_once_with("payload")
        self.assertIs(window.tab_edits["Future Output Channel"], editor)


class LaunchBehaviorTests(unittest.TestCase):
    def test_launch_hides_window_when_tray_is_available(self) -> None:
        window = Mock()
        window.tray_icon = Mock()

        open_minimized_to_tray(window)

        window.hide.assert_called_once_with()
        window.show.assert_not_called()
        window.showMinimized.assert_not_called()

    def test_launch_falls_back_to_minimized_window_without_tray(self) -> None:
        window = Mock()
        window.tray_icon = None

        open_minimized_to_tray(window)

        window.showMinimized.assert_called_once_with()
        window.show.assert_not_called()


if __name__ == "__main__":
    unittest.main()
