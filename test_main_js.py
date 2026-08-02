from pathlib import Path


MAIN_JS = (Path(__file__).parent / "main.js").read_text(encoding="utf-8")


def test_groupmaker_auto_mode_clicks_existing_sync_button():
    assert "document.querySelector('#gm-sync')?.click();" in MAIN_JS
    assert "syncGroupmaker({ automatic: true" not in MAIN_JS


def test_groupmaker_sync_button_uses_existing_sync_function():
    assert "document.querySelector('#gm-sync')?.addEventListener('click', () => syncGroupmaker());" in MAIN_JS


def test_directory_kindroid_uses_legacy_compatibility_routes():
    assert "directory_create_kin','Directory Create Kin'" in MAIN_JS
    assert "'POST','/create-new-ai'" in MAIN_JS
    assert "directory_update_kin','Directory Compatibility Update'" in MAIN_JS
    assert "'POST','/update-info'" in MAIN_JS
    assert "executeKindroidOperation('create_journal_entry'" in MAIN_JS


def test_directory_updates_build_partial_inclusion_markers():
    assert "output[`__include_${key}`] = 'set'" in MAIN_JS
    assert "buildDirectoryOfficialUpdatePayload" in MAIN_JS
    assert "buildDirectoryExperimentalUpdatePayload" in MAIN_JS
    assert "age:person.age" not in MAIN_JS


def test_directory_sync_has_duplicate_create_lock_and_three_actions():
    assert "activeDirectoryKindroidOperations.has(directoryUid)" in MAIN_JS
    assert "REBUILD ON KINDROID" in MAIN_JS
    assert "UPDATE ON KINDROID" in MAIN_JS
    assert "MARK ONLINE ONLY" in MAIN_JS
    assert "markDirectoryPersonOnlineOnly" in MAIN_JS


def test_manual_journal_records_target_ai_id():
    assert "record.remote_ai_id = record.remote_status === 'synced'" in MAIN_JS
    assert "operation:'manual'" in MAIN_JS
