from pathlib import Path


ROOT = Path(__file__).parent
USERSCRIPT = (ROOT / "lifeline-kindroid-transcript.user.js").read_text(encoding="utf-8")
ELECTRON_MAIN = (ROOT / "electron_main.cjs").read_text(encoding="utf-8")


def test_userscript_supports_current_kindroid_call_menu_markup():
    assert "document.querySelectorAll('button[aria-label]')" in USERSCRIPT
    assert "['dialog', 'listbox', 'menu', 'true'].includes(popupType)" in USERSCRIPT
    assert "button[class*='call-dock-v2_menu-row__']" in USERSCRIPT
    assert "option.getAttribute('aria-pressed') !== 'true'" in USERSCRIPT
    assert "new PointerEvent('pointerdown'" in USERSCRIPT


def test_userscript_retries_activation_when_rows_are_still_unavailable():
    assert "transcriptPanelAttemptedForCall" not in USERSCRIPT
    assert "if (!rows.length) {" in USERSCRIPT


def test_electron_extractor_supports_current_kindroid_call_menu_markup():
    assert "document.querySelectorAll('button[aria-label]')" in ELECTRON_MAIN
    assert "/^Call menu$/i" in ELECTRON_MAIN
    assert "button[class*='call-dock-v2_menu-row__']" in ELECTRON_MAIN
    assert "option.getAttribute('aria-pressed') !== 'true'" in ELECTRON_MAIN
    assert "new PointerEvent('pointerdown'" in ELECTRON_MAIN


def test_userscript_remembers_token_by_default_and_while_typing():
    assert "ui.token.value = saved; ui.remember.checked = true;" in USERSCRIPT
    assert "ui.token.addEventListener('input'" in USERSCRIPT
    capture = USERSCRIPT.split("async function capture()", 1)[1].split("function schedule", 1)[0]
    assert "GM_setValue(TOKEN_KEY, token)" in capture
