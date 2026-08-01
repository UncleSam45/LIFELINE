from pathlib import Path


MAIN_JS = (Path(__file__).parent / "main.js").read_text(encoding="utf-8")
ELECTRON_MAIN = (Path(__file__).parent / "electron_main.cjs").read_text(encoding="utf-8")


def test_groupmaker_auto_mode_clicks_existing_sync_button():
    assert "document.querySelector('#gm-sync')?.click();" in MAIN_JS
    assert "syncGroupmaker({ automatic: true" not in MAIN_JS


def test_groupmaker_sync_button_uses_existing_sync_function():
    assert "document.querySelector('#gm-sync')?.addEventListener('click', () => syncGroupmaker());" in MAIN_JS


def test_bridge_config_writes_are_serialized():
    assert "let bridgeWriteQueue = Promise.resolve();" in MAIN_JS
    assert "bridgeWriteQueue.then(() => writeBridgeConfigNow" in MAIN_JS


def test_auto_mode_does_not_start_competing_draft_save():
    assert "if (!state.authenticated || state.groupmakerAutoMode) return;" in MAIN_JS


def test_transcript_initialization_retries_sha_conflicts():
    assert "async function ensureGroupTranscript(groupId, participants, maxAttempts = 5)" in MAIN_JS
    assert "attempt === maxAttempts - 1" in MAIN_JS


def test_electron_transcript_captures_are_queued_and_retried():
    assert "const transcriptWriteQueues = new Map();" in ELECTRON_MAIN
    assert "saveMergedTranscriptNow(token, repoPath, mergeInput, maxAttempts = 5)" in ELECTRON_MAIN
    assert "transcriptWriteQueues.get(repoPath)" in ELECTRON_MAIN
