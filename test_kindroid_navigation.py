from pathlib import Path


MAIN = (Path(__file__).parent / "electron_main.cjs").read_text(encoding="utf-8")
ADAPTER = (Path(__file__).parent / "kindroid_journal_adapter.cjs").read_text(encoding="utf-8")


def test_kindroid_panel_repairs_disposable_web_runtime_without_clearing_login_data():
    panel_loader = MAIN.split("async function loadKindroidPanel", 1)[1].split("function cleanGroupId", 1)[0]
    assert "clearCache" in panel_loader
    assert "storages: ['serviceworkers', 'cachestorage']" in panel_loader
    assert "'cookies'" not in panel_loader


def test_kindroid_route_failure_is_not_replaced_with_home_navigation():
    failure_handler = MAIN.split("webContents.on('did-fail-load'", 1)[1].split("webContents.on('did-finish-load'", 1)[0]
    assert "kindroid\\.ai" in failure_handler
    assert "ERR_FAILED" in failure_handler


def test_journal_navigation_uses_loaded_spa_instead_of_electron_load_url():
    journal_navigation = ADAPTER.split("async openJournalPage", 1)[1].split("async selectJournalScope", 1)[0]
    assert "location.assign" in journal_navigation
    assert "this.window.loadURL" not in journal_navigation
    assert "for(let attempt=0;attempt<60;attempt++)" in journal_navigation
    assert "pageIsUsable(expectedPath)" in ADAPTER


def test_journal_operations_repair_runtime_before_spa_navigation():
    scan_handler = MAIN.split("'lifeline:journal-sync-scan'", 1)[1].split("'lifeline:journal-sync-mutate'", 1)[0]
    mutate_handler = MAIN.split("'lifeline:journal-sync-mutate'", 1)[1].split("'lifeline:journal-sync-cancel'", 1)[0]
    assert "await loadKindroidPanel(panel)" in scan_handler
    assert "await loadKindroidPanel(panel)" in mutate_handler
