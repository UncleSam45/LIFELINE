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


def test_groupmaker_scenarios_can_be_saved_restored_ended_and_selected_for_sync():
    assert "function groupmakerScenarios()" in MAIN_JS
    assert "async function saveCurrentGroupmakerScenario()" in MAIN_JS
    assert "without updating the Kindroid group" in MAIN_JS
    assert "async function restoreGroupmakerScenario(scenarioKey)" in MAIN_JS
    assert "async function endGroupmakerScenario(scenarioKey)" in MAIN_JS
    assert 'id="gm-sync-source"' in MAIN_JS
    assert "applyGroupmakerScenario(selectedScenario);" in MAIN_JS
    assert "groupmaker_active_scenario_key" in MAIN_JS
    assert ".gm-scenario-panel" in STYLES_CSS


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
    assert "has ${childCountDescription(partnerChildren)} with ${partnerName}" in MAIN_JS
    assert "${possessiveName} children are named ${names}" in MAIN_JS
    assert "const childrenWithoutPartner" in MAIN_JS
    assert "childCountDescription(childrenWithoutPartner)" in MAIN_JS
    assert "return 'daughter'" in MAIN_JS
    assert "return 'son'" in MAIN_JS
    assert "const childCountDescription" in MAIN_JS
    assert "partneredChildIds" in MAIN_JS
    assert "saveBridge('Update family memory from GENERATIONS')" in MAIN_JS


def test_family_memory_update_includes_pregnancy_status_and_progress():
    assert "generationPregnancy = focus.pregnancy" in MAIN_JS
    assert "directoryPregnancy = entry?.pregnancy" in MAIN_JS
    assert "${name} is current pregnant${partnerPhrase}${progressPhrase}." in MAIN_JS
    assert "${name} is not current pregnant." in MAIN_JS
    assert "and the pregnancy is about" in MAIN_JS
    assert "Math.max(0, Math.min(100, parsedProgress))" in MAIN_JS
    assert "conversationalName(partner?.name || partnerReference, '')" in MAIN_JS
    assert "baby`" in MAIN_JS
    assert "[...pregnancySentences, ...familySentences].join(' ')" in MAIN_JS


def test_family_memory_groups_children_without_coparent_into_one_global_entry():
    node = shutil.which("node")
    assert node, "Node.js is required for the family memory runtime test"
    family_source = "function familyMemoryForEntry" + MAIN_JS.split("function familyMemoryForEntry", 1)[1].split("async function updateFamilyMemory", 1)[0]
    people = [
        {"id": "ari", "name": "ARI ARTEBELLO", "sex": "female", "children": ["eren", "jianna", "santino"]},
        {"id": "eren", "name": "ERENCINNI VAISICA A.", "sex": "female", "parents": []},
        {"id": "jianna", "name": "JIANNA VAISICA A.", "sex": "female", "parents": []},
        {"id": "santino", "name": "SANTINO VAISICA A.", "sex": "male", "parents": []},
    ]
    script = f"""
let people = {json.dumps(people)};
const syncGenerationPeopleWithDirectory = () => people;
const findGenerationPersonForEntry = () => people[0];
const generationPeople = () => people;
const generationById = () => new Map(people.map((person) => [person.id, person]));
const cleanGenerationIds = (ids, selfId = '') => (Array.isArray(ids) ? ids : []).filter((id) => id !== selfId && people.some((person) => person.id === id));
{family_source}
const result = familyMemoryForEntry({{ name: 'ARI ARTEBELLO', gender: 'female' }}).text;
const expected = "ARI ARTEBELLO is not current pregnant. ARI ARTEBELLO has 2 daughters and 1 son with unknown father. ARI ARTEBELLO's children are named ERENCINNI VAISICA A., JIANNA VAISICA A. and SANTINO VAISICA A.";
if (result !== expected) throw new Error(`Unexpected family memory:\\n${{result}}`);
people = [
  {{ id: 'ari', name: 'ARI ARTEBELLO', sex: 'female', children: ['daughter', 'son', 'second-daughter'] }},
  {{ id: 'sam', name: 'SAM VAISICA', sex: 'male', children: ['daughter', 'son'] }},
  {{ id: 'leo', name: 'LEO', sex: 'male', children: ['second-daughter'] }},
  {{ id: 'daughter', name: 'MERCEDES', sex: 'female', parents: ['ari', 'sam'] }},
  {{ id: 'son', name: 'SANTINO', sex: 'male', parents: ['ari', 'sam'] }},
  {{ id: 'second-daughter', name: 'VENUS', sex: 'female', parents: ['ari', 'leo'] }},
];
const partnered = familyMemoryForEntry({{ name: 'ARI ARTEBELLO', gender: 'female' }}).text;
const partneredExpected = "ARI ARTEBELLO is not current pregnant. ARI ARTEBELLO has 1 daughter and 0 sons with LEO. ARI ARTEBELLO's children are named VENUS. ARI ARTEBELLO has 1 daughter and 1 son with SAM VAISICA. ARI ARTEBELLO's children are named MERCEDES and SANTINO.";
if (partnered !== partneredExpected) throw new Error(`Unexpected partnered family memory:\\n${{partnered}}`);
"""
    subprocess.run([node, "--input-type=module", "--eval", script], check=True)


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


