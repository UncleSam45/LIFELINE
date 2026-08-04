from pathlib import Path


MAIN = (Path(__file__).parent / "electron_main.cjs").read_text(encoding="utf-8")
ADAPTER = (Path(__file__).parent / "kindroid_journal_adapter.cjs").read_text(encoding="utf-8")


def test_kindroid_panel_never_rewrites_or_clears_kindroid_responses():
    panel_loader = MAIN.split("async function loadKindroidPanel", 1)[1].split("function cleanGroupId", 1)[0]
    assert "clearCache" not in panel_loader
    assert "clearStorageData" not in panel_loader
    assert "extraHeaders" not in panel_loader


def test_kindroid_route_failure_is_not_replaced_with_home_navigation():
    failure_handler = MAIN.split("webContents.on('did-fail-load'", 1)[1].split("webContents.on('did-finish-load'", 1)[0]
    assert "kindroid\\.ai" in failure_handler
    assert "ERR_FAILED" in failure_handler


def test_journal_navigation_uses_loaded_spa_instead_of_electron_load_url():
    journal_navigation = ADAPTER.split("async openJournalPage", 1)[1].split("async selectJournalScope", 1)[0]
    assert "location.assign" in journal_navigation
    assert "this.window.loadURL" not in journal_navigation
    assert "for(let attempt=0;attempt<120;attempt++)" in journal_navigation
    assert "journalShellIsReady(expectedPath)" in journal_navigation


def test_journal_operations_use_an_isolated_window_not_the_visible_panel():
    scan_handler = MAIN.split("'lifeline:journal-sync-scan'", 1)[1].split("'lifeline:journal-sync-mutate'", 1)[0]
    mutate_handler = MAIN.split("'lifeline:journal-sync-mutate'", 1)[1].split("'lifeline:journal-sync-cancel'", 1)[0]
    assert "prepareJournalSyncWindow" in scan_handler
    assert "prepareJournalSyncWindow" in mutate_handler
    assert "createKindroidPanel" not in scan_handler
    assert "createKindroidPanel" not in mutate_handler


def test_isolated_journal_window_is_visible_during_live_scan():
    preparation = MAIN.split("async function prepareJournalSyncWindow", 1)[1].split("function cleanGroupId", 1)[0]
    assert "win.show();" in preparation
    assert "win.focus();" in preparation


def test_toolkit_injection_is_limited_to_call_routes():
    injection = MAIN.split("webContents.on('did-finish-load'", 1)[1].split("setWindowOpenHandler", 1)[0]
    assert "/call" in injection
