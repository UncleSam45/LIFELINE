from pathlib import Path
import json
import shutil
import subprocess


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
    family_memory_body = MAIN_JS.split("function familyMemoryForEntry(entry)", 1)[1].split("async function updateFamilyMemory", 1)[0]
    assert "syncGenerationPeopleWithDirectory();" in family_memory_body
    assert "cleanGenerationIds(child.parents, childId)" in MAIN_JS
    assert "cleanGenerationIds(candidate.children, candidateId).includes(childId)" in MAIN_JS
    assert "has a ${childRole(child)} named" in MAIN_JS
    assert "return 'daughter'" in MAIN_JS
    assert "return 'son'" in MAIN_JS
    assert "The children are" in MAIN_JS
    assert "partneredChildIds" in MAIN_JS
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


def test_family_tab_can_edit_and_save_pregnancy_data():
    assert 'id="generation-pregnant"' in MAIN_JS
    assert 'id="generation-pregnancy-partner"' in MAIN_JS
    assert 'id="generation-pregnancy-progress"' in MAIN_JS
    assert 'id="generation-pregnancy-percent"' in MAIN_JS
    assert 'id="save-pregnancy"' in MAIN_JS
    assert "generation.pregnancy = pregnancy" in MAIN_JS
    assert "current.pregnancy = { ...pregnancy }" in MAIN_JS
    assert "saveBridge('Update pregnancy from GENERATIONS')" in MAIN_JS
    assert ".pregnancy-card.active" in STYLES_CSS


def test_family_pickers_list_and_search_directory_people_including_local_only_entries():
    assert "const directoryCandidates = entries().map" in MAIN_JS
    assert "Directory profile${String(entry.ai_id || '').trim() ? '' : ' · Local only'}" in MAIN_JS
    assert 'id="generation-parent-search"' in MAIN_JS
    assert 'id="generation-child-search"' in MAIN_JS
    assert "choice.dataset.relationName" in MAIN_JS
    assert ".relation-choice[hidden]" in STYLES_CSS


def test_family_relationship_changes_are_reciprocal_and_saved():
    assert "function setGenerationRelations(person, relationKey, selectedIds)" in MAIN_JS
    assert "relationKey === 'parents' ? 'children' : 'parents'" in MAIN_JS
    assert "relative[reciprocalKey] = [...new Set(reciprocalIds)]" in MAIN_JS
    assert "function setDirectoryFamilyRelations(entry, relationKey, selectedDirectoryUids)" in MAIN_JS
    assert "setDirectoryFamilyRelations(current, 'parents'" in MAIN_JS
    assert "setDirectoryFamilyRelations(current, 'children'" in MAIN_JS
    assert "refreshGenerationRelationshipDisplay(updatedGeneration)" in MAIN_JS
    assert "queueBridgeSave('Update family relationships from GENERATIONS')" in MAIN_JS


def test_all_directory_people_receive_stable_generation_profiles():
    assert "directoryUid = String(entry.directory_uid" in MAIN_JS
    assert "String(person.directory_uid || '').trim() === directoryUid" in MAIN_JS
    assert "person.directory_uid = String(entry.directory_uid" in MAIN_JS
    assert "function syncGenerationPeopleWithDirectory()" in MAIN_JS
    assert "const directoryEntries = entries().map(ensureEntry)" in MAIN_JS
    assert "directoryEntries.forEach(ensureGenerationPerson)" in MAIN_JS
    assert "syncGenerationPeopleWithDirectory();" in MAIN_JS
    assert "replacementIds.set(sourceId, targetId)" in MAIN_JS
    assert "state.config.generations_people = people.filter" in MAIN_JS
    assert "generationPeople().forEach(mirrorGenerationRelationsToDirectory)" in MAIN_JS
    assert "normalizedGenerationName(person.name)" in MAIN_JS
    assert "byDirectoryUid.get(id)" in MAIN_JS
    assert "const value = String(person.directory_uid || id).trim()" in MAIN_JS


