from pathlib import Path


MAIN_JS = (Path(__file__).parent / "main.js").read_text(encoding="utf-8")
STYLES_CSS = (Path(__file__).parent / "styles.css").read_text(encoding="utf-8")


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
    compatibility_builder = MAIN_JS.split("function buildDirectoryExperimentalUpdatePayload", 1)[1].split("\n", 1)[0]
    assert "user_set_temperature" in compatibility_builder
    assert "reasoning_effort" in compatibility_builder
    assert "llm_flair" in compatibility_builder
    assert "ai_avatar" not in compatibility_builder
    assert "custom_avatar_description" not in compatibility_builder
    assert "Number.isFinite(parsedTemperature)" in compatibility_builder
    assert "compatibilityPayload = { ...buildDirectoryOfficialUpdatePayload" in MAIN_JS


def test_compatibility_failure_reports_its_own_route_and_status():
    assert "Compatibility update ${compatibilityOperation.endpoint} returned HTTP" in MAIN_JS
    assert "profile.experimental && !profile.experimental.ok ? 'directory_update_kin'" in MAIN_JS


def test_directory_sync_has_duplicate_create_lock_and_three_actions():
    assert "activeDirectoryKindroidOperations.has(directoryUid)" in MAIN_JS
    assert "REBUILD ON KINDROID" in MAIN_JS
    assert "UPDATE ON KINDROID" in MAIN_JS
    assert "MARK ONLINE ONLY" in MAIN_JS
    assert "markDirectoryPersonOnlineOnly" in MAIN_JS



def test_successful_kindroid_update_auto_closes_with_notch_animation():
    assert "autoCloseSuccessfulDirectoryUpdate()" in MAIN_JS
    assert "sync.result && !sync.error && !sync.retryBridgeSave" in MAIN_JS
    assert "sync.closing?'is-closing':''" in MAIN_JS
    assert ".kindroid-sync-backdrop.is-closing" in STYLES_CSS
    assert "@keyframes syncNotchClose" in STYLES_CSS


def test_manual_journal_records_target_ai_id():
    assert "record.remote_ai_id = record.remote_status === 'synced'" in MAIN_JS
    assert "operation:'manual'" in MAIN_JS


def test_family_memory_update_uses_generation_coparent_links_and_saves_bridge():
    assert "function familyMemoryForEntry(entry)" in MAIN_JS
    assert "cleanGenerationIds(child.parents, childId)" in MAIN_JS
    assert "cleanGenerationIds(candidate.children, candidateId).includes(childId)" in MAIN_JS
    assert "The children are" in MAIN_JS
    assert "familySentences = [...childrenByPartner.entries()]" in MAIN_JS
    assert "saveBridge('Update family memory from GENERATIONS')" in MAIN_JS


def test_family_memory_update_includes_pregnancy_status_and_progress():
    assert "generationPregnancy = focus.pregnancy" in MAIN_JS
    assert "directoryPregnancy = entry?.pregnancy" in MAIN_JS
    assert "is currently pregnant${partnerPhrase}${progressPhrase}." in MAIN_JS
    assert "is not currently pregnant." in MAIN_JS
    assert "and the pregnancy is about" in MAIN_JS
    assert "Math.max(0, Math.min(100, parsedProgress))" in MAIN_JS
    assert "conversationalName(partner?.name || partnerReference, '')" in MAIN_JS
    assert "baby`" in MAIN_JS
    assert "[...pregnancySentences, ...familySentences].join('\\n')" in MAIN_JS


def test_memory_field_renders_family_update_button_and_click_handler():
    assert 'id="update-family-memory"' in MAIN_JS
    assert "updateFamilyMemory(current)" in MAIN_JS


def test_directory_search_restores_focus_and_selection_after_render():
    search_handler = MAIN_JS.split("document.querySelector('#search').addEventListener('input'", 1)[1].split("document.querySelector('#filter')", 1)[0]
    assert "selectionStart" in search_handler
    assert "search?.focus({ preventScroll: true })" in search_handler
    assert "search.setSelectionRange(selectionStart, selectionEnd)" in search_handler


def test_directory_rows_keep_readable_intrinsic_height():
    assert ".people-list{grid-auto-rows:max-content;align-content:start" in STYLES_CSS
    assert ".person{min-height:4rem" in STYLES_CSS


def test_bridge_journal_auto_populates_wiki():
    assert "const JOURNAL_BRIDGE_PATH = 'journal.json'" in MAIN_JS
    assert "function mergeJournalIntoWiki(payload)" in MAIN_JS
    assert "source_type: 'kindroid_journal'" in MAIN_JS
    assert "await syncJournalWiki();" in MAIN_JS
    assert "saveBridge('Auto-populate wiki from Kindroid journal', true)" in MAIN_JS
    assert 'id="wiki-journal-sync"' in MAIN_JS


def test_wiki_defaults_to_saved_article_reading_mode():
    assert "wikiEditing: false" in MAIN_JS
    assert "Already saved in your LIFELINE wiki" in MAIN_JS
    assert 'id="wiki-edit"' in MAIN_JS
    assert 'SAVE CHANGES' in MAIN_JS
    assert 'SAVE TO WIKI' not in MAIN_JS
    assert "function wikiArticleMarkup(content)" in MAIN_JS
    assert ".wiki-prose p:first-child:first-letter" in STYLES_CSS



def test_wiki_displays_only_the_primary_keyword():
    assert "word: keywords[0] || sourceTitle" in MAIN_JS
    assert "source_title: sourceTitle" in MAIN_JS
    assert "const supportingKeywordCount = Math.max(0, articleKeywords.length - 1)" in MAIN_JS
    assert "+${supportingKeywordCount} available in search" in MAIN_JS
    assert "supportingKeywords.map" not in MAIN_JS
    assert "wiki-keyword-dominant" not in MAIN_JS
    assert "PRIMARY KEYWORD" in MAIN_JS
