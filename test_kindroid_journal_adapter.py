from pathlib import Path


ADAPTER = (Path(__file__).parent / "kindroid_journal_adapter.cjs").read_text(encoding="utf-8")


def test_virtualized_rows_are_relocated_by_content_while_scrolling():
    assert "for(let attempt=0;attempt<80;attempt++)" in ADAPTER
    assert "container.dispatchEvent(new Event('scroll'" in ADAPTER
    assert "visible_text:text,title:" in ADAPTER


def test_non_journal_button_candidates_do_not_abort_the_scan():
    assert "if(!opened){skipped.push(handle.title);continue;}" in ADAPTER
    assert "skipped_candidates:skipped" in ADAPTER
    assert "none opened as journal entries" in ADAPTER


def test_adapter_uses_semantic_selectors_not_positional_selectors():
    assert 'button[role="radio"]' in ADAPTER
    assert 'textarea[maxlength="500"]' in ADAPTER
    assert "nth-child" not in ADAPTER
    assert "XPath" not in ADAPTER