def test_family_links_are_mirrored_on_directory_entries_before_navigation():
    assert "entry.family_relationships && typeof entry.family_relationships === 'object'" in MAIN_JS
    assert "canonicalByUid.get(value)?.id" in MAIN_JS
    assert "person.parents = resolveIds(savedRelations.parents)" in MAIN_JS
    assert "person.children = resolveIds(savedRelations.children)" in MAIN_JS
    assert "function mirrorGenerationRelationsToDirectory(person)" in MAIN_JS
    assert "relative?.directory_uid || relative?.id" in MAIN_JS
    assert "entry.family_relationships =" in MAIN_JS
    assert "mirrorGenerationRelationsToDirectory(relative)" in MAIN_JS
    assert "mirrorGenerationRelationsToDirectory(person)" in MAIN_JS


def test_family_links_survive_navigation_with_directory_uid_only_child():
    node = shutil.which("node")
    assert node, "Node.js is required for the family graph runtime test"
    graph_source = "function normalizedGenerationName" + MAIN_JS.split("function normalizedGenerationName", 1)[1].split("function describeGenerationPerson", 1)[0]
    fixture = {
        "directory_entries": [
            {"directory_uid": "dir_ari", "name": "ARI ARTEBELLO", "ai_id": "ari-ai"},
            {"directory_uid": "dir_sam", "name": "*SAM VAISICA", "ai_id": "sam-ai"},
            {"directory_uid": "dir_mercedes", "name": "MERCEDES", "ai_id": ""},
        ],
        "generations_people": [
            {"id": "g_ari", "directory_uid": "dir_ari", "directory_ai_id": "ari-ai", "name": "ARI ARTEBELLO", "parents": [], "children": []},
            {"id": "g_sam", "directory_uid": "dir_sam", "directory_ai_id": "sam-ai", "name": "*SAM VAISICA", "parents": [], "children": []},
            {"id": "g_mercedes", "directory_uid": "dir_mercedes", "directory_ai_id": "", "name": "MERCEDES", "parents": [], "children": []},
        ],
    }
    script = f"""
const state = {{ config: {json.dumps(fixture)} }};
const entries = () => state.config.directory_entries;
const ensureEntry = (entry) => entry;
const generationPeople = () => state.config.generations_people;
const generationId = () => `generated_${{Math.random()}}`;
const escapeHtml = (value) => String(value ?? '');
const persistLocalConfig = () => state.config;
{graph_source}
syncGenerationPeopleWithDirectory();
let mercedes = findGenerationPersonForEntry(entries()[2]);
const ari = findGenerationPersonForEntry(entries()[0]);
const sam = findGenerationPersonForEntry(entries()[1]);
setDirectoryFamilyRelations(entries()[2], 'parents', ['dir_ari', 'dir_sam']);
syncGenerationPeopleWithDirectory();
mercedes = findGenerationPersonForEntry(entries()[2]);
const navigatedAri = findGenerationPersonForEntry(entries()[0]);
if (!navigatedAri.children.includes(mercedes.id)) throw new Error('Mercedes disappeared from Ari children after navigation');
if (!mercedes.parents.includes(navigatedAri.id) || !mercedes.parents.includes(sam.id)) throw new Error('Mercedes parents did not survive navigation');
if (!entries()[0].family_relationships.children.includes('dir_mercedes')) throw new Error('Ari relationship was not stored with Mercedes directory UID');
if (!generationPeople().some((person) => person.directory_uid === 'dir_mercedes')) throw new Error('Mercedes is unavailable as a canonical descendant');
const ariChildPicker = generationOptions(navigatedAri.children, navigatedAri.id);
if (!ariChildPicker.includes('MERCEDES') || !ariChildPicker.includes('value="dir_mercedes"')) throw new Error('Mercedes is missing from Ari child picker');
"""
    subprocess.run([node, "--input-type=module", "--eval", script], check=True)


