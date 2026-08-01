from pathlib import Path


MAIN_JS = (Path(__file__).parent / "main.js").read_text(encoding="utf-8")


def test_groupmaker_auto_mode_opens_call_window():
    assert "syncGroupmaker({ automatic: true, openCall: true })" in MAIN_JS
    assert "syncGroupmaker({ automatic: true, openCall: false })" not in MAIN_JS


def test_groupmaker_tracks_tabs_by_group_without_bulk_close():
    assert "const groupmakerKindroidTabs = new Map();" in MAIN_JS
    assert "function closePriorGroupmakerTabs" not in MAIN_JS
    assert "groupmakerKindroidTabs.set(String(groupId), tabRef)" in MAIN_JS

