import time
import unittest
from unittest.mock import Mock

from lifeline_memory_manager import (
    CONTEXT_REMINDER_ACTIVITY_WINDOW_SECONDS,
    ProcessingWorker,
)


class ContextReminderActivityTests(unittest.TestCase):
    def make_worker(self) -> ProcessingWorker:
        worker = ProcessingWorker.__new__(ProcessingWorker)
        worker.settings = Mock()
        worker.settings.get.return_value = "1"
        worker.log = Mock()
        worker.db = Mock()
        worker.context_reminder_sent_at = {}
        return worker

    def test_stale_transcript_does_not_check_or_send_reminders(self) -> None:
        worker = self.make_worker()

        worker.send_context_reminders(
            "transcripts/group/transcript.json",
            "old transcript",
            {"group_id": "group", "names": ["Kin"], "ai_list": []},
            last_incoming_at=time.time() - CONTEXT_REMINDER_ACTIVITY_WINDOW_SECONDS - 1,
        )

        worker.db.context_reminders_for_transcript.assert_not_called()
        self.assertIn("no incoming transcript activity", worker.log.emit.call_args.args[0])

    def test_recent_transcript_reaches_reminder_matching(self) -> None:
        worker = self.make_worker()
        worker.db.context_reminders_for_transcript.return_value = []

        worker.send_context_reminders(
            "transcripts/group/transcript.json",
            "recent transcript",
            {"group_id": "group", "names": ["Kin"], "ai_list": []},
            last_incoming_at=time.time(),
        )

        worker.db.context_reminders_for_transcript.assert_called_once_with("recent transcript", ["Kin"])


if __name__ == "__main__":
    unittest.main()
