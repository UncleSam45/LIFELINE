from pathlib import Path
import shutil
import subprocess


SCRIPT_PATH = Path(__file__).parent / "lifeline-kindroid-auto-call.user.js"
SCRIPT = SCRIPT_PATH.read_text(encoding="utf-8")


def test_auto_call_userscript_is_valid_javascript():
    node = shutil.which("node")
    assert node, "Node.js is required for the userscript syntax check"
    subprocess.run([node, "--check", str(SCRIPT_PATH)], check=True)


def test_auto_call_uses_accessible_label_instead_of_ephemeral_full_class():
    assert "button[aria-label]" in SCRIPT
    assert "=== START_CALL_LABEL" in SCRIPT
    assert 'call-preview-overlay-v2_call-button__lMp93' not in SCRIPT
    assert 'call-preview-overlay-v2_call-button__' in SCRIPT


def test_auto_call_handles_delayed_renders_and_retries_safely():
    assert "new MutationObserver(queueScan)" in SCRIPT
    assert "global.setInterval(pressStartCall, SCAN_INTERVAL_MS)" in SCRIPT
    assert "const attempts = new WeakMap()" in SCRIPT
    assert "element.disabled" in SCRIPT
    assert "aria-disabled" in SCRIPT


def test_auto_call_supports_both_kindroid_hosts():
    assert "// @match        https://kindroid.ai/*" in SCRIPT
    assert "// @match        https://www.kindroid.ai/*" in SCRIPT
