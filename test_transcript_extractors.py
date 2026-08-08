from pathlib import Path


ROOT = Path(__file__).parent
USERSCRIPT = (ROOT / "lifeline-kindroid-transcript.user.js").read_text(encoding="utf-8")
ELECTRON_MAIN = (ROOT / "electron_main.cjs").read_text(encoding="utf-8")


def test_userscript_supports_current_kindroid_call_menu_markup():
    assert "document.querySelectorAll('button[aria-label]')" in USERSCRIPT
    assert "['dialog', 'listbox', 'menu', 'true'].includes(popupType)" in USERSCRIPT
    assert "button[class*='call-dock-v2_menu-row__']" in USERSCRIPT
    assert "option.getAttribute('aria-pressed') !== 'true'" in USERSCRIPT
    assert "HTMLElement.prototype.click.call(element)" in USERSCRIPT
    assert "new KeyboardEvent('keydown'" in USERSCRIPT
    assert "const activated = await waitFor" in USERSCRIPT


def test_userscript_does_not_retoggle_menu_after_transcript_control_is_found():
    assert "let transcriptPanelActivatedForCall = '';" in USERSCRIPT
    assert "transcriptPanelActivatedForCall !== callId" in USERSCRIPT
    assert "if (option) transcriptPanelActivatedForCall = callId;" in USERSCRIPT
    assert "lastUrl = location.href;\n    transcriptPanelActivatedForCall = '';" in USERSCRIPT


def test_electron_extractor_supports_current_kindroid_call_menu_markup():
    assert "document.querySelectorAll('button[aria-label]')" in ELECTRON_MAIN
    assert "/^Call menu$/i" in ELECTRON_MAIN
    assert "button[class*='call-dock-v2_menu-row__']" in ELECTRON_MAIN
    assert "option.getAttribute('aria-pressed') !== 'true'" in ELECTRON_MAIN
    assert "HTMLElement.prototype.click.call(element)" in ELECTRON_MAIN
    assert "new KeyboardEvent('keydown'" in ELECTRON_MAIN
    assert "const activated = await waitFor" in ELECTRON_MAIN


def test_electron_extractor_remembers_activation_in_page_document():
    assert "const ACTIVATED_MARKER = 'lifelineTranscriptPanelActivated';" in ELECTRON_MAIN
    assert "document.documentElement.dataset[ACTIVATED_MARKER] === 'true'" in ELECTRON_MAIN
    assert "document.documentElement.dataset[ACTIVATED_MARKER] = 'true';" in ELECTRON_MAIN


def test_userscript_remembers_token_by_default_and_before_capture():
    assert "ui.token.value = saved; ui.remember.checked = true;" in USERSCRIPT
    capture = USERSCRIPT.split("async function capture()", 1)[1].split("function schedule", 1)[0]
    assert "GM_setValue(TOKEN_KEY, token)" in capture


def test_userscript_fetches_large_github_files_through_the_git_blob_api():
    assert "async function readGithubFileUtf8(token, file, action)" in USERSCRIPT
    assert "file?.encoding === 'base64'" in USERSCRIPT
    assert "url: file.git_url" in USERSCRIPT
    assert "JSON.parse(await readGithubFileUtf8(token, file, 'Reading GROUPMAKER participant metadata'))" in USERSCRIPT
