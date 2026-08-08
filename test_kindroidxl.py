from pathlib import Path


SCRIPT = (Path(__file__).parent / "KINDROIDXL.js").read_text(encoding="utf-8")


def test_journal_sync_uses_connected_repository_contents_api():
    assert "const JOURNAL_PATH = 'journal.json'" in SCRIPT
    assert "/contents/${JOURNAL_PATH}" in SCRIPT
    assert "method: 'PUT'" in SCRIPT
    assert "remote?.sha ? { sha: remote.sha }" in SCRIPT


def test_journal_sync_deduplicates_and_recovers_from_concurrent_writes():
    assert "crypto.subtle.digest('SHA-256'" in SCRIPT
    assert "if (known.has(entry.id)) return false" in SCRIPT
    assert "error.status === 409 || error.status === 422" in SCRIPT
    assert "mergeAndSaveJournal(owner, repo, token, extracted, attempt + 1)" in SCRIPT


def test_journal_sync_is_scoped_to_kindroid_journal_page():
    assert "new URLSearchParams(location.search).get('tab') === 'journal'" in SCRIPT
    assert "mountJournalControl" in SCRIPT
    assert "window.setTimeout(syncJournal, 1800)" in SCRIPT
