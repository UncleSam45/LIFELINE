from pathlib import Path
import shutil
import subprocess


SCRIPT_PATH = Path(__file__).parent / "lifeline-kindroid-call-toolkit.user.js"
SCRIPT = SCRIPT_PATH.read_text(encoding="utf-8")


def test_call_toolkit_userscript_is_valid_javascript():
    node = shutil.which("node")
    assert node, "Node.js is required for the userscript syntax check"
    subprocess.run([node, "--check", str(SCRIPT_PATH)], check=True)


def test_call_toolkit_has_only_the_continuation_reply_button():
    assert "const CONTINUATION_MESSAGE = '*CONTINUES CONVERSATION*';" in SCRIPT
    markup = SCRIPT.split("shadow.innerHTML = `", 1)[1].split("`;", 1)[0]
    assert markup.count("<button") == 1
    assert '<button class="continue" type="button">*CONTINUES CONVERSATION*</button>' in markup


def test_call_toolkit_has_no_presets_or_automatic_monitor():
    assert "DEFAULT_PRESETS" not in SCRIPT
    assert "loadPresets" not in SCRIPT
    assert "localStorage" not in SCRIPT
    assert "speaker-monitor" not in SCRIPT
    assert "setInterval(updateMonitor" not in SCRIPT
