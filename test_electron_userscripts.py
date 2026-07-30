from pathlib import Path


ROOT = Path(__file__).parent
ELECTRON_MAIN = (ROOT / "electron_main.cjs").read_text(encoding="utf-8")


def test_electron_injects_both_checked_in_userscripts():
    assert "lifeline-kindroid-call-toolkit.user.js" in ELECTRON_MAIN
    assert "lifeline-kindroid-transcript.user.js" in ELECTRON_MAIN
    assert "lifelineUserscriptBridge.request" in ELECTRON_MAIN


def test_legacy_transcript_extraction_path_is_removed():
    assert "extractCallTranscript" not in ELECTRON_MAIN
    assert "lifeline:fetch-group-transcript" not in ELECTRON_MAIN
    assert "startAutomaticTranscriptCapture" not in ELECTRON_MAIN


def test_kindroid_startup_cache_is_not_destroyed():
    assert "clearStorageData" not in ELECTRON_MAIN
    assert "clearCache" not in ELECTRON_MAIN
    assert "Cache-Control: no-cache" not in ELECTRON_MAIN
