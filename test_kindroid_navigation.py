from pathlib import Path


MAIN = (Path(__file__).parent / "electron_main.cjs").read_text(encoding="utf-8")
ADAPTER = (Path(__file__).parent / "kindroid_journal_adapter.cjs").read_text(encoding="utf-8")


def test_kindroid_panel_does_not_clear_persistent_web_runtime():
    panel_loader = MAIN.split("async function loadKindroidPanel", 1)[1].split("function cleanGroupId", 1)[0]
    assert "clearCache" not in panel_loader
    assert "clearStorageData" not in panel_loader
    assert "await panel.loadURL(KINDROID_HOME_URL);" in panel_loader


def test_kindroid_route_failure_is_not_replaced_with_home_navigation():
    failure_handler = MAIN.split("webContents.on('did-fail-load'", 1)[1].split("webContents.on('did-finish-load'", 1)[0]
    assert "kindroid\\.ai" in failure_handler
    assert "ERR_FAILED" in failure_handler


def test_journal_navigation_tolerates_spa_takeover_and_retries():
    assert "for(let attempt=0;attempt<2;attempt++)" in ADAPTER
    assert "pageIsUsable(expectedPath)" in ADAPTER
    assert "JOURNAL PAGE FAILED TO LOAD:" in ADAPTER
