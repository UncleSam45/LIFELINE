from pathlib import Path


ELECTRON_MAIN = (Path(__file__).parent / "electron_main.cjs").read_text(encoding="utf-8")


def test_updated_launcher_opens_fresh_renderer_when_an_old_instance_still_exists():
    assert "if (!hasSingleInstanceLock) app.quit()" not in ELECTRON_MAIN
    assert "if (hasSingleInstanceLock) app.whenReady()" not in ELECTRON_MAIN
    assert "app.whenReady().then(() =>" in ELECTRON_MAIN
    assert "if (isPrimaryInstance) createTray()" in ELECTRON_MAIN
    assert "if (!isPrimaryInstance) app.quit()" in ELECTRON_MAIN


def test_second_instance_refreshes_frontend_from_disk_without_cache():
    second_instance = ELECTRON_MAIN.split("app.on('second-instance'", 1)[1].split("});", 1)[0]
    assert "mainWindow.webContents.reloadIgnoringCache()" in second_instance
