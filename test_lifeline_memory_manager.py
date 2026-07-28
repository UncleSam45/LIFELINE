import datetime as dt
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from lifeline_memory_manager import (
    MEMORY_HELPER_ACTIVITY_WINDOW_SECONDS,
    MemoryDB,
    ProcessingWorker,
    SituationRecapComposer,
)


class WorkerTestCase(unittest.TestCase):
    def make_worker(self) -> ProcessingWorker:
        worker = ProcessingWorker.__new__(ProcessingWorker)
        worker.settings = Mock()
        worker.settings.get.return_value = "1"
        worker.log = Mock()
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


if __name__ == "__main__":
    unittest.main()