def test_rerenders_preserve_view_position_without_replaying_entry_animations():
    assert "previousEditorScroll" in MAIN_JS
    assert "previousPeopleScroll" in MAIN_JS
    assert "editor.scrollTop = previousEditorScroll" in MAIN_JS
    assert "peopleList.scrollTop = previousPeopleScroll" in MAIN_JS
    assert "focus({ preventScroll: true })" in MAIN_JS
    assert "app-shell ${previousShell ? 'render-stable' : ''}" in MAIN_JS
    assert "root.querySelector('.app-shell.render-stable')" in MAIN_JS
    assert ".render-stable .sidebar" in STYLES_CSS


def test_directory_search_restores_focus_and_selection_after_render():
    search_handler = MAIN_JS.split("document.querySelector('#search').addEventListener('input'", 1)[1].split("document.querySelector('#filter')", 1)[0]
    assert "selectionStart" in search_handler
    assert "search?.focus({ preventScroll: true })" in search_handler
    assert "search.setSelectionRange(selectionStart, selectionEnd)" in search_handler


def test_root_bridge_config_is_restore_only_and_latest_snapshot_is_preferred():
    load_bridge = MAIN_JS.split("async function loadBridge()", 1)[1].split("async function saveBridge", 1)[0]
    assert "const rootFile = await readGithubContentFile(BRIDGE_PATH)" in load_bridge
    assert "READ_ONLY_LEGACY_BRIDGE_PATHS" not in MAIN_JS
    assert "kindroidxl_directory/config.json" not in MAIN_JS
    assert "richness" not in load_bridge
    assert "loadedCandidates" not in load_bridge
    assert "const latestSnapshot = await readLatestBridgeSnapshot()" in load_bridge
    assert "if (latestSnapshot) selectedCandidate" in load_bridge
    write_bridge = MAIN_JS.split("async function writeBridgeConfig", 1)[1].split("async function writeBridgeSnapshotArchive", 1)[0]
    assert "bridgeUrl(BRIDGE_PATH, false)" not in write_bridge


def test_frontend_state_is_local_first_and_github_writes_complete_snapshots():
    assert "LOCAL_CONFIG_STORAGE_KEY" in MAIN_JS
    assert "function persistLocalConfig(reason = 'Local update')" in MAIN_JS
    assert "config: localConfigSnapshot()" in MAIN_JS
    assert "persistLocalConfig(`Startup restore from ${selectedCandidate.path}`)" in MAIN_JS
    assert "local state is now authoritative for this session" in MAIN_JS
    assert "function writeBridgeSnapshotArchive(snapshot)" in MAIN_JS
    assert "snapshots/config_${stamp}_${SNAPSHOT_SESSION_ID}.json" in MAIN_JS
    write_bridge = MAIN_JS.split("async function writeBridgeConfig", 1)[1].split("async function writeBridgeSnapshotArchive", 1)[0]
    assert "state.config = { ...latest.config" not in write_bridge
    assert "localJournals" not in write_bridge
    assert "const payload = await writeBridgeSnapshotArchive(snapshot)" in write_bridge


def test_directory_edits_auto_save_before_or_after_navigation():
    assert "function scheduleDirectoryAutoSave(person, delay = 700)" in MAIN_JS
    assert "queueBridgeSave(`Auto-save Directory person:" in MAIN_JS
    assert "scheduleDirectoryAutoSave(current)" in MAIN_JS
    assert "scheduleDirectoryAutoSave(current, 0)" in MAIN_JS
    assert "scheduleDirectoryAutoSave(outgoing, 0)" in MAIN_JS


def test_directory_rows_keep_readable_intrinsic_height():
    assert ".people-list{grid-auto-rows:max-content;align-content:start" in STYLES_CSS
    assert ".person{min-height:4rem" in STYLES_CSS


def test_bridge_journal_auto_populates_wiki():
    assert "const JOURNAL_BRIDGE_PATH = 'journal.json'" in MAIN_JS
    assert "function mergeJournalIntoWiki(payload)" in MAIN_JS
    assert "source_type: 'kindroid_journal'" in MAIN_JS
    assert "await syncJournalWiki({ save: false });" in MAIN_JS
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