def test_family_pickers_list_the_same_directory_people_without_internal_statuses():
    assert "const candidates = entries().map((entry) => ({ entry, person: ensureGenerationPerson(entry) }))" in MAIN_JS
    assert "<small>Directory person</small>" in MAIN_JS
    assert "Family-only profile" not in MAIN_JS
    assert "Directory profile${" not in MAIN_JS
    assert 'id="generation-parent-search"' in MAIN_JS
    assert 'id="generation-child-search"' in MAIN_JS
    assert "choice.dataset.relationName" in MAIN_JS
    assert ".relation-choice[hidden]" in STYLES_CSS


def test_family_relationship_changes_are_reciprocal_and_saved():
    assert "function setDirectoryFamilyRelations(entry, relationKey, selectedDirectoryUids)" in MAIN_JS
    assert "const reciprocalKey = relationKey === 'parents' ? 'children' : 'parents'" in MAIN_JS
    assert "relative.family_relationships =" in MAIN_JS
    assert "setDirectoryFamilyRelations(current, 'parents'" in MAIN_JS
    assert "setDirectoryFamilyRelations(current, 'children'" in MAIN_JS
    assert "refreshDirectoryRelationshipDisplay(current)" in MAIN_JS
    assert "queueBridgeSave('Update family relationships from GENERATIONS')" in MAIN_JS


def test_all_directory_people_receive_stable_generation_profiles():
    assert "directoryUid = String(entry.directory_uid" in MAIN_JS
    assert "String(person.directory_uid || '').trim() === directoryUid" in MAIN_JS
    assert "person.directory_uid = String(entry.directory_uid" in MAIN_JS
    assert "function syncGenerationPeopleWithDirectory()" in MAIN_JS
    assert "const directoryEntries = entries().map(ensureEntry)" in MAIN_JS
    assert "syncGenerationPeopleWithDirectory();" in MAIN_JS
    assert "state.config.generations_people = canonical" in MAIN_JS
    assert "const byUid = new Map(canonical.map" in MAIN_JS
    assert "entryForGenerationPerson(previousById.get" in MAIN_JS
    assert "person.parents = directoryRelationUids(entry, 'parents')" in MAIN_JS
    assert "person.children = directoryRelationUids(entry, 'children')" in MAIN_JS
    assert "normalizedGenerationName(person.name)" in MAIN_JS
    assert "byDirectoryUid.get(id)" in MAIN_JS
    assert "const value = String(entry.directory_uid || '').trim()" in MAIN_JS


def test_family_links_are_mirrored_on_directory_entries_before_navigation():
    assert "entry.family_relationships =" in MAIN_JS
    assert "function directoryRelationUids(entry, relationKey)" in MAIN_JS


