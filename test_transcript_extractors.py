from pathlib import Path


ROOT = Path(__file__).parent
USERSCRIPT = (ROOT / "lifeline-kindroid-transcript.user.js").read_text(encoding="utf-8")
ELECTRON_MAIN = (ROOT / "electron_main.cjs").read_text(encoding="utf-8")


def test_userscript_supports_current_kindroid_call_menu_markup():
    assert 'button[aria-label="Call menu"]' in USERSCRIPT
    assert "['dialog', 'listbox', 'menu', 'true'].includes(popupType)" in USERSCRIPT
    assert "button[class*='call-dock-v2_menu-row__']" in USERSCRIPT
    assert "option.getAttribute('aria-pressed') !== 'true'" in USERSCRIPT


def test_userscript_retries_activation_when_rows_are_still_unavailable():
    assert "transcriptPanelAttemptedForCall" not in USERSCRIPT
    assert "if (!rows.length) {" in USERSCRIPT


def test_electron_extractor_supports_current_kindroid_call_menu_markup():
    assert 'button[aria-label="Call menu"]' in ELECTRON_MAIN
    assert "/^Call menu$/i" in ELECTRON_MAIN
    assert "button[class*='call-dock-v2_menu-row__']" in ELECTRON_MAIN
    assert "option.getAttribute('aria-pressed') !== 'true'" in ELECTRON_MAIN
