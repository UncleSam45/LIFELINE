from pathlib import Path


JOURNAL_SCRIPT = (Path(__file__).parent / "journal.js").read_text(encoding="utf-8")


def test_journal_userscript_is_kindroid_only_and_has_no_runtime_code():
    assert "// ==UserScript==" in JOURNAL_SCRIPT
    assert "// @match        https://kindroid.ai/*" in JOURNAL_SCRIPT
    assert "// @match        https://www.kindroid.ai/*" in JOURNAL_SCRIPT
    assert "// @grant        none" in JOURNAL_SCRIPT
    assert JOURNAL_SCRIPT.rstrip().endswith("// ==/UserScript==")