def test_family_links_survive_navigation_with_directory_uid_only_child():
    node = shutil.which("node")
    assert node, "Node.js is required for the family graph runtime test"
    graph_source = "function normalizedGenerationName" + MAIN_JS.split("function normalizedGenerationName", 1)[1].split("function describeGenerationPerson", 1)[0]
    family_source = "function familyMemoryForEntry" + MAIN_JS.split("function familyMemoryForEntry", 1)[1].split("async function updateFamilyMemory", 1)[0]
    fixture = {
        "directory_entries": [
            {"directory_uid": "dir_ari", "name": "ARI ARTEBELLO", "ai_id": "ari-ai"},
            {"directory_uid": "dir_sam", "name": "*SAM VAISICA", "ai_id": "sam-ai"},
            {"directory_uid": "dir_mercedes", "name": "MERCEDES", "ai_id": ""},
        ],
        "generations_people": [
            {"id": "g_ari", "directory_uid": "dir_ari", "directory_ai_id": "ari-ai", "name": "ARI ARTEBELLO", "sex": "female", "parents": [], "children": ["g_mercedes"]},
            {"id": "g_sam", "directory_uid": "dir_sam", "directory_ai_id": "sam-ai", "name": "*SAM VAISICA", "sex": "male", "parents": [], "children": ["g_mercedes"]},
            {"id": "g_mercedes", "directory_uid": "dir_mercedes", "directory_ai_id": "", "name": "MERCEDES", "parents": ["g_ari", "g_sam"], "children": []},
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
{family_source}
syncGenerationPeopleWithDirectory();
let mercedes = findGenerationPersonForEntry(entries()[2]);
const ari = findGenerationPersonForEntry(entries()[0]);
const sam = findGenerationPersonForEntry(entries()[1]);
if (!entries()[2].family_relationships.parents.includes('dir_ari') || !entries()[2].family_relationships.parents.includes('dir_sam')) throw new Error('Legacy child parents were not migrated to Directory relationships');
if (!entries()[1].family_relationships.children.includes('dir_mercedes')) throw new Error('Legacy father-child relationship was discarded');
const migratedMemory = familyMemoryForEntry(entries()[0]).text;
if (!migratedMemory.includes('with *SAM VAISICA') || migratedMemory.includes('unknown father')) throw new Error(`Known father was not used in family memory: ${{migratedMemory}}`);
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
const mercedesPicker = generationOptions(mercedes.parents, mercedes.id);
const optionCount = (markup) => (markup.match(/class="relation-choice"/g) || []).length;
if (optionCount(ariChildPicker) !== entries().length - 1 || optionCount(mercedesPicker) !== entries().length - 1) throw new Error('Family pickers do not expose the same Directory roster');
if (ariChildPicker.includes('Family-only') || mercedesPicker.includes('Local only')) throw new Error('Internal profile statuses leaked into family picker');
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
    assert "function writeBridgeSnapshotArchive(snapshot, attempt = 0)" in MAIN_JS
    assert "snapshots/config_${stamp}_${SNAPSHOT_SESSION_ID}_${String(++snapshotSequence)" in MAIN_JS
    write_bridge = MAIN_JS.split("async function writeBridgeConfig", 1)[1].split("async function writeBridgeSnapshotArchive", 1)[0]
    assert "state.config = { ...latest.config" not in write_bridge
    assert "localJournals" not in write_bridge
    assert "const payload = await writeBridgeSnapshotArchive(snapshot)" in write_bridge
    assert "return writeBridgeSnapshotArchive(snapshot, attempt + 1)" in MAIN_JS
    assert "await queueBridgeSave(reason)" in MAIN_JS
    assert "Saved ${entries().length} entries to ${BRIDGE_PATH}" not in MAIN_JS


def test_groupmaker_transcript_conflicts_are_retried_without_failing_created_group():
    transcript_setup = MAIN_JS.split("async function ensureGroupTranscript", 1)[1].split("async function readGithubContentFile", 1)[0]
    assert "attempt >= 3" in transcript_setup
    assert "'Cache-Control': 'no-cache'" in transcript_setup
    assert "fresh=${Date.now()}-${attempt}" in transcript_setup
    groupmaker_sync = MAIN_JS.split("async function syncGroupmaker", 1)[1].split("async function fetchTranscriptPage", 1)[0]
    assert "let transcriptWarning = ''" in groupmaker_sync
    assert "Transcript metadata will be repaired on the next sync" in groupmaker_sync
    assert "const opened = openCall" in groupmaker_sync


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


def test_connection_logger_supports_server_and_access_key_login():
    assert "const GITHUB_OWNER = 'unclesam45'" in MAIN_JS
    assert 'id="crowdnet-connection-logger"' in MAIN_JS
    assert 'id="crowdnet-login-form"' in MAIN_JS
    assert 'name="server"' in MAIN_JS
    assert 'name="accessKey"' in MAIN_JS
    assert 'id="logger-storage" name="storage"' in MAIN_JS
    assert 'disabled aria-describedby="logger-storage-note"' in MAIN_JS
    assert 'Storage selection is currently inactive.' in MAIN_JS
    assert 'class="logger-actions"' in MAIN_JS
    assert 'CONFIRM <span aria-hidden="true">→</span>' in MAIN_JS
    assert "source.querySelector('[name=\"server\"]')" in MAIN_JS
    assert "source.querySelector('[name=\"accessKey\"]')" in MAIN_JS
    assert "logger.classList.add('logger-connected')" in MAIN_JS
    assert '@keyframes crowdnetLoggerConnected' in STYLES_CSS
    login_markup = MAIN_JS.split('function renderLogin()', 1)[1].split('function connectionLoggerMarkup()', 1)[0]
    assert 'GitHub' not in login_markup
    assert 'fine grained' not in login_markup.lower()
