from pathlib import Path


MAIN_JS = (Path(__file__).parent / "main.js").read_text(encoding="utf-8")


def test_groupmaker_auto_mode_clicks_existing_sync_button():
    assert "document.querySelector('#gm-sync')?.click();" in MAIN_JS
    assert "syncGroupmaker({ automatic: true" not in MAIN_JS


def test_groupmaker_sync_button_uses_existing_sync_function():
    assert "document.querySelector('#gm-sync')?.addEventListener('click', () => syncGroupmaker());" in MAIN_JS
