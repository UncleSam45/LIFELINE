function ensureLifelineRoot() {
  let mount = document.querySelector('#lifeline-root');
  if (!mount) {
    mount = document.createElement('div');
    mount.id = 'lifeline-root';
    mount.setAttribute('aria-live', 'polite');
    document.body.prepend(mount);
  }
  return mount;
}

const root = ensureLifelineRoot();

function initializeMotionExperience() {
  const splash = document.querySelector('#lifeline-splash');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealNewContent = () => {
    if (reducedMotion) return;
    if (root.querySelector('.app-shell.render-stable')) return;
    const selector = '.status, .asset-card, .field-grid > label, .person, .automation-entry, .news-card, .rawg-card, .relation-card';
    root.querySelectorAll(selector).forEach((element, index) => {
      element.classList.add('motion-reveal');
      element.style.setProperty('--reveal-delay', `${Math.min(index, 12) * 42}ms`);
    });
  };
  new MutationObserver(revealNewContent).observe(root, { childList: true });
  document.addEventListener('pointermove', (event) => {
    if (reducedMotion) return;
    document.documentElement.style.setProperty('--pointer-x', `${(event.clientX / innerWidth) * 100}%`);
    document.documentElement.style.setProperty('--pointer-y', `${(event.clientY / innerHeight) * 100}%`);
  }, { passive: true });
  document.addEventListener('pointerdown', (event) => {
    if (reducedMotion || !event.target.closest('button')) return;
    const ripple = document.createElement('span');
    ripple.className = 'click-ripple'; ripple.style.left = `${event.clientX}px`; ripple.style.top = `${event.clientY}px`;
    document.body.append(ripple); ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  });
  window.setTimeout(() => {
    root.classList.remove('app-loading'); root.classList.add('app-ready');
    if (!splash) return;
    splash.classList.add('splash-exit');
    const removeSplash = (event) => {
      if (event && (event.target !== splash || event.animationName !== 'splashFadeOut')) return;
      splash.remove();
    };
    splash.addEventListener('animationend', removeSplash);
    window.setTimeout(() => removeSplash(), 1300);
  }, reducedMotion ? 150 : 2600);
}

initializeMotionExperience();

if (window.lifelineElectron?.getKindroidPanelState) {
  window.lifelineElectron.getKindroidPanelState().then((panelState) => {
    state.kindroidPanelOpen = Boolean(panelState?.open);
    if (state.authenticated) render();
  });
  window.lifelineElectron.onKindroidPanelState?.((panelState) => {
    state.kindroidPanelOpen = Boolean(panelState?.open);
    const button = document.querySelector('#kindroid-panel-toggle');
    if (button) {
      button.classList.toggle('active', state.kindroidPanelOpen);
      button.querySelector('b').textContent = state.kindroidPanelOpen ? 'KINDROID OPEN' : 'OPEN KINDROID';
    }
  });
}

const GITHUB_OWNER = 'unclesam45';
const BRIDGE_REPO = 'LIFELINE_BRIDGE';
const BRIDGE_BRANCH = 'main';
const BRIDGE_PATH = 'config.json';
const JOURNAL_BRIDGE_PATH = 'journal.json';
const TOKEN_STORAGE_KEY = 'lifeline.bridge.accessKey';
const REMEMBER_STORAGE_KEY = 'lifeline.bridge.rememberAccessKey';
const LOCAL_CONFIG_STORAGE_KEY = 'lifeline.local.config.snapshot';
const KINDROID_API_KEY_STORAGE_KEY = 'lifeline.kindroid.apiKey';
const WEATHER_API_KEY_STORAGE_KEY = 'lifeline.weather.apiKey';
const WEATHER_API_URL = 'https://api.weatherapi.com/v1/forecast.json';
const NEWS_API_KEY_STORAGE_KEY = 'lifeline.news.apiKey';
const NEWS_API_URL = 'https://newsapi.org/v2/top-headlines';
const RAWG_API_KEY_STORAGE_KEY = 'lifeline.rawg.apiKey';
const RAWG_API_URL = 'https://api.rawg.io/api/games';
const KINDROID_BASE_URL = 'https://api.kindroid.ai/v1';
const GROUPMAKER_REQUESTER = 'LIFELINE-MAINJS-GROUPMAKER';
const PHONE_CALL_DIRECTIVE = 'This is a phone call. Respond in direct speech only. Avoid action or inner thought narration. Keep it concise.';
const REMEMBERED_ACCESS_KEY = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
const REMEMBERED_KINDROID_API_KEY = localStorage.getItem(KINDROID_API_KEY_STORAGE_KEY) || '';
const REMEMBERED_WEATHER_API_KEY = localStorage.getItem(WEATHER_API_KEY_STORAGE_KEY) || '';
const REMEMBERED_NEWS_API_KEY = localStorage.getItem(NEWS_API_KEY_STORAGE_KEY) || '';
const REMEMBERED_RAWG_API_KEY = localStorage.getItem(RAWG_API_KEY_STORAGE_KEY) || '';
const REMEMBERED_KINDROID_CONNECTED = REMEMBERED_KINDROID_API_KEY.trim().startsWith('kn_');
const REMEMBERED_GITHUB_LOGIN_ENABLED = localStorage.getItem(REMEMBER_STORAGE_KEY) === 'true' && Boolean(REMEMBERED_ACCESS_KEY.trim());
let groupmakerDraftSaveTimer = null;
let groupmakerAutoSyncTimer = null;
let directoryAutoSaveTimer = null;
const SNAPSHOT_SESSION_ID = `session_${Date.now()}_${Math.floor(Math.random() * 0xffffff).toString(16)}`;
let snapshotSequence = 0;
const GROUPMAKER_AUTO_SYNC_DELAY_MS = 5000;
const groupmakerKindroidTabs = new Map();

const DIRECTORY_API_METADATA = {
  name: 'Officially synchronized: update_info.ai_name',
  gender: 'Officially synchronized: update_info.ai_gender',
  ai_id: 'Official conversation identifier',
  backstory: 'Officially synchronized: update_info.ai_backstory',
  ai_memory: 'Officially synchronized: update_info.ai_memory',
  greeting: 'Officially synchronized for chat-break greeting only',
  directive: 'Officially synchronized: update_info.ai_directive',
  additional_context: 'Officially synchronized: update_info.ai_additional_context',
  temperature: 'Compatibility synchronized: directory_update_kin.user_set_temperature',
  reasoning_effort: 'Compatibility synchronized: directory_update_kin.reasoning_effort',
  llm_flair: 'Compatibility synchronized: directory_update_kin.llm_flair',
  avatar_preset: 'Used for Kin creation; normal update support is unverified',
  avatar_description: 'Used for Kin creation; normal update support is unverified',
  age: 'Local only',
  location: 'Local directory location; GROUPMAKER sends location changes as messages',
  activity: 'Officially synchronized: update_info.current_scene',
};

const DIRECTORY_FIELDS = [
  ['name', 'NAME', 'line'],
  ['gender', 'GENDER', 'line'],
  ['age', 'AGE', 'age_combo'],
  ['ai_id', 'ID', 'line'],
  ['location', 'LOCATION', 'line'],
  ['activity', 'ACTIVITY', 'line'],
  ['backstory', 'BACKSTORY 1', 'text'],
  ['ai_memory', 'MEMORY', 'text'],
  ['greeting', 'GREETING', 'text'],
  ['directive', 'DIRECTIVE', 'text'],
  ['additional_context', 'ADDITIONAL CONTEXT', 'text'],
  ['temperature', 'TEMPERATURE', 'line'],
  ['reasoning_effort', 'REASONING EFFORT', 'line'],
  ['llm_flair', 'LLM FLAIR', 'line'],
  ['avatar_preset', 'AVATAR PRESET', 'line'],
  ['avatar_description', 'AVATAR DESCRIPTION', 'text'],
];

const AGE_OPTIONS = ['BABY', 'TODDLER', 'CHILD', 'TEEN', 'YOUNG ADULT', 'ADULT'];
const DEFAULT_ENTRY = {
  age: 'ADULT',
  temperature: '1.15',
  reasoning_effort: 'xhigh',
  llm_flair: 'roleplay',
  avatar_preset: '1',
  additional_context: '',
  location: 'home',
  activity: '',
  online: false,
  archived: false,
};

const state = {
  accessKey: REMEMBERED_ACCESS_KEY,
  rememberKey: localStorage.getItem(REMEMBER_STORAGE_KEY) === 'true',
  authenticated: false,
  syncState: REMEMBERED_GITHUB_LOGIN_ENABLED ? 'Auto login' : 'Locked',
  syncDetail: REMEMBERED_GITHUB_LOGIN_ENABLED
    ? 'Remembered access key found; connecting automatically…'
    : 'Enter your access key.',
  config: localConfigSnapshot() || { directory_entries: [], journal_entries: [] },
  bridgeSha: '',
  selectedUid: '',
  activeView: 'world',
  selectedWikiId: '',
  wikiSearch: '',
  wikiEditing: false,
  journalWikiSync: { busy: false, status: 'Waiting for bridge', imported: 0, total: 0 },
  filter: 'active',
  search: '',
  saving: false,
  kindroidApiKey: REMEMBERED_KINDROID_API_KEY,
  kindroidConnected: REMEMBERED_KINDROID_CONNECTED,
  weatherApiKey: REMEMBERED_WEATHER_API_KEY,
  weatherOpen: false,
  weatherBusy: false,
  weatherError: '',
  weatherData: null,
  newsApiKey: REMEMBERED_NEWS_API_KEY,
  newsOpen: false,
  newsBusy: false,
  newsError: '',
  newsData: null,
  newsRegion: 'quebec',
  rawgApiKey: REMEMBERED_RAWG_API_KEY,
  rawgOpen: false,
  rawgBusy: false,
  rawgError: '',
  rawgData: null,
  groupmakerOpen: true,
  groupmakerMinimized: false,
  groupmakerBusy: false,
  groupmakerTranscriptBusy: false,
  groupmakerTranscriptStatus: '',
  groupmakerTranscriptResult: null,
  apiStudioOpen: false,
  apiStudioCategory: 'individual_chat',
  apiStudioOperationKey: 'send_message',
  apiStudioShowExperimental: false,
  apiStudioValues: {},
  apiStudioResponse: null,
  apiStudioPreview: null,
  apiStudioLiveOutput: '',
  apiStudioAdvanced: false,
  apiStudioDebug: false,
  transcriptState: { conversationType: 'individual', conversationId: '', limit: 25, cursor: '', requestCount: 0, pages: [], messages: [], raw: null, busy: false, lastResult: '', activeRequestId: '' },
  groupmakerStatus: '',
  groupmakerNames: '',
  groupmakerLocation: '',
  groupmakerActivity: '',
  groupmakerContext: '',
  groupmakerUseNames: true,
  groupmakerUseActivity: true,
  groupmakerAutoMode: false,
  activeEntryTab: 'profile',
  settingsOpen: false,
  kindroidPanelOpen: false,
  directoryKindroidSync: { open:false, busy:false, action:'', personUid:'', step:'', completedSteps:[], currentJournal:0, totalJournals:0, warnings:[], error:null, result:null, technical:null, retryBridgeSave:false },
};

const activeDirectoryKindroidOperations = new Map();
let directorySyncAutoCloseTimer = null;
let directorySyncAnimationTimer = null;
let bridgeWriteQueue = Promise.resolve();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[char]));
}

function newDirectoryUid() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 20);
  return `dir_${stamp}_${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

function entries() {
  if (!Array.isArray(state.config.directory_entries)) state.config.directory_entries = [];
  state.config.directory_entries = state.config.directory_entries.filter((entry) => entry && typeof entry === 'object');
  return state.config.directory_entries;
}

function persistLocalConfig(reason = 'Local update') {
  const snapshot = { ...state.config, _lifeline_snapshot: { version: 1, created_at: new Date().toISOString(), session_id: SNAPSHOT_SESSION_ID, reason } };
  localStorage.setItem(LOCAL_CONFIG_STORAGE_KEY, JSON.stringify(snapshot));
  state.config = snapshot;
  return snapshot;
}

function localConfigSnapshot() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_CONFIG_STORAGE_KEY) || 'null');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null;
  } catch {
    return null;
  }
}


function journalEntries() {
  if (!Array.isArray(state.config.journal_entries)) state.config.journal_entries = [];
  state.config.journal_entries = state.config.journal_entries.filter((entry) => entry && typeof entry === 'object').map(ensureJournalEntry);
  return state.config.journal_entries;
}

function newJournalId() {
  return `journal_${Date.now()}_${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

function normalizeJournalKeyphrases(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  return [...new Set(values.map((phrase) => String(phrase).trim()).filter(Boolean))].slice(0, 8);
}

function ensureJournalEntry(record = {}) {
  const now = new Date().toISOString();
  const validStatuses = ['draft', 'submitting', 'synced', 'failed', 'unknown'];
  const normalized = {
    ...record,
    id: String(record.id || newJournalId()), directory_uid: String(record.directory_uid || ''),
    ai_id: String(record.ai_id || ''), person_name: String(record.person_name || 'Unknown person'),
    entry: String(record.entry || ''), keyphrases: normalizeJournalKeyphrases(record.keyphrases),
    created_at: String(record.created_at || now), updated_at: String(record.updated_at || record.created_at || now),
    remote_status: validStatuses.includes(record.remote_status) ? record.remote_status : 'draft',
    remote_http_status: Number(record.remote_http_status || 0), remote_created_at: String(record.remote_created_at || ''),
    remote_ai_id: String(record.remote_ai_id || ''), last_sync_operation: String(record.last_sync_operation || ''),
    last_sync_error: String(record.last_sync_error || ''), sync_history: Array.isArray(record.sync_history) ? record.sync_history : [],
    attempt_count: Math.max(0, Number(record.attempt_count || 0)), archived: Boolean(record.archived),
  };
  Object.assign(record, normalized);
  return record;
}

function journalsForPerson(person) {
  return journalEntries().filter((journal) => journal.directory_uid === person?.directory_uid).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function validateJournalDraft({ ai_id, entry, keyphrases }, { requireKey = false } = {}) {
  const errors = [];
  if (!String(ai_id || '').trim()) errors.push('This person needs an AI ID.');
  if (!String(entry || '').trim()) errors.push('Journal entry is required.');
  const normalized = normalizeJournalKeyphrases(keyphrases);
  if (!normalized.length) errors.push('At least one keyphrase is required.');
  if ((Array.isArray(keyphrases) ? keyphrases : String(keyphrases || '').split(/[\n,]+/)).map(String).filter((x) => x.trim()).length > 8) errors.push('A maximum of 8 keyphrases is allowed.');
  if (requireKey && !getKindroidCredential().startsWith('kn_')) errors.push('A valid Kindroid API key starting with kn_ is required.');
  return { ok: !errors.length, errors, keyphrases: normalized };
}

function heartbeatEntries() {
  if (!Array.isArray(state.config.heartbeat_entries)) state.config.heartbeat_entries = [];
  state.config.heartbeat_entries = state.config.heartbeat_entries.filter((entry) => entry && typeof entry === 'object');
  return state.config.heartbeat_entries;
}

function wikiEntries() {
  if (!Array.isArray(state.config.wiki_entries)) state.config.wiki_entries = [];
  state.config.wiki_entries = state.config.wiki_entries.filter((entry) => entry && typeof entry === 'object');
  return state.config.wiki_entries;
}

function newWikiId() {
  return `wiki_${Date.now()}_${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

function normalizeBridgeJournal(payload) {
  const rows = Array.isArray(payload?.entries) ? payload.entries : [];
  return rows.map((entry) => {
    const keywords = (Array.isArray(entry?.keywords) ? entry.keywords : []).map((keyword) => String(keyword || '').trim()).filter(Boolean);
    const sourceTitle = String(entry?.fullTitle || '').trim();
    return {
      id: String(entry?.id || '').trim(),
      word: keywords[0] || sourceTitle,
      content: String(entry?.mainEntry || '').trim(),
      keywords,
      source_title: sourceTitle,
    };
  }).filter((entry) => entry.id && entry.word && entry.content);
}

function mergeJournalIntoWiki(payload) {
  const journal = normalizeBridgeJournal(payload);
  const wiki = wikiEntries();
  const existing = new Map(wiki.filter((entry) => entry.source_type === 'kindroid_journal' && entry.source_id).map((entry) => [String(entry.source_id), entry]));
  const sourceUpdatedAt = String(payload?.timestamp || new Date().toISOString());
  let changed = 0;
  journal.forEach((source) => {
    const entry = existing.get(source.id);
    if (!entry) {
      wiki.push({ id: `wiki_journal_${source.id}`, word: source.word, content: source.content, created_at: sourceUpdatedAt, updated_at: sourceUpdatedAt, source_type: 'kindroid_journal', source_id: source.id, source_path: JOURNAL_BRIDGE_PATH, source_title: source.source_title, keywords: source.keywords });
      changed += 1;
      return;
    }
    const update = { word: source.word, content: source.content, source_path: JOURNAL_BRIDGE_PATH, source_title: source.source_title, keywords: source.keywords };
    if (Object.entries(update).some(([key, value]) => JSON.stringify(entry[key]) !== JSON.stringify(value))) {
      Object.assign(entry, update, { updated_at: sourceUpdatedAt });
      changed += 1;
    }
  });
  return { changed, total: journal.length };
}

function wikiArticleMarkup(content) {
  const blocks = String(content || '').trim().split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return blocks.length ? blocks.map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`).join('') : '<p class="wiki-article-empty">This article is waiting for its story.</p>';
}

function wikiReadingTime(content) {
  const words = String(content || '').trim().split(/\s+/).filter(Boolean).length;
  return { words, minutes: Math.max(1, Math.ceil(words / 220)) };
}

function groupmakerSessions() {
  if (!Array.isArray(state.config.groupmaker_sessions)) state.config.groupmaker_sessions = [];
  state.config.groupmaker_sessions = state.config.groupmaker_sessions.filter((row) => row && typeof row === 'object');
  return state.config.groupmaker_sessions;
}

function localCalendarDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function groupmakerSessionDate(session) {
  const explicit = String(session?.session_date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const timestamp = String(session?.created_at || session?.touched_at || '').trim();
  const parsed = timestamp ? new Date(timestamp) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? localCalendarDate(parsed) : '';
}

function closeExpiredGroupmakerSessions(now = new Date()) {
  const today = localCalendarDate(now);
  const closedAt = now.toISOString();
  let changed = false;
  groupmakerSessions().forEach((session) => {
    if (String(session.closed_at || '').trim() || String(session.idle_at || '').trim()) return;
    const sessionDate = groupmakerSessionDate(session);
    if (sessionDate && sessionDate !== today) {
      session.closed_at = closedAt;
      session.closed_reason = 'daily_rollover';
      changed = true;
    }
  });
  const activeKey = String(state.config.groupmaker_active_session_key || '').trim();
  const active = groupmakerSessions().find((session) => String(session.session_key || '').trim() === activeKey);
  if (activeKey && (!active || String(active.closed_at || '').trim() || String(active.idle_at || '').trim())) {
    state.config.groupmaker_active_session_key = '';
    changed = true;
  }
  return changed;
}


function groupmakerDraft() {
  if (!state.config.groupmaker_draft || typeof state.config.groupmaker_draft !== 'object' || Array.isArray(state.config.groupmaker_draft)) {
    state.config.groupmaker_draft = {};
  }
  return state.config.groupmaker_draft;
}

function hydrateGroupmakerDraft() {
  const draft = groupmakerDraft();
  state.groupmakerNames = String(draft.names || '');
  state.groupmakerLocation = String(draft.location || '');
  state.groupmakerActivity = String(draft.activity || draft.position || '');
  state.groupmakerContext = String(draft.context || '');
  state.groupmakerUseNames = draft.use_names !== false;
  state.groupmakerUseActivity = draft.use_activity !== false;
  state.groupmakerAutoMode = Boolean(draft.auto_mode);
}

function rememberKindroidApiKey() {
  const key = state.kindroidApiKey.trim();
  if (!key) {
    state.kindroidConnected = false;
    localStorage.removeItem(KINDROID_API_KEY_STORAGE_KEY);
    return false;
  }
  const valid = key.startsWith('kn_');
  if (valid) localStorage.setItem(KINDROID_API_KEY_STORAGE_KEY, key);
  state.kindroidConnected = valid;
  return valid;
}

function persistGroupmakerDraft() {
  const draft = groupmakerDraft();
  draft.names = state.groupmakerNames;
  draft.location = state.groupmakerLocation;
  draft.activity = state.groupmakerActivity;
  delete draft.position;
  draft.context = state.groupmakerContext;
  draft.use_names = state.groupmakerUseNames;
  draft.use_activity = state.groupmakerUseActivity;
  draft.auto_mode = state.groupmakerAutoMode;
  draft.touched_at = new Date().toISOString();
}

function scheduleGroupmakerAutoSync() {
  if (groupmakerAutoSyncTimer) clearTimeout(groupmakerAutoSyncTimer);
  groupmakerAutoSyncTimer = null;
  if (!state.groupmakerAutoMode) return;
  groupmakerAutoSyncTimer = setTimeout(() => {
    groupmakerAutoSyncTimer = null;
    document.querySelector('#gm-sync')?.click();
  }, GROUPMAKER_AUTO_SYNC_DELAY_MS);
}

function scheduleGroupmakerDraftSave() {
  persistGroupmakerDraft();
  if (!state.authenticated) return;
  if (groupmakerDraftSaveTimer) clearTimeout(groupmakerDraftSaveTimer);
  groupmakerDraftSaveTimer = setTimeout(() => {
    groupmakerDraftSaveTimer = null;
    saveBridgeQuiet('Save GROUPMAKER draft');
  }, 1200);
}

function activeGroupmakerSession() {
  closeExpiredGroupmakerSessions();
  const activeKey = String(state.config.groupmaker_active_session_key || '').trim();
  const selected = activeKey ? groupmakerSessions().find((row) => String(row.session_key || '').trim() === activeKey && !String(row.closed_at || '').trim() && !String(row.idle_at || '').trim()) : null;
  if (selected) return selected;
  const todaySession = latestOpenGroupmakerSession();
  if (todaySession) state.config.groupmaker_active_session_key = todaySession.session_key;
  return todaySession;
}

function latestOpenGroupmakerSession() {
  const today = localCalendarDate();
  return groupmakerSessions().filter((row) => groupmakerSessionDate(row) === today && !String(row.closed_at || '').trim() && !String(row.idle_at || '').trim() && String(row.group_id || '').trim()).slice().sort((a, b) => String(b.touched_at || '').localeCompare(String(a.touched_at || '')))[0] || null;
}

function reconnectGroupmakerSession() {
  return activeGroupmakerSession() || latestOpenGroupmakerSession();
}

function normalizeTokens(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z0-9']+/g)?.filter((token) => token.length >= 2) || []);
}

function detectGroupmakerPeople(text) {
  const tokens = normalizeTokens(text);
  if (!tokens.size) return [];
  const byId = new Map();
  entries().map(ensureEntry).forEach((person) => {
    const aiId = String(person.ai_id || '').trim();
    const name = String(person.name || '').trim();
    if (!aiId || !name || person.archived) return;
    const nameTokens = normalizeTokens(name);
    const meaningful = [...nameTokens].filter((token) => token.length >= 3);
    const matched = meaningful.some((token) => tokens.has(token)) || [...nameTokens].some((token) => tokens.has(token));
    if (matched) byId.set(aiId, { ai_id: aiId, name, location: person.location || '', activity: person.activity || person.position || '' });
  });
  return [...byId.values()];
}

function validAiIds(rawIds) {
  const seen = new Set();
  return rawIds.map((raw) => {
    const text = String(raw || '').trim();
    const paren = text.match(/\(([A-Za-z0-9_-]{8,})\)\s*$/);
    if (paren) return paren[1];
    if (/^[A-Za-z0-9_-]{8,}$/.test(text)) return text;
    const matches = text.match(/[A-Za-z0-9_-]{8,}/g);
    return matches ? matches[matches.length - 1] : '';
  }).filter((id) => id && !seen.has(id) && seen.add(id));
}

function composeGroupName() {
  return localCalendarDate();
}




const KINDROID_OPERATION_STATUSES = ['official', 'experimental_verified', 'experimental_unverified', 'legacy_alias', 'retired'];
const KINDROID_API_CATEGORIES = {
  individual_chat: 'Individual Chat', group_chat: 'Group Chat', transcripts: 'Transcripts', configuration: 'Configuration',
  memory_journals: 'Memory and Journals', media_selfies: 'Media and Selfies', discord: 'Discord', account: 'Account',
  experimental: 'Experimental', legacy_routes: 'Legacy Routes',
};
const KINDROID_RATE_LIMITS = { general_generation: { label: 'General generation' }, configuration_update: { label: 'Configuration update' }, transcript_read: { label: 'Transcript read', documentedLimit: '600 requests per 24 hours; do not long poll.' }, experimental: { label: 'Experimental' } };
function kField(key, label, type = 'text', opts = {}) { return { key, label, type, required: false, defaultValue: undefined, placeholder: '', description: '', inputLocation: 'body', validation: {}, sensitive: false, omitEmpty: true, support: 'official', officiallySupported: true, experimentalNotes: '', allowedValues: [], ...opts }; }
function officialSource(notes = '') { return { type: 'official_documentation', lastReviewed: '2026-07-23', notes }; }
function legacySource(notes = '') { return { type: 'legacy_registry', file: 'kindroid_api_registry.py', notes }; }
function discoveredSource(notes = '') { return { type: 'current_lifeline_discovery', file: 'main.js', notes }; }
function op(key, label, category, stability, method, endpoint, fields, opts = {}) { return { key, label, category, stability, method, endpoint, requestLocation: method === 'GET' ? 'query' : 'body', contentType: 'application/json', responseType: 'text', supportsStreaming: false, generatesContent: false, destructive: false, requiresConfirmation: false, supportsPartialUpdates: false, exactlyOneOf: [], aliases: [], rateLimitGroup: stability === 'official' ? 'general_generation' : 'experimental', defaultTimeoutMs: 45000, successStatusCodes: [200, 201, 204], description: '', documentationNotes: '', fields, validators: [], sourceNotes: [], ...opts }; }
const officialKinUpdate = ['ai_name','ai_gender','ai_backstory','ai_memory','ai_directive','ai_example_message','ai_additional_context','current_scene','user_name','user_gender'];
const legacyKinFields = ['ai_id',...officialKinUpdate.filter(x=>!['user_name','user_gender'].includes(x)),'user_set_temperature','reasoning_effort','llm_flair','proactive_mode','proactive_action_directive','time_awareness','show_auto_selfies_in_chat','ai_avatar','custom_avatar_url','custom_avatar_description','custom_avatar_fidelity','custom_avatar_face_detail','custom_avatar_face_prompt','avatar_is_anime','unset_custom_avatar_animation'];
const groupFields = ['ai_list','group_name','group_context','group_directive','current_scene'];
const groupExperimentalFields = ['use_manual_turntaking','share_short_term_memory','disable_ltm_recall','disable_ltm_consolidate','user_persona_id'];
const KINDROID_API_REGISTRY = Object.freeze({
  send_message: op('send_message','Send Message','individual_chat','official','POST','/send-message',[kField('ai_id','AI ID','ai_selector',{required:true}),kField('message','Message','textarea',{required:true,sensitive:true}),kField('stream','Stream','boolean',{defaultValue:false,omitEmpty:false})],{responseType:'text',supportsStreaming:true,generatesContent:true,sourceNotes:[officialSource('Plain text by default; optional streaming.')]}),
  chat_break: op('chat_break','Chat Break','individual_chat','official','POST','/chat-break',[kField('ai_id','AI ID','ai_selector',{required:true}),kField('greeting','Greeting','textarea',{required:true,sensitive:true}),kField('wipe_cascaded','Memory reset scope','boolean',{defaultValue:false,omitEmpty:false,description:'false resets short-term memory only; true also wipes cascaded memory.'})],{destructive:true,requiresConfirmation:true,rateLimitGroup:'configuration_update',sourceNotes:[officialSource()]}),
  get_chat_messages: op('get_chat_messages','Get Chat Messages','transcripts','official','GET','/get-chat-messages',[kField('ai_id','AI ID','ai_selector',{inputLocation:'query'}),kField('group_id','Group ID','group_selector',{inputLocation:'query'}),kField('limit','Limit','number',{inputLocation:'query',defaultValue:25,validation:{min:1,max:100}}),kField('start_after_timestamp','Start after timestamp','text',{inputLocation:'query'})],{responseType:'json',exactlyOneOf:[['ai_id','group_id']],rateLimitGroup:'transcript_read',defaultTimeoutMs:30000,documentationNotes:'Oldest first. Use pagination.lastTimestamp as cursor. 600 requests/24h; no long polling.',sourceNotes:[officialSource()]}),
  rewind_messages: op('rewind_messages','Rewind Messages','individual_chat','official','POST','/rewind-messages',[kField('ai_id','AI ID','ai_selector'),kField('group_id','Group ID','group_selector'),kField('count','Count','number',{required:true,validation:{min:1}})],{destructive:true,requiresConfirmation:true,exactlyOneOf:[['ai_id','group_id']],rateLimitGroup:'configuration_update',sourceNotes:[officialSource('Individual rewinds require even count; group rewinds require count >= 1.')]}),
  update_info: op('update_info','Update Kindroid Info','configuration','official','POST','/update-info',[kField('ai_id','AI ID','ai_selector',{required:true}),...officialKinUpdate.map(x=>kField(x,x.replaceAll('_',' ').toUpperCase(),x.includes('story')||x.includes('memory')||x.includes('directive')||x.includes('context')||x.includes('scene')||x.includes('message')?'textarea':'text',{partial:true,sensitive:!['ai_name','ai_gender','user_name','user_gender'].includes(x)}))],{supportsPartialUpdates:true,rateLimitGroup:'configuration_update',sourceNotes:[officialSource('Omitted fields are unchanged; inclusion controls are required.')]}),
  group_user_message: op('group_user_message','Post Group User Message','group_chat','official','POST','/groupchats-user-message',[kField('group_id','Group ID','group_selector',{required:true}),kField('message','Message','textarea',{sensitive:true}),kField('audio_url','Audio URL','url',{sensitive:true})],{exactlyOneOf:[['message','audio_url']],sourceNotes:[officialSource()]}),
  group_get_turn: op('group_get_turn','Get Group Turn','group_chat','official','POST','/groupchats-get-turn',[kField('group_id','Group ID','group_selector',{required:true}),kField('allow_user','Allow User Turn','boolean',{defaultValue:true,omitEmpty:false})],{responseType:'empty_or_text',sourceNotes:[officialSource('Returns an AI ID or empty body when user turn begins.')]}),
  group_ai_response: op('group_ai_response','Generate Group AI Response','group_chat','official','POST','/groupchats-ai-response',[kField('group_id','Group ID','group_selector',{required:true}),kField('ai_id','AI ID','ai_selector',{required:true}),kField('stream','Stream','boolean',{defaultValue:false,omitEmpty:false})],{responseType:'text',supportsStreaming:true,generatesContent:true,sourceNotes:[officialSource()]}),
  group_chat_break: op('group_chat_break','Group Chat Break','group_chat','official','POST','/groupchats-chat-break',[kField('group_id','Group ID','group_selector',{required:true}),kField('greeting','Greeting','textarea',{required:true,sensitive:true}),kField('wipe_cascaded','Wipe Cascaded Memory','boolean',{defaultValue:false,omitEmpty:false})],{destructive:true,requiresConfirmation:true,rateLimitGroup:'configuration_update',sourceNotes:[officialSource()]}),
  group_update: op('group_update','Update Group Chat','configuration','official','POST','/groupchats-update',[kField('group_id','Group ID','group_selector',{required:true}),...groupFields.map(x=>kField(x,x.replaceAll('_',' ').toUpperCase(),x==='ai_list'?'csv':'textarea',{partial:x!=='ai_list',sensitive:x!=='group_name'}))],{supportsPartialUpdates:true,rateLimitGroup:'configuration_update',sourceNotes:[officialSource('Group context is persistent shared info; current_scene is immediate setting. Product toggles are not official fields.')]}),
  discord_bot: op('discord_bot','Discord Bot','discord','official','POST','/discord-bot',[kField('share_code','Share Code','text',{required:true,sensitive:true}),kField('enable_filter','Enable Filter','boolean',{defaultValue:true,omitEmpty:false}),kField('conversation','Conversation JSON','json',{required:true,sensitive:true}),kField('x_kindroid_requester','X-Kindroid-Requester','text',{inputLocation:'header',required:true,description:'Use a hashed user-specific requester value.'})],{responseType:'text',sourceNotes:[officialSource()]})
});
const EXPERIMENTAL_KINDROID_API_REGISTRY = Object.freeze({
  directory_create_kin: op('directory_create_kin','Directory Create Kin','experimental','experimental_verified','POST','/create-new-ai',['ai_name','ai_gender','ai_backstory','custom_greeting','ai_directive','ai_avatar','custom_avatar_description'].map(x=>kField(x,x,'textarea',{required:['ai_name','ai_gender','ai_backstory'].includes(x),support:'experimental',officiallySupported:false,sensitive:/story|greeting|directive|description/.test(x)})),{destructive:true,requiresConfirmation:true,sourceNotes:[legacySource('Recovered Directory compatibility route. Never automatically retried.')] }),
  directory_update_kin: op('directory_update_kin','Directory Compatibility Update','experimental','experimental_verified','POST','/update-info',[kField('ai_id','AI ID','ai_selector',{required:true}),...officialKinUpdate.filter(x=>!['user_name','user_gender','ai_example_message'].includes(x)).map(x=>kField(x,x,'textarea',{partial:true,support:'official_equivalent',officiallySupported:true,sensitive:!['ai_name','ai_gender'].includes(x)})),kField('user_set_temperature','Temperature','number',{partial:true,support:'experimental',officiallySupported:false}),kField('reasoning_effort','Reasoning effort','text',{partial:true,support:'experimental',officiallySupported:false}),kField('llm_flair','LLM flair','text',{partial:true,support:'experimental',officiallySupported:false})],{supportsPartialUpdates:true,sourceNotes:[legacySource('Recovered Directory update payload. Core profile fields accompany compatibility fields as in the desktop workflow. Avatar update fields are deliberately excluded because this route has not verified them.')] }),
  create_kin_legacy: op('create_kin_legacy','Create Kin Legacy','experimental','experimental_unverified','POST','/create-kin',['ai_name','ai_gender','ai_backstory','custom_greeting','ai_directive','ai_avatar','custom_avatar_url','custom_avatar_description','custom_avatar_fidelity','custom_avatar_face_detail','custom_avatar_face_prompt','avatar_is_anime'].map(x=>kField(x,x,'textarea',{support:'experimental',officiallySupported:false,sensitive:/story|greeting|directive|avatar/.test(x)})),{sourceNotes:[legacySource('Recovered Feeder route; hidden unless experimental is enabled.')]}),
  update_kin_legacy: op('update_kin_legacy','Update Kin Legacy','experimental','experimental_unverified','POST','/update-kin',legacyKinFields.map(x=>kField(x,x,/memory|story|directive|context|scene|prompt|message|description/.test(x)?'textarea':'text',{partial:x!=='ai_id',support:officialKinUpdate.includes(x)||x==='ai_id'?'official_equivalent':'experimental',officiallySupported:officialKinUpdate.includes(x)||x==='ai_id',officialEquivalent:officialKinUpdate.includes(x)||x==='ai_id'?`update_info.${x}`:null,sensitive:/memory|story|directive|context|scene|prompt|message|description|avatar_url/.test(x)})),{supportsPartialUpdates:true,sourceNotes:[legacySource('Shows official equivalents and isolates internal fields.')]}),
  create_groupchat_legacy: op('create_groupchat_legacy','Create Groupchat Legacy','legacy_routes','legacy_alias','POST','/create-groupchat',[...groupFields,...groupExperimentalFields].map(x=>kField(x,x,x==='ai_list'?'csv':(x.startsWith('use_')||x.startsWith('share_')||x.startsWith('disable_')?'tri_boolean':'textarea'),{support:groupFields.includes(x)?'official_equivalent':'experimental',officialEquivalent:groupFields.includes(x)?`group_update.${x}`:null,officiallySupported:groupFields.includes(x)})),{sourceNotes:[legacySource('Do not auto-fallback to /groupchats-create.')]}),
  create_groupchat_current_discovery: op('create_groupchat_current_discovery','Create Groupchat Current Discovery','experimental','experimental_unverified','POST','/groupchats-create',[...groupFields,...groupExperimentalFields].map(x=>kField(x,x,x==='ai_list'?'csv':(x.startsWith('use_')||x.startsWith('share_')||x.startsWith('disable_')?'tri_boolean':'textarea'),{support:groupFields.includes(x)?'official_equivalent':'experimental',officiallySupported:groupFields.includes(x)})),{sourceNotes:[discoveredSource('Currently used by GroupMaker for creation.')] }),
  update_groupchat_legacy: op('update_groupchat_legacy','Update Groupchat Legacy','legacy_routes','legacy_alias','POST','/update-groupchat',['group_id',...groupFields,...groupExperimentalFields].map(x=>kField(x,x,x==='ai_list'?'csv':(x.startsWith('use_')||x.startsWith('share_')||x.startsWith('disable_')?'tri_boolean':'textarea'),{partial:x!=='group_id',support:groupFields.includes(x)||x==='group_id'?'official_equivalent':'experimental',officialEquivalent:groupFields.includes(x)||x==='group_id'?`group_update.${x}`:null,officiallySupported:groupFields.includes(x)||x==='group_id'})),{supportsPartialUpdates:true,sourceNotes:[legacySource()]}),
  send_groupchat_message_legacy: op('send_groupchat_message_legacy','Send Groupchat Message Legacy','legacy_routes','legacy_alias','POST','/send-groupchat-message',[kField('group_id','Group ID','group_selector',{required:true}),kField('message','Message','textarea',{sensitive:true}),kField('audio_url','Audio URL','url',{sensitive:true})],{aliases:['/groupchats-user-message'],exactlyOneOf:[['message','audio_url']],sourceNotes:[legacySource('Modern replacement: group_user_message.')] }),
  groupchat_get_turn_legacy: op('groupchat_get_turn_legacy','Groupchat Get Turn Legacy','legacy_routes','legacy_alias','POST','/groupchat-get-turn',[kField('group_id','Group ID','group_selector',{required:true}),kField('allow_user','Allow User','boolean')],{aliases:['/groupchats-get-turn'],sourceNotes:[legacySource('Modern replacement: group_get_turn.')] }),
  groupchat_ai_response_legacy: op('groupchat_ai_response_legacy','Groupchat AI Response Legacy','legacy_routes','legacy_alias','POST','/groupchat-ai-response',[kField('group_id','Group ID','group_selector',{required:true}),kField('ai_id','AI ID','ai_selector',{required:true}),kField('stream','Stream','boolean'),kField('request_id','Request ID','text',{support:'experimental',officiallySupported:false})],{aliases:['/groupchats-ai-response'],supportsStreaming:true,sourceNotes:[legacySource('request_id remains experimental.')] }),
  request_selfie: op('request_selfie','Request Selfie','media_selfies','experimental_unverified','POST','/request-selfie',['ai_id','prompt','aspect','uses_nsfw'].map(x=>kField(x,x,x==='uses_nsfw'?'boolean':(x==='prompt'?'textarea':'text'),{support:'experimental',officiallySupported:false,sensitive:x==='prompt'})),{sourceNotes:[legacySource()]}),
  request_group_selfie: op('request_group_selfie','Request Group Selfie','media_selfies','experimental_unverified','POST','/request-group-selfie',['version','ai_ids','prompt','regional_prompts','aspect','uses_nsfw','seed'].map(x=>kField(x,x,x==='ai_ids'?'csv':(x==='regional_prompts'?'json':(x==='uses_nsfw'?'boolean':(x==='prompt'?'textarea':'text'))),{support:'experimental',officiallySupported:false,sensitive:/prompt/.test(x)})),{sourceNotes:[legacySource()]}),
  create_journal_entry: op('create_journal_entry','Create Journal Entry','memory_journals','experimental_verified','POST','/journal-create',[kField('ai_id','AI ID','ai_selector',{required:true}),kField('entry','Entry','textarea',{required:true,support:'experimental',officiallySupported:false,sensitive:true}),kField('keyphrases','Keyphrases','csv',{required:true,support:'experimental',officiallySupported:false})],{sourceNotes:[legacySource('Retained from Memory Cleaner/Feeder remote journal jobs.')] }),
  suggest_user_message: op('suggest_user_message','Suggest User Message','experimental','experimental_unverified','POST','/suggest-user-message',[kField('ai_id','AI ID','ai_selector',{required:true}),kField('existing_message','Existing Message','textarea',{sensitive:true})],{sourceNotes:[legacySource()]}),
  suggest_user_group_message: op('suggest_user_group_message','Suggest User Group Message','experimental','experimental_unverified','POST','/suggest-user-group-message',[kField('group_id','Group ID','group_selector',{required:true}),kField('existing_message','Existing Message','textarea',{sensitive:true})],{sourceNotes:[legacySource()]}),
  check_subscription: op('check_subscription','Check Subscription','account','experimental_unverified','POST','/check-subscription',[],{sourceNotes:[legacySource('Never run automatically at login.')]})
});
const ALL_KINDROID_OPERATIONS = Object.freeze({ ...KINDROID_API_REGISTRY, ...EXPERIMENTAL_KINDROID_API_REGISTRY });
function getKindroidOperation(operationKey) { return ALL_KINDROID_OPERATIONS[operationKey] || null; }
function listKindroidOperations(filters = {}) { return Object.values(ALL_KINDROID_OPERATIONS).filter((operation) => (!filters.category || operation.category === filters.category) && (filters.includeExperimental || operation.stability === 'official') && (!filters.stability || operation.stability === filters.stability)); }
function coerceKindroidFieldValue(field, raw) { if (raw === undefined) return field.defaultValue; if (field.type === 'number') return raw === '' ? undefined : Number(raw); if (field.type === 'boolean') return raw === true || raw === 'true' || raw === 'on'; if (field.type === 'tri_boolean') return raw === '' || raw === undefined ? undefined : raw === true || raw === 'true' || raw === 'enable'; if (field.type === 'csv') return Array.isArray(raw) ? raw : String(raw || '').split(/[\n,]+/).map(x=>x.trim()).filter(Boolean); if (field.type === 'json') { if (typeof raw !== 'string') return raw; if (!raw.trim()) return undefined; return JSON.parse(raw); } return String(raw ?? ''); }
function validateKindroidOperation(operationKey, values = {}) { const operation = getKindroidOperation(operationKey); const errors = []; if (!operation) return { ok:false, errors:['Unknown Kindroid operation.'] }; for (const field of operation.fields) { let raw = values[field.key]; if (operation.supportsPartialUpdates && field.partial && values[`__include_${field.key}`] !== 'set' && values[`__include_${field.key}`] !== 'clear' && values[`__include_${field.key}`] !== 'enable' && values[`__include_${field.key}`] !== 'disable') continue; if (field.required && String(raw ?? '').trim() === '') errors.push(`${field.label || field.key} is required.`); if (field.validation?.min !== undefined && raw !== '' && Number(raw) < field.validation.min) errors.push(`${field.label || field.key} must be at least ${field.validation.min}.`); if (field.validation?.max !== undefined && raw !== '' && Number(raw) > field.validation.max) errors.push(`${field.label || field.key} must be at most ${field.validation.max}.`); } for (const group of operation.exactlyOneOf || []) { const present = group.filter((key) => String(values[key] ?? '').trim() !== ''); if (present.length !== 1) errors.push(`Exactly one of ${group.join(' or ')} must be supplied.`); } if (operationKey === 'rewind_messages' && values.ai_id && Number(values.count) % 2 !== 0) errors.push('Individual rewinds require an even count.'); if (operationKey === 'discord_bot' && values.conversation) { try { const c = coerceKindroidFieldValue({ type:'json' }, values.conversation); if (!Array.isArray(c) || c.some(row => !row || typeof row.username !== 'string' || typeof row.text !== 'string' || Number.isNaN(Date.parse(row.timestamp)))) errors.push('Conversation must be an array of { username, text, timestamp: ISO date string }.'); } catch { errors.push('Conversation must be valid JSON.'); } } return { ok: !errors.length, errors }; }
function buildKindroidRequest(operationKey, values = {}) { const operation = getKindroidOperation(operationKey); if (!operation) throw new Error('Unknown Kindroid operation.'); const validation = validateKindroidOperation(operationKey, values); if (!validation.ok) { const error = new Error(validation.errors.join(' ')); error.kindroidCategory = 'validation'; throw error; } const headers = { Authorization: 'Bearer [REDACTED]', Accept: operation.responseType === 'json' ? 'application/json' : 'text/plain' }; const query = {}; const body = {}; for (const field of operation.fields) { const mode = values[`__include_${field.key}`]; if (operation.supportsPartialUpdates && field.partial) { if (!mode) continue; if (mode === 'clear') { body[field.key] = ''; continue; } if (mode === 'enable') { body[field.key] = true; continue; } if (mode === 'disable') { body[field.key] = false; continue; } }
    const value = coerceKindroidFieldValue(field, values[field.key]); if ((value === undefined || value === '' || (Array.isArray(value) && !value.length)) && field.omitEmpty) continue; if (field.inputLocation === 'header') { if (field.key === 'x_kindroid_requester') headers['X-Kindroid-Requester'] = String(value || ''); else headers[field.key] = String(value || ''); } else if (operation.method === 'GET' || field.inputLocation === 'query') query[field.key] = value; else body[field.key] = value; }
  if (operation.method !== 'GET') headers['Content-Type'] = operation.contentType; return { operationKey, method: operation.method, endpoint: operation.endpoint, url: `${KINDROID_BASE_URL}${operation.endpoint}`, headers, query, body, responseType: operation.responseType, timeoutMs: operation.defaultTimeoutMs, stability: operation.stability, destructive: operation.destructive }; }
function normalizeKindroidError(operationKey, error, extra = {}) { const status = extra.status || error?.status || 0; let category = error?.kindroidCategory || 'unknown'; if (error?.name === 'AbortError') category = 'cancelled'; else if (/timeout/i.test(error?.message || '')) category = 'timeout'; else if (status === 401) category = 'authentication'; else if (status === 403) category = 'permission'; else if (status === 404) category = 'not_found'; else if (status === 429) category = 'rate_limit'; else if (status >= 500) category = 'server'; else if (!status && /fetch|network/i.test(error?.message || '')) category = 'network'; return { ok:false, operationKey, category, status, message: error?.message || extra.rawText || 'Kindroid request failed.', rawText: extra.rawText || '', retryable: ['rate_limit','server','network','timeout'].includes(category) }; }
function redactKindroidData(value) { const sensitive = /api.?key|authorization|message|backstory|memory|directive|context|scene|greeting|journal|transcript|persona|url/i; if (Array.isArray(value)) return value.map(redactKindroidData); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, sensitive.test(k) ? '[REDACTED]' : redactKindroidData(v)])); if (typeof value === 'string' && value.startsWith('kn_')) return '[REDACTED_KINDROID_KEY]'; return value; }
function recordKindroidTestResult(result) { if (!state.config.kindroid_test_results) state.config.kindroid_test_results = []; const operation = getKindroidOperation(result.operationKey); state.config.kindroid_test_results.push({ operationKey: result.operationKey, route: operation?.endpoint || '', testedAt: new Date().toISOString(), status: result.status || 0, resultCategory: result.ok ? 'success' : result.category || 'unknown', responseSignature: String(result.rawText || result.data || '').slice(0, 80).replace(/\s+/g,' '), notes: '' }); }
function getKindroidCredential() { return String(state.kindroidApiKey || sessionStorage.getItem('lifeline.kindroid.sessionApiKey') || localStorage.getItem(KINDROID_API_KEY_STORAGE_KEY) || '').trim(); }
function rememberKindroidCredential(key) { state.kindroidApiKey = String(key || '').trim(); return rememberKindroidApiKey(); }
function forgetKindroidCredential() { state.kindroidApiKey = ''; state.kindroidConnected = false; sessionStorage.removeItem('lifeline.kindroid.sessionApiKey'); localStorage.removeItem(KINDROID_API_KEY_STORAGE_KEY); }
class KindroidApiClient { constructor({ getCredential } = {}) { this.getCredential = getCredential || getKindroidCredential; this.active = new Map(); this.logs = []; } cancel(requestId) { this.active.get(requestId)?.abort(); } async execute(operationKey, values = {}, options = {}) { return executeKindroidOperation(operationKey, values, options); } }
const kindroidApiClient = new KindroidApiClient();
function cancelKindroidRequest(requestId) { kindroidApiClient.cancel(requestId); }
async function executeKindroidOperation(operationKey, values = {}, options = {}) { const operation = getKindroidOperation(operationKey); const request = buildKindroidRequest(operationKey, values); const key = getKindroidCredential(); if (!key.startsWith('kn_')) return normalizeKindroidError(operationKey, new Error('A local Kindroid API key starting with kn_ is required.'), { status: 401 }); const controller = new AbortController(); const requestId = options.requestId || `${operationKey}_${Date.now()}`; kindroidApiClient.active.set(requestId, controller); const timeout = setTimeout(() => controller.abort(new DOMException('Kindroid request timeout', 'AbortError')), options.timeoutMs || request.timeoutMs); const started = performance.now(); const requestedAt = new Date().toISOString(); try { const url = new URL(request.url); Object.entries(request.query).forEach(([k,v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v)); }); const headers = { ...request.headers, Authorization: `Bearer ${key}` }; const fetchOptions = { method: request.method, headers, signal: controller.signal }; if (request.method !== 'GET') fetchOptions.body = JSON.stringify(request.body); const response = await fetch(url, fetchOptions); const result = await normalizeKindroidResponse(operationKey, response, { started, requestedAt, onStreamChunk: options.onStreamChunk, stream: values.stream || options.stream }); safeKindroidLog(operation, result, request.body); if (!result.ok) recordKindroidTestResult(result); return result; } catch (error) { const normalized = normalizeKindroidError(operationKey, error); safeKindroidLog(operation, normalized, request.body); return normalized; } finally { clearTimeout(timeout); kindroidApiClient.active.delete(requestId); } }
async function normalizeKindroidResponse(operationKey, response, context = {}) { const operation = getKindroidOperation(operationKey); const headers = Object.fromEntries(response.headers.entries()); let rawText = ''; let data = null; const isStreaming = (context.stream || false) && operation.supportsStreaming && response.body; if (isStreaming) { const reader = response.body.getReader(); const decoder = new TextDecoder(); const chunks = []; while (true) { const { value, done } = await reader.read(); if (done) break; const chunk = decoder.decode(value, { stream:true }); chunks.push(chunk); context.onStreamChunk?.(chunk); } rawText = chunks.join(''); data = rawText; } else { rawText = await response.text(); if (operation.responseType === 'json') { try { data = rawText ? JSON.parse(rawText) : null; } catch (e) { return { ...normalizeKindroidError(operationKey, e, { status: response.status, rawText }), headers }; } } else data = rawText; } const base = { operationKey, status: response.status, responseType: operation.responseType, data, rawText, headers, durationMs: Math.round(performance.now() - context.started), requestedAt: context.requestedAt, completedAt: new Date().toISOString() }; if (!response.ok) return { ...base, ...normalizeKindroidError(operationKey, new Error(rawText || response.statusText), { status: response.status, rawText }) }; return { ok:true, ...base }; }
function safeKindroidLog(operation, result, body = {}) { kindroidApiClient.logs.push({ timestamp:new Date().toISOString(), operationKey:operation.key, method:operation.method, route:operation.endpoint, status:result.status||0, durationMs:result.durationMs||0, payloadKeys:Object.keys(body||{}), responseType:operation.responseType, resultCategory:result.ok?'success':result.category||'unknown', ...(state.apiStudioDebug ? { debug:redactKindroidData({ body, result }) } : {}) }); }
function fetchKindroidMessagesPage(options = {}) { const values = { limit: options.limit || 25, start_after_timestamp: options.cursor || '' }; values[options.conversationType === 'group' ? 'group_id' : 'ai_id'] = options.conversationId; return executeKindroidOperation('get_chat_messages', values, { requestId: options.requestId }); }
function normalizeKindroidMessage(message = {}, context = {}) { return { id:String(message.id || message.message_id || `${context.conversationId || ''}_${message.timestamp || ''}`), conversationType:context.conversationType || (context.group_id ? 'group':'individual'), conversationId:String(context.conversationId || context.ai_id || context.group_id || ''), senderId:String(message.senderId || message.sender_id || message.ai_id || ''), senderType:String(message.senderType || message.sender_type || (message.is_user ? 'user' : 'ai')), displayName:String(message.displayName || message.display_name || message.name || ''), timestamp:Number(message.timestamp || message.created_at || 0) || 0, text:String(message.text || message.message || message.content || ''), imageUrls:Array.isArray(message.imageUrls)?message.imageUrls:(message.image_url?[message.image_url]:[]), imageDescription:String(message.imageDescription || message.image_description || ''), videoDescription:String(message.videoDescription || message.video_description || ''), internetResponse:String(message.internetResponse || message.internet_response || ''), linkUrl:String(message.linkUrl || message.link_url || ''), linkDescription:String(message.linkDescription || message.link_description || ''), raw:message }; }
function mergeKindroidMessagePages(existing = [], incoming = []) { const byId = new Map(existing.map(m=>[m.id || `${m.timestamp}_${m.text}`, m])); incoming.forEach(m=>byId.set(m.id || `${m.timestamp}_${m.text}`, m)); return [...byId.values()].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0)); }


Object.assign(window, { KINDROID_API_REGISTRY: ALL_KINDROID_OPERATIONS, KindroidApiClient, kindroidApiClient, getKindroidOperation, listKindroidOperations, validateKindroidOperation, buildKindroidRequest, executeKindroidOperation, cancelKindroidRequest, normalizeKindroidResponse, normalizeKindroidError, redactKindroidData, recordKindroidTestResult, fetchKindroidMessagesPage, normalizeKindroidMessage, mergeKindroidMessagePages, getKindroidCredential, rememberKindroidCredential, forgetKindroidCredential });

function kindroidGroupCallUrl(groupId) {
  const cleanGroupId = String(groupId || '').trim().replace(/^\/+|\/+$/g, '');
  if (!cleanGroupId) return '';
  return `https://kindroid.ai/v2/call/group/${encodeURIComponent(cleanGroupId)}/`;
}

function rememberGroupmakerTab(groupId, tabRef) {
  if (tabRef && !tabRef.closed) groupmakerKindroidTabs.set(String(groupId), tabRef);
}

function openPreparedGroupmakerTab(tabRef, groupId) {
  const url = kindroidGroupCallUrl(groupId);
  if (!url) return false;
  if (window.lifelineElectron?.openKindroidCall) {
    window.lifelineElectron.openKindroidCall({ url, groupId, accessKey: state.accessKey, session: reconnectGroupmakerSession() }).catch(() => {});
    return true;
  }
  const rememberedTab = groupmakerKindroidTabs.get(String(groupId));
  if (rememberedTab && !rememberedTab.closed) {
    try { rememberedTab.focus(); } catch {}
    return true;
  }
  if (rememberedTab?.closed) groupmakerKindroidTabs.delete(String(groupId));
  if (tabRef && !tabRef.closed) {
    tabRef.location.href = url;
    try { tabRef.focus(); } catch {}
    rememberGroupmakerTab(groupId, tabRef);
    return true;
  }
  const opened = window.open(url, '_blank');
  rememberGroupmakerTab(groupId, opened);
  return Boolean(opened);
}

function coerceGroupId(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim().replace(/^\/+|\/+$/g, '');
  if (!candidate) return '';
  const urlMatch = candidate.match(/\/(?:v2\/)?(?:call|chat)\/group\/([A-Za-z0-9_-]{8,})\/?/);
  if (urlMatch) return urlMatch[1];
  return /^[A-Za-z0-9_-]{8,}$/.test(candidate) ? candidate : '';
}

function extractGroupId(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const fromObject = (value) => {
    const direct = coerceGroupId(value);
    if (direct) return direct;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = fromObject(item);
        if (found) return found;
      }
      return '';
    }
    if (!value || typeof value !== 'object') return '';
    for (const key of ['group_id', 'groupchat_id', 'groupChatId', 'groupId', 'id']) {
      const found = coerceGroupId(value[key]);
      if (found) return found;
    }
    for (const key of ['data', 'group', 'groupchat', 'group_chat', 'result']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = fromObject(value[key]);
        if (found) return found;
      }
    }
    for (const item of Object.values(value)) {
      const found = fromObject(item);
      if (found) return found;
    }
    return '';
  };

  try {
    const found = fromObject(JSON.parse(raw));
    if (found) return found;
  } catch {}

  const urlMatch = raw.match(/\/(?:v2\/)?(?:call|chat)\/group\/([A-Za-z0-9_-]{8,})\/?/);
  if (urlMatch) return urlMatch[1];
  const tokenMatch = raw.match(/([A-Za-z0-9_-]{8,})/);
  return tokenMatch ? tokenMatch[1] : '';
}

async function legacyKindroidRequest(toolKey, endpointPath, payload) {
  const operationKey = endpointPath === '/groupchats-update' ? 'group_update' : endpointPath === '/groupchats-create' ? 'create_groupchat_current_discovery' : toolKey;
  const result = await kindroidApiClient.execute(operationKey, payload);
  if (!result.ok) throw new Error(result.message || `${operationKey} failed (${result.status || 0})`);
  return { status: result.status, detail: result.rawText || String(result.data || ''), groupIdSource: [result.rawText, result.headers?.location, result.headers?.Location].filter(Boolean).join('\n') };
}


function ensureEntry(entry) {
  delete entry.rank;
  delete entry.responsibilities;
  delete entry.fetch_rules;
  if (entry.activity === undefined && entry.position !== undefined) entry.activity = entry.position;
  delete entry.position;
  Object.entries(DEFAULT_ENTRY).forEach(([key, value]) => {
    if (entry[key] === undefined) entry[key] = Array.isArray(value) ? [...value] : value;
  });
  if (!String(entry.directory_uid || '').trim()) entry.directory_uid = newDirectoryUid();
  if (String(entry.ai_id || '').endsWith('\\')) entry.ai_id = String(entry.ai_id).replace(/\\+$/g, '').trim();
  return entry;
}


function generationPeople() {
  if (!Array.isArray(state.config.generations_people)) state.config.generations_people = [];
  state.config.generations_people = state.config.generations_people.filter((person) => person && typeof person === 'object');
  return state.config.generations_people;
}

function generationId() {
  return `g_${Date.now().toString(16)}_${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
}

function normalizedGenerationName(value) {
  return String(value || '').trim().replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();
}

function findGenerationPersonForEntry(entry) {
  if (!entry) return null;
  const directoryUid = String(entry.directory_uid || '').trim();
  const aiId = String(entry.ai_id || '').trim();
  const name = normalizedGenerationName(entry.name);
  const people = generationPeople();
  return people.find((person) => directoryUid && String(person.directory_uid || '').trim() === directoryUid)
    || people.find((person) => !String(person.directory_uid || '').trim() && aiId && String(person.directory_ai_id || '').trim() === aiId)
    || people.find((person) => !String(person.directory_uid || '').trim() && name && normalizedGenerationName(person.name) === name)
    || null;
}

function ensureGenerationPerson(entry) {
  const people = generationPeople();
  let person = findGenerationPersonForEntry(entry);
  if (!person) {
    person = { id: generationId(), parents: [], children: [], album_photos: [] };
    people.push(person);
  }
  if (!String(person.id || '').trim()) person.id = generationId();
  if (!Array.isArray(person.parents)) person.parents = [];
  if (!Array.isArray(person.children)) person.children = [];
  delete person.rank;
  person.directory_uid = String(entry.directory_uid || '').trim();
  person.directory_ai_id = String(entry.ai_id || '').trim();
  person.name = String(entry.name || '').trim();
  person.status = String(person.status || '').trim();
  person.sex = String(person.sex || entry.gender || '').trim();
  person.notes = String(person.notes || '').trim();
  return person;
}

function mirrorGenerationRelationsToDirectory(person) {
  const directoryUid = String(person?.directory_uid || '').trim();
  const entry = entries().find((candidate) => String(candidate.directory_uid || '').trim() === directoryUid);
  if (!entry) return;
  const byId = generationById();
  const stableRelationshipIds = (ids) => (Array.isArray(ids) ? ids : []).map((id) => {
    const relative = byId.get(String(id || '').trim());
    return String(relative?.directory_uid || relative?.id || id || '').trim();
  }).filter(Boolean);
  entry.family_relationships = {
    parents: stableRelationshipIds(person.parents),
    children: stableRelationshipIds(person.children),
  };
}

function syncGenerationPeopleWithDirectory() {
  const directoryEntries = entries().map(ensureEntry);
  directoryEntries.forEach(ensureGenerationPerson);
  const people = generationPeople();
  const canonicalByUid = new Map(directoryEntries.map((entry) => {
    const uid = String(entry.directory_uid || '').trim();
    return [uid, people.find((person) => String(person.directory_uid || '').trim() === uid)];
  }).filter(([uid, person]) => uid && person));
  const peopleById = new Map(people.map((person) => [String(person.id || '').trim(), person]));
  directoryEntries.forEach((entry) => {
    const person = canonicalByUid.get(String(entry.directory_uid || '').trim());
    const savedRelations = entry.family_relationships && typeof entry.family_relationships === 'object' ? entry.family_relationships : null;
    if (!person || !savedRelations) return;
    const resolveIds = (tokens) => [...new Set((Array.isArray(tokens) ? tokens : []).map((token) => {
      const value = String(token || '').trim();
      return peopleById.get(value)?.id || canonicalByUid.get(value)?.id || '';
    }).filter((id) => id && id !== person.id))];
    if (Array.isArray(savedRelations.parents)) person.parents = resolveIds(savedRelations.parents);
    if (Array.isArray(savedRelations.children)) person.children = resolveIds(savedRelations.children);
  });
  const canonicalPeople = new Set(canonicalByUid.values());
  const replacementIds = new Map();
  people.forEach((source) => {
    if (canonicalPeople.has(source)) return;
    const sourceUid = String(source.directory_uid || '').trim();
    const sourceAiId = String(source.directory_ai_id || '').trim();
    const sourceName = normalizedGenerationName(source.name);
    const target = canonicalByUid.get(sourceUid)
      || [...canonicalPeople].find((person) => sourceAiId && String(person.directory_ai_id || '').trim() === sourceAiId)
      || [...canonicalPeople].find((person) => sourceName && normalizedGenerationName(person.name) === sourceName);
    if (!target || target === source) return;
    target.parents = [...new Set([...(target.parents || []), ...(source.parents || [])])];
    target.children = [...new Set([...(target.children || []), ...(source.children || [])])];
    if (!target.pregnancy && source.pregnancy) target.pregnancy = source.pregnancy;
    if (!target.sex && source.sex) target.sex = source.sex;
    if (!target.notes && source.notes) target.notes = source.notes;
    const sourceId = String(source.id || '').trim();
    const targetId = String(target.id || '').trim();
    if (sourceId && targetId) replacementIds.set(sourceId, targetId);
  });
  if (replacementIds.size) {
    state.config.generations_people = people.filter((person) => !replacementIds.has(String(person.id || '').trim()));
    generationPeople().forEach((person) => {
      const personId = String(person.id || '').trim();
      person.parents = [...new Set((person.parents || []).map((id) => replacementIds.get(String(id || '').trim()) || String(id || '').trim()).filter((id) => id && id !== personId))];
      person.children = [...new Set((person.children || []).map((id) => replacementIds.get(String(id || '').trim()) || String(id || '').trim()).filter((id) => id && id !== personId))];
      if (person.pregnancy?.partner_id) person.pregnancy.partner_id = replacementIds.get(String(person.pregnancy.partner_id).trim()) || person.pregnancy.partner_id;
    });
  }
  const byId = generationById();
  generationPeople().forEach((person) => {
    const personId = String(person.id || '').trim();
    cleanGenerationIds(person.parents, personId).forEach((parentId) => {
      const parent = byId.get(parentId);
      parent.children = [...new Set([...cleanGenerationIds(parent.children, parentId), personId])];
    });
    cleanGenerationIds(person.children, personId).forEach((childId) => {
      const child = byId.get(childId);
      child.parents = [...new Set([...cleanGenerationIds(child.parents, childId), personId])];
    });
  });
  generationPeople().forEach(mirrorGenerationRelationsToDirectory);
  return generationPeople();
}

function generationById() {
  return new Map(generationPeople().filter((person) => String(person.id || '').trim()).map((person) => [String(person.id).trim(), person]));
}

function cleanGenerationIds(ids, selfId = '') {
  const byId = generationById();
  const byDirectoryUid = new Map(generationPeople().map((person) => [String(person.directory_uid || '').trim(), String(person.id || '').trim()]).filter(([uid, id]) => uid && id));
  const seen = new Set();
  return (Array.isArray(ids) ? ids : String(ids || '').split(/[\n,]+/))
    .map((id) => String(id || '').trim())
    .map((id) => byId.has(id) ? id : byDirectoryUid.get(id) || '')
    .filter((id) => id && id !== selfId && byId.has(id) && !seen.has(id) && seen.add(id));
}

function setGenerationRelations(person, relationKey, selectedIds) {
  const personId = String(person?.id || '').trim();
  if (!personId || !['parents', 'children'].includes(relationKey)) return [];
  const reciprocalKey = relationKey === 'parents' ? 'children' : 'parents';
  const previousIds = cleanGenerationIds(person[relationKey], personId);
  const nextIds = cleanGenerationIds(selectedIds, personId);
  const nextSet = new Set(nextIds);
  [...new Set([...previousIds, ...nextIds])].forEach((relativeId) => {
    const relative = generationById().get(relativeId);
    if (!relative) return;
    const reciprocalIds = cleanGenerationIds(relative[reciprocalKey], relativeId).filter((id) => id !== personId);
    if (nextSet.has(relativeId)) reciprocalIds.push(personId);
    relative[reciprocalKey] = [...new Set(reciprocalIds)];
    mirrorGenerationRelationsToDirectory(relative);
  });
  person[relationKey] = nextIds;
  mirrorGenerationRelationsToDirectory(person);
  return nextIds;
}

function setDirectoryFamilyRelations(entry, relationKey, selectedDirectoryUids) {
  const entryUid = String(entry?.directory_uid || '').trim();
  if (!entryUid || !['parents', 'children'].includes(relationKey)) return;
  const reciprocalKey = relationKey === 'parents' ? 'children' : 'parents';
  const validUids = new Set(entries().map((person) => String(person.directory_uid || '').trim()).filter((uid) => uid && uid !== entryUid));
  const selected = [...new Set(selectedDirectoryUids.map((uid) => String(uid || '').trim()).filter((uid) => validUids.has(uid)))];
  const previous = new Set(Array.isArray(entry.family_relationships?.[relationKey]) ? entry.family_relationships[relationKey] : []);
  entry.family_relationships = { parents: [], children: [], ...(entry.family_relationships || {}), [relationKey]: selected };
  new Set([...previous, ...selected]).forEach((relativeUid) => {
    const relative = entries().find((person) => String(person.directory_uid || '').trim() === relativeUid);
    if (!relative) return;
    const reciprocal = new Set(Array.isArray(relative.family_relationships?.[reciprocalKey]) ? relative.family_relationships[reciprocalKey] : []);
    if (selected.includes(relativeUid)) reciprocal.add(entryUid);
    else reciprocal.delete(entryUid);
    relative.family_relationships = { parents: [], children: [], ...(relative.family_relationships || {}), [reciprocalKey]: [...reciprocal] };
  });
  persistLocalConfig(`Local ${relationKey} update: ${entry.name || entryUid}`);
  setGenerationRelations(ensureGenerationPerson(entry), relationKey, selected);
}

function generationOptions(selectedIds = [], selfId = '') {
  const selected = new Set(cleanGenerationIds(selectedIds, selfId));
  const candidates = entries().map((entry) => ({ entry, person: ensureGenerationPerson(entry) })).filter(({ person }) => String(person.id || '').trim() !== selfId);
  return candidates.sort((left, right) => String(left.entry.name || '').localeCompare(String(right.entry.name || ''))).map(({ entry, person }) => {
    const id = String(person.id).trim();
    const value = String(entry.directory_uid || '').trim();
    const label = String(entry.name || 'Unnamed').trim();
    return `<label class="relation-choice" data-relation-name="${escapeHtml(label.toLowerCase())}"><input type="checkbox" value="${escapeHtml(value)}" ${selected.has(id) ? 'checked' : ''}/><span>${escapeHtml(label)}</span><small>Directory person</small></label>`;
  }).join('') || '<div class="empty small">Sync more people into GENERATIONS before linking relatives.</div>';
}

function describeGenerationPerson(id) {
  const person = generationById().get(id);
  if (!person) return 'Unknown';
  return String(person.name || 'Unnamed').trim();
}

function relationList(ids) {
  return ids.length ? ids.map((id) => `<li><span>${escapeHtml(describeGenerationPerson(id))}</span></li>`).join('') : '<li class="muted">None linked yet.</li>';
}

function treeDataForGeneration(focus) {
  const byId = generationById();
  const focusId = String(focus?.id || '').trim();
  if (!focusId) return { rows: [], edges: [] };
  const parents = cleanGenerationIds(focus.parents, focusId);
  const children = cleanGenerationIds(focus.children, focusId);
  const grandparents = parents.flatMap((id) => cleanGenerationIds(byId.get(id)?.parents || [], id)).filter((id, index, all) => all.indexOf(id) === index);
  const grandchildren = children.flatMap((id) => cleanGenerationIds(byId.get(id)?.children || [], id)).filter((id, index, all) => all.indexOf(id) === index);
  const rows = [grandparents, parents, [focusId], children, grandchildren].map((ids) => ids.map((id) => byId.get(id)).filter(Boolean)).filter((row) => row.length);
  const included = new Set(rows.flat().map((person) => String(person.id).trim()));
  const edges = [];
  included.forEach((id) => cleanGenerationIds(byId.get(id)?.children || [], id).forEach((childId) => { if (included.has(childId)) edges.push([id, childId]); }));
  return { rows, edges };
}

function generationTreeMarkup(focus) {
  const { rows, edges } = treeDataForGeneration(focus);
  if (!rows.length) return '<div class="empty small">No linked family tree found yet. Link parents or children below.</div>';
  return `<div class="tree-board" style="--tree-rows:${rows.length}">${rows.map((row) => `<div class="tree-row">${row.map((person) => `<div class="tree-node ${person.id === focus.id ? 'focus' : ''}"><b>${escapeHtml(person.name || 'Unnamed')}</b><small>${escapeHtml(person.sex || person.id)}</small></div>`).join('')}</div>`).join('')}<div class="tree-edges">${edges.map(([from, to]) => `<span>${escapeHtml(describeGenerationPerson(from))} → ${escapeHtml(describeGenerationPerson(to))}</span>`).join('')}</div></div>`;
}

function refreshGenerationRelationshipDisplay(person) {
  const parents = cleanGenerationIds(person.parents, person.id);
  const children = cleanGenerationIds(person.children, person.id);
  const tree = document.querySelector('#generations-section .tree-board');
  if (tree) tree.outerHTML = generationTreeMarkup({ ...person, parents, children });
  const parentPills = document.querySelector('#generation-parent-pills');
  const childPills = document.querySelector('#generation-child-pills');
  if (parentPills) parentPills.innerHTML = relationList(parents);
  if (childPills) childPills.innerHTML = relationList(children);
  const counts = document.querySelectorAll('#generations-section .generation-summary b');
  if (counts[0]) counts[0].textContent = String(parents.length);
  if (counts[1]) counts[1].textContent = String(children.length);
}

function renderGenerationsSection(entry) {
  syncGenerationPeopleWithDirectory();
  const person = ensureGenerationPerson(entry);
  const parents = cleanGenerationIds(person.parents, person.id);
  const children = cleanGenerationIds(person.children, person.id);
  const pregnancy = person.pregnancy && typeof person.pregnancy === 'object'
    ? person.pregnancy
    : entry?.pregnancy && typeof entry.pregnancy === 'object' ? entry.pregnancy : {};
  const pregnant = pregnancy.active === true;
  const rawProgress = Number(String(pregnancy.progress ?? '').replace(/%$/, ''));
  const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, rawProgress)) : 0;
  const partnerId = String(pregnancy.partner_id || '').trim();
  const partnerChoices = entries()
    .filter((candidate) => String(candidate.directory_uid || '').trim() !== String(entry.directory_uid || '').trim())
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')))
    .map((candidate) => { const candidatePerson = ensureGenerationPerson(candidate); return `<option value="${escapeHtml(candidatePerson.id || '')}" ${String(candidatePerson.id || '').trim() === partnerId ? 'selected' : ''}>${escapeHtml(candidate.name || 'Unnamed person')}</option>`; })
    .join('');
  const unknownPartnerChoice = partnerId && !generationById().has(partnerId) ? `<option value="${escapeHtml(partnerId)}" selected>${escapeHtml(partnerId)}</option>` : '';
  return `<section id="generations-section" class="generations-card tab-panel ${state.activeEntryTab === 'family' ? 'active' : ''}"><div><p class="eyebrow">FAMILY MAP</p><h3>Relationships & household</h3><p class="sync-note">Build ancestry, pregnancy, and descendant details saved in config.json as generations_people.</p></div>${generationTreeMarkup({ ...person, parents, children })}<div class="generation-summary"><div><b>${parents.length}</b><span>Parents</span></div><div><b>${children.length}</b><span>Children</span></div></div><section class="pregnancy-card ${pregnant ? 'active' : ''}"><div class="pregnancy-head"><div><p class="eyebrow">PREGNANCY</p><h4>${pregnant ? 'Currently pregnant' : 'Not currently pregnant'}</h4><p>Set the current status, partner, and pregnancy progression used by the Memory update.</p></div><div class="pregnancy-actions"><label class="pregnancy-toggle"><input id="generation-pregnant" type="checkbox" ${pregnant ? 'checked' : ''}><span>${pregnant ? 'ON' : 'OFF'}</span></label><button id="save-pregnancy" type="button">SAVE PREGNANCY</button></div></div><div class="pregnancy-controls"><label><span>PARTNER</span><select id="generation-pregnancy-partner" ${pregnant ? '' : 'disabled'}><option value="">Not specified</option>${unknownPartnerChoice}${partnerChoices}</select></label><label><span>PROGRESSION</span><div class="pregnancy-progress"><input id="generation-pregnancy-progress" type="range" min="0" max="100" step="1" value="${progress}" ${pregnant ? '' : 'disabled'}><input id="generation-pregnancy-percent" type="number" min="0" max="100" step="1" value="${progress}" aria-label="Pregnancy progression percentage" ${pregnant ? '' : 'disabled'}><b>%</b></div></label></div></section><form id="generation-form" class="field-grid generation-form"><label><span>SEX</span><input data-generation-field="sex" value="${escapeHtml(person.sex || '')}" /></label><label class="wide"><span>NOTES</span><textarea data-generation-field="notes">${escapeHtml(person.notes || '')}</textarea></label></form><div class="relations-grid"><section class="relation-card"><div class="relation-card-head"><span>↑</span><div><h4>Parents & ancestry</h4><p>Choose people who sit above this profile.</p></div></div><ul id="generation-parent-pills" class="relation-pills">${relationList(parents)}</ul><input id="generation-parent-search" class="relation-search" type="search" placeholder="Search every Directory person…" aria-label="Search possible parents"><div id="generation-parents" class="relation-picker">${generationOptions(parents, person.id)}</div></section><section class="relation-card"><div class="relation-card-head"><span>↓</span><div><h4>Children & descendants</h4><p>Choose people directly below this profile.</p></div></div><ul id="generation-child-pills" class="relation-pills">${relationList(children)}</ul><input id="generation-child-search" class="relation-search" type="search" placeholder="Search every Directory person…" aria-label="Search possible children"><div id="generation-children" class="relation-picker">${generationOptions(children, person.id)}</div></section></div></section>`;
}

function familyMemoryForEntry(entry) {
  syncGenerationPeopleWithDirectory();
  const focus = findGenerationPersonForEntry(entry);
  if (!focus || !String(focus.id || '').trim()) return { text: '', reason: 'No GENERATIONS profile is linked to this Directory person.' };
  const focusId = String(focus.id).trim();
  const people = generationPeople();
  const byId = generationById();
  const name = String(focus.name || entry?.name || 'This person').trim();
  const generationPregnancy = focus.pregnancy;
  const directoryPregnancy = entry?.pregnancy;
  const pregnancy = [generationPregnancy, directoryPregnancy].find((value) => value && typeof value === 'object' && value.active === true);
  const pregnancySentences = [];
  const conversationalName = (value, fallback) => {
    const cleaned = String(value || '').trim().replace(/^[^\p{L}\p{N}]+/u, '').trim();
    return cleaned ? cleaned.split(/\s+/)[0] : fallback;
  };
  const firstName = conversationalName(name, 'This person');
  if (pregnancy) {
    const rawProgress = typeof pregnancy.progress === 'string' ? pregnancy.progress.trim().replace(/%$/, '') : pregnancy.progress;
    const parsedProgress = Number(rawProgress);
    const hasProgress = rawProgress !== undefined && rawProgress !== null && String(rawProgress).trim() !== '';
    const progress = hasProgress && Number.isFinite(parsedProgress) ? Math.max(0, Math.min(100, parsedProgress)) : null;
    const partnerReference = String(pregnancy.partner_id || '').trim();
    let partnerName = '';
    if (partnerReference) {
      const partner = byId.get(partnerReference) || people.find((person) =>
        String(person.directory_ai_id || '').trim() === partnerReference
        || String(person.name || '').trim().toLowerCase() === partnerReference.toLowerCase()
      );
      partnerName = conversationalName(partner?.name || partnerReference, '');
    }
    const partnerPhrase = partnerName ? ` with ${partnerName}${/s$/i.test(partnerName) ? "'" : "'s"} baby` : '';
    const progressPhrase = progress === null
      ? ''
      : `, and the pregnancy is about ${Number.isInteger(progress) ? progress : progress.toFixed(1)}% along`;
    pregnancySentences.push(`${firstName} is currently pregnant${partnerPhrase}${progressPhrase}.`);
  } else {
    pregnancySentences.push(`${firstName} is not currently pregnant.`);
  }
  const children = people.filter((person) => {
    const childId = String(person.id || '').trim();
    return childId && childId !== focusId && (
      cleanGenerationIds(focus.children, focusId).includes(childId)
      || cleanGenerationIds(person.parents, childId).includes(focusId)
    );
  });
  const childrenByPartner = new Map();
  children.forEach((child) => {
    const childId = String(child.id).trim();
    const linkedParentIds = cleanGenerationIds(child.parents, childId).filter((id) => id !== focusId);
    const sharedChildIds = people.filter((candidate) => {
      const candidateId = String(candidate.id || '').trim();
      return candidateId && candidateId !== focusId && candidateId !== childId
        && cleanGenerationIds(candidate.children, candidateId).includes(childId);
    }).map((candidate) => String(candidate.id).trim());
    [...new Set([...linkedParentIds, ...sharedChildIds])].forEach((partnerId) => {
      if (!byId.has(partnerId)) return;
      const partnerChildren = childrenByPartner.get(partnerId) || [];
      if (!partnerChildren.some((person) => String(person.id).trim() === childId)) partnerChildren.push(child);
      childrenByPartner.set(partnerId, partnerChildren);
    });
  });
  const childRole = (child) => {
    const childSex = String(child.sex || '').trim().toLowerCase();
    if (/female|woman|girl|daughter|she|her/.test(childSex)) return 'daughter';
    if (/male|man|boy|son|he|his/.test(childSex)) return 'son';
    return 'child';
  };
  const sex = String(focus.sex || entry?.gender || '').trim().toLowerCase();
  const feminine = /female|woman|girl|mother|she|her/.test(sex);
  const masculine = /male|man|boy|father|he|his/.test(sex);
  const pronoun = feminine ? 'her' : masculine ? 'his' : 'their';
  const partnerRole = feminine ? "the children's father" : masculine ? "the children's mother" : "the children's other parent";
  const partneredChildIds = new Set([...childrenByPartner.values()].flat().map((child) => String(child.id || '').trim()));
  const familySentences = [...childrenByPartner.entries()]
    .sort(([left], [right]) => String(byId.get(left)?.name || '').localeCompare(String(byId.get(right)?.name || '')))
    .map(([partnerId, partnerChildren]) => {
      const partnerName = String(byId.get(partnerId)?.name || 'Unknown partner').trim();
      const childNames = partnerChildren.map((child) => String(child.name || 'Unnamed child').trim());
      const childWord = childNames.length === 1 ? 'child' : 'children';
      const names = childNames.length === 1 ? childNames[0] : `${childNames.slice(0, -1).join(', ')} and ${childNames.at(-1)}`;
      return `${name}, through ${pronoun} life, had ${childNames.length} ${childWord} with ${pronoun} partner ${partnerName}, ${partnerRole}. ${childNames.length === 1 ? 'The child is' : 'The children are'} named ${names}.`;
    });
  children.filter((child) => !partneredChildIds.has(String(child.id || '').trim())).forEach((child) => {
    familySentences.push(`${firstName} has a ${childRole(child)} named ${String(child.name || 'Unnamed child').trim()}.`);
  });
  return { text: [...pregnancySentences, ...familySentences].join('\n'), reason: '' };
}

async function updateFamilyMemory(entry) {
  flushDirectoryEditorToEntry(entry);
  const generated = familyMemoryForEntry(entry);
  if (!generated.text) {
    alert(`Memory was not updated. ${generated.reason}`);
    return;
  }
  entry.ai_memory = generated.text;
  const memoryField = document.querySelector('[data-field="ai_memory"]');
  if (memoryField) memoryField.value = generated.text;
  await saveBridge('Update family memory from GENERATIONS');
}

function bridgeUrl(path = BRIDGE_PATH, includeRef = true) {
  const encodedPath = encodeURIComponent(path).replaceAll('%2F', '/');
  const refQuery = includeRef ? `?ref=${BRIDGE_BRANCH}` : '';
  return `https://api.github.com/repos/${GITHUB_OWNER}/${BRIDGE_REPO}/contents/${encodedPath}${refQuery}`;
}

async function githubRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${state.accessKey}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload.message || `GitHub request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function ensureGroupTranscript(groupId, participants, retryOnConflict = true) {
  const id = String(groupId || '').trim();
  const names = [...new Set((Array.isArray(participants) ? participants : []).map((name) => String(name || '').trim()).filter(Boolean))];
  if (!id || !names.length) return;
  const path = `transcripts/${id}/transcript.json`;
  let sha = '';
  let current = null;
  try {
    const file = await githubRequest(bridgeUrl(path));
    sha = String(file.sha || '');
    current = decodeBase64(file.content || '');
  } catch (error) {
    if (!/not found/i.test(String(error?.message || ''))) throw error;
  }
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const transcript = Array.isArray(base.transcript) ? base.transcript : [];
  const doc = { ...base, version: 2, group_id: id, participants: names, transcript };
  if (JSON.stringify(base) === JSON.stringify(doc)) return;
  try {
    await githubRequest(bridgeUrl(path, false), {
      method: 'PUT',
      body: JSON.stringify({
        message: `Initialize group transcript ${id} participants via LIFELINE frontend`,
        branch: BRIDGE_BRANCH,
        content: encodeBase64(doc),
        ...(sha ? { sha } : {}),
      }),
    });
  } catch (error) {
    if (!retryOnConflict || !isGithubShaMismatch(error)) throw error;
    await ensureGroupTranscript(id, names, false);
  }
}

async function readGithubContentFile(path) {
  const file = await githubRequest(bridgeUrl(path));
  let content = typeof file.content === 'string' ? file.content : '';
  if (!content.trim() && file.git_url) {
    const blob = await githubRequest(file.git_url);
    content = typeof blob.content === 'string' ? blob.content : '';
  }
  if (!content.trim()) {
    throw new Error(`GitHub returned no readable content for ${path}. The file metadata was found, but the blob body was empty.`);
  }
  return { sha: file.sha || '', config: normalizeImported(decodeBase64(content)) };
}

async function readGithubJsonFile(path) {
  const file = await githubRequest(bridgeUrl(path));
  let content = typeof file.content === 'string' ? file.content : '';
  if (!content.trim() && file.git_url) content = String((await githubRequest(file.git_url)).content || '');
  if (!content.trim()) throw new Error(`GitHub returned no readable content for ${path}.`);
  return decodeBase64(content);
}

async function syncJournalWiki({ save = true } = {}) {
  if (state.journalWikiSync.busy) return;
  state.journalWikiSync = { ...state.journalWikiSync, busy: true, status: `Reading ${JOURNAL_BRIDGE_PATH}…` };
  if (state.authenticated) render();
  try {
    const result = mergeJournalIntoWiki(await readGithubJsonFile(JOURNAL_BRIDGE_PATH));
    state.journalWikiSync = { busy: false, status: result.changed ? `Imported ${result.changed} journal ${result.changed === 1 ? 'entry' : 'entries'}` : 'Journal wiki is up to date', imported: result.changed, total: result.total };
    if (result.changed && save) await saveBridge('Auto-populate wiki from Kindroid journal', true);
  } catch (error) {
    if (Number(error?.status) === 404) state.journalWikiSync = { busy: false, status: 'No journal.json found yet', imported: 0, total: 0 };
    else state.journalWikiSync = { ...state.journalWikiSync, busy: false, status: `Journal sync failed: ${error.message}` };
  }
  if (state.authenticated) render();
}

function isGithubShaMismatch(error) {
  const message = String(error?.message || '');
  return Number(error?.status) === 409
    || /does not match/i.test(message)
    || /sha/i.test(message) && /(match|supplied|required|missing)/i.test(message);
}

async function refreshBridgeSha() {
  try {
    const file = await githubRequest(bridgeUrl(BRIDGE_PATH));
    state.bridgeSha = String(file.sha || '');
  } catch (error) {
    if (Number(error?.status) !== 404) throw error;
    state.bridgeSha = '';
  }
  return state.bridgeSha;
}

async function writeBridgeConfig(reason, retryOnShaMismatch = true) {
  const snapshot = persistLocalConfig(reason);
  const payload = await writeBridgeSnapshotArchive(snapshot);
  return { payload, retried: false };
}

async function writeBridgeSnapshotArchive(snapshot, attempt = 0) {
  const stamp = String(snapshot?._lifeline_snapshot?.created_at || new Date().toISOString()).replace(/[^0-9]/g, '').slice(0, 17);
  const path = `snapshots/config_${stamp}_${SNAPSHOT_SESSION_ID}_${String(++snapshotSequence).padStart(6, '0')}.json`;
  try {
    return await githubRequest(bridgeUrl(path, false), {
      method: 'PUT',
      body: JSON.stringify({
        message: `Archive complete LIFELINE snapshot ${stamp}`,
        content: encodeBase64(snapshot),
        branch: BRIDGE_BRANCH,
      }),
    });
  } catch (error) {
    if (attempt >= 2 || !isGithubShaMismatch(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    return writeBridgeSnapshotArchive(snapshot, attempt + 1);
  }
}

async function readLatestBridgeSnapshot() {
  let files = [];
  try {
    const result = await githubRequest(bridgeUrl('snapshots'));
    files = Array.isArray(result) ? result : [];
  } catch (error) {
    if (!/not found/i.test(String(error?.message || ''))) throw error;
  }
  const latest = files.filter((file) => file?.type === 'file' && /^config_.*\.json$/.test(String(file.name || ''))).sort((left, right) => String(right.name).localeCompare(String(left.name)))[0];
  return latest ? readGithubContentFile(`snapshots/${latest.name}`) : null;
}

function scheduleDirectoryAutoSave(person, delay = 700) {
  persistLocalConfig(`Local Directory edit: ${person.name || person.directory_uid}`);
  clearTimeout(directoryAutoSaveTimer);
  directoryAutoSaveTimer = setTimeout(() => {
    flushDirectoryEditorToEntry(person);
    syncGenerationPeopleWithDirectory();
    queueBridgeSave(`Auto-save Directory person: ${person.name || person.directory_uid}`).catch((error) => {
      state.syncState = 'Save failed';
      state.syncDetail = error.message;
    });
  }, delay);
}

function decodeBase64(content) {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\n/g, '')), (c) => c.charCodeAt(0))));
}

function encodeBase64(payload) {
  const json = JSON.stringify(payload, null, 2);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function normalizeImported(payload) {
  if (Array.isArray(payload)) return { directory_entries: payload, journal_entries: [] };
  if (payload && typeof payload === 'object') return { ...payload, directory_entries: Array.isArray(payload.directory_entries) ? payload.directory_entries : [], journal_entries: Array.isArray(payload.journal_entries) ? payload.journal_entries : [] };
  throw new Error('Imported file must be a legacy config object or directory_entries array.');
}

async function loadBridge() {
  state.syncState = 'Syncing'; state.syncDetail = `Restoring directory from ${BRIDGE_REPO}/${BRIDGE_PATH}…`; render();
  let selectedCandidate = null;
  let lastError = null;
  const localSnapshot = localConfigSnapshot();
  try {
    const rootFile = await readGithubContentFile(BRIDGE_PATH);
    selectedCandidate = { path: BRIDGE_PATH, ...rootFile };
    const latestSnapshot = await readLatestBridgeSnapshot();
    if (latestSnapshot) selectedCandidate = { path: 'latest snapshot', ...latestSnapshot };
  } catch (error) {
    lastError = error;
  }
  if (selectedCandidate) {
    state.bridgeSha = '';
    state.config = selectedCandidate.config;
    entries().forEach(ensureEntry);
    syncGenerationPeopleWithDirectory();
    persistLocalConfig(`Startup restore from ${selectedCandidate.path}`);
    journalEntries();
    hydrateGroupmakerDraft();
    const dailyRollover = closeExpiredGroupmakerSessions();
    state.authenticated = true;
    state.syncState = 'Online';
    state.syncDetail = `Restored ${entries().length} directory entries from ${selectedCandidate.path}; local state is now authoritative for this session.`;
    if (dailyRollover) persistLocalConfig('Close expired daily GROUPMAKER sessions locally');
    await syncJournalWiki({ save: false });
    persistLocalConfig('Complete startup restore');
  } else if (localSnapshot) {
    state.config = localSnapshot;
    entries().forEach(ensureEntry);
    syncGenerationPeopleWithDirectory();
    state.authenticated = true;
    state.syncState = 'Local snapshot';
    state.syncDetail = `Root ${BRIDGE_PATH} was unavailable; continuing from the last complete local snapshot.`;
  } else if (lastError && !/not found/i.test(lastError.message)) {
    state.authenticated = false;
    state.syncState = 'Denied'; state.syncDetail = lastError.message;
  } else {
    state.config = { directory_entries: [], journal_entries: [] };
    hydrateGroupmakerDraft();
    state.bridgeSha = '';
    state.authenticated = true;
    state.syncState = 'New bridge'; state.syncDetail = `${BRIDGE_PATH} will be created on first save.`;
  }
  render();
}

async function saveBridge(reason = 'Update directory', throwOnError = false) {
  state.saving = true; state.syncState = 'Saving'; state.syncDetail = 'Archiving a complete local snapshot to GitHub…'; render();
  try {
    await queueBridgeSave(reason);
    state.syncState = 'Synced';
    state.syncDetail = `Archived a complete snapshot containing ${entries().length} Directory entries.`;
  } catch (error) {
    state.syncState = 'Save failed'; state.syncDetail = error.message;
    if (throwOnError) throw error;
  } finally {
    state.saving = false; render();
  }
}


async function saveBridgeQuiet(reason = 'Update directory') {
  try {
    await queueBridgeSave(reason);
    state.syncState = 'Synced';
    state.syncDetail = 'Archived a complete local snapshot.';
  } catch (error) {
    state.syncState = 'Draft save failed';
    state.syncDetail = error.message;
  }
}

function queueBridgeSave(reason, options = {}) {
  persistLocalConfig(reason);
  const write = async () => {
    const result = await writeBridgeConfig(reason);
    state.syncState = 'Synced';
    state.syncDetail = `Archived a complete snapshot containing ${entries().length} Directory entries.`;
    if (options.render) render();
    return result;
  };
  const queued = bridgeWriteQueue.then(write, write);
  bridgeWriteQueue = queued.catch(() => {});
  return queued;
}

function directoryPersonByUid(uid) { return entries().map(ensureEntry).find((person) => person.directory_uid === String(uid || '')) || null; }
function freshDirectorySyncState(uid) { return { open:true, busy:false, closing:false, action:'', personUid:uid, step:'Preparing', completedSteps:[], currentJournal:0, totalJournals:0, warnings:[], error:null, result:null, technical:null, retryBridgeSave:false }; }
function clearDirectorySyncAutoClose() { clearTimeout(directorySyncAutoCloseTimer); clearTimeout(directorySyncAnimationTimer); directorySyncAutoCloseTimer=null; directorySyncAnimationTimer=null; }
function openDirectoryKindroidActionModal(directoryUid) { if (!directoryPersonByUid(directoryUid)) return; clearDirectorySyncAutoClose(); state.directoryKindroidSync = freshDirectorySyncState(directoryUid); render(); }
function closeDirectoryKindroidActionModal() { if (state.directoryKindroidSync.busy) return; clearDirectorySyncAutoClose(); state.directoryKindroidSync.open = false; state.directoryKindroidSync.closing = false; render(); }
function autoCloseSuccessfulDirectoryUpdate() {
  clearDirectorySyncAutoClose();
  directorySyncAutoCloseTimer=setTimeout(() => {
    const sync=state.directoryKindroidSync;
    if (!sync.open || sync.busy || sync.action !== 'update' || !sync.result || sync.error || sync.retryBridgeSave) return;
    sync.closing=true;
    render();
    directorySyncAnimationTimer=setTimeout(() => {
      if (state.directoryKindroidSync === sync) { sync.open=false; sync.closing=false; render(); }
      clearDirectorySyncAutoClose();
    }, 720);
  }, 650);
}
function updateDirectorySyncProgress(step, completed) { const sync = state.directoryKindroidSync; if (completed && !sync.completedSteps.includes(completed)) sync.completedSteps.push(completed); sync.step = step; render(); }

function flushDirectoryEditorToEntry(person) {
  if (!person) return;
  if (person.directory_uid === state.selectedUid) document.querySelectorAll('[data-field]').forEach((input) => { person[input.dataset.field] = input.value; });
  ensureGenerationPerson(person);
}

function validateDirectoryKindroidAction(person, action) {
  const errors = [];
  if (!person?.directory_uid) errors.push('The Directory UID is missing.');
  if (action === 'rebuild') ['name','gender','backstory'].forEach((key) => { if (!String(person?.[key] || '').trim()) errors.push(`${key.replace('_',' ')} is required.`); });
  if (action === 'update' && !String(person?.ai_id || '').trim()) errors.push('An existing AI ID is required for Update.');
  if (['rebuild','update'].includes(action) && !getKindroidCredential().trim().startsWith('kn_')) errors.push('A valid Kindroid API key starting with kn_ is required. Open Settings to add it.');
  return { ok:!errors.length, errors };
}

function omitEmptyDirectoryValues(values) { return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')); }
function buildDirectoryCreatePayload(person) { return omitEmptyDirectoryValues({ ai_name:person.name, ai_gender:person.gender, ai_backstory:person.backstory, custom_greeting:person.greeting, ai_directive:person.directive, ai_avatar:person.avatar_preset, custom_avatar_description:person.avatar_description }); }
function withDirectoryInclusionMarkers(values) { const output = { ai_id:values.ai_id }; Object.entries(values).forEach(([key,value]) => { if (key === 'ai_id' || value === undefined || value === null || String(value).trim() === '') return; output[key] = value; output[`__include_${key}`] = 'set'; }); return output; }
function buildDirectoryOfficialUpdatePayload(person, aiId = person.ai_id) { return withDirectoryInclusionMarkers({ ai_id:aiId, ai_name:person.name, ai_gender:person.gender, ai_backstory:person.backstory, ai_memory:person.ai_memory, ai_directive:person.directive, ai_additional_context:person.additional_context, current_scene:person.activity }); }
function buildDirectoryExperimentalUpdatePayload(person, aiId = person.ai_id) { const temperature=String(person.temperature ?? '').trim(); const parsedTemperature=temperature === '' ? '' : Number(temperature); return withDirectoryInclusionMarkers({ ai_id:aiId, user_set_temperature:Number.isFinite(parsedTemperature) ? parsedTemperature : temperature, reasoning_effort:person.reasoning_effort, llm_flair:person.llm_flair }); }
function buildDirectoryUpdatePayload(person, aiId = person.ai_id) { return { ...buildDirectoryOfficialUpdatePayload(person, aiId), ...buildDirectoryExperimentalUpdatePayload(person, aiId) }; }

function extractKindroidAiId(result) {
  const valid = (value) => { const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim().replace(/^['"]|['"]$/g,'') : ''; return /^(?=.{6,128}$)[A-Za-z0-9][A-Za-z0-9_-]*$/.test(text) ? text : ''; };
  const visit = (value, depth = 0) => { if (depth > 8) return ''; const direct = valid(value); if (direct) return direct; if (!value || typeof value !== 'object') return ''; for (const key of ['ai_id','aiId','id']) { const found = valid(value[key]); if (found) return found; } for (const key of ['data','result','kin','ai']) { const found = visit(value[key], depth + 1); if (found) return found; } return ''; };
  for (const candidate of [result?.data, result?.result, result]) { const found = visit(candidate); if (found) return found; }
  const raw = String(result?.rawText || '');
  try { const found = visit(JSON.parse(raw)); if (found) return found; } catch {}
  const labeled = raw.match(/(?:ai[_ -]?id|id)\s*[:=]\s*["']?([A-Za-z0-9_-]{6,128})/i); if (labeled) return valid(labeled[1]);
  return valid(raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1));
}

function journalsNeedingSync(person, mode) { return journalsForPerson(person).filter((journal) => !journal.archived && journal.entry.trim() && journal.keyphrases.length && (mode === 'rebuild' || journal.remote_status !== 'synced' || journal.remote_ai_id !== String(person.ai_id || ''))).reverse(); }
function sanitizedSyncError(result) { return String(result?.message || '').replace(/kn_[A-Za-z0-9_-]+/g, '[REDACTED_KINDROID_KEY]').slice(0, 240); }
async function syncDirectoryJournal(record, targetAiId, operation) {
  const attemptedAt = new Date().toISOString(); record.remote_status = 'submitting'; record.attempt_count += 1; record.updated_at = attemptedAt; record.last_sync_operation = operation;
  await queueBridgeSave(`Checkpoint ${operation} journal submission`);
  const result = await executeKindroidOperation('create_journal_entry', { ai_id:targetAiId, entry:record.entry, keyphrases:record.keyphrases });
  const status = classifyJournalResult(result); const completedAt = new Date().toISOString();
  record.remote_status = status; record.remote_http_status = Number(result.status || 0); record.remote_ai_id = status === 'synced' ? targetAiId : record.remote_ai_id; record.remote_created_at = status === 'synced' ? String(result?.data?.created_at || result.completedAt || completedAt) : record.remote_created_at; record.last_sync_error = status === 'synced' ? '' : sanitizedSyncError(result); record.updated_at = completedAt;
  record.sync_history.push({ ai_id:targetAiId, operation, attempted_at:attemptedAt, completed_at:completedAt, http_status:Number(result.status || 0), result:status });
  await queueBridgeSave(`Checkpoint ${operation} journal result`); return { record, result, status };
}
async function replayDirectoryJournals(person, targetAiId, mode) { const pending = journalsNeedingSync(person, mode); state.directoryKindroidSync.totalJournals = pending.length; let synced = 0; const failures = []; for (let index=0; index<pending.length; index += 1) { state.directoryKindroidSync.currentJournal = index; updateDirectorySyncProgress('Replaying journals'); const outcome = await syncDirectoryJournal(pending[index], targetAiId, mode); if (outcome.status === 'synced') synced += 1; else failures.push(outcome); state.directoryKindroidSync.currentJournal = index + 1; render(); if (index < pending.length - 1) await new Promise((resolve) => setTimeout(resolve, 350)); } return { attempted:pending.length, synced, failures }; }
async function createDirectoryKin(person) { return executeKindroidOperation('directory_create_kin', buildDirectoryCreatePayload(person)); }
async function pushDirectoryKinUpdate(person, aiId) { const official = await executeKindroidOperation('update_info', buildDirectoryOfficialUpdatePayload(person, aiId)); if (!official.ok) return { ok:false, official, experimental:null }; const experimentalPayload = buildDirectoryExperimentalUpdatePayload(person, aiId); const compatibilityPayload = { ...buildDirectoryOfficialUpdatePayload(person, aiId), ...experimentalPayload }; const experimental = Object.keys(experimentalPayload).length > 1 ? await executeKindroidOperation('directory_update_kin', compatibilityPayload) : null; const compatibilityOperation=getKindroidOperation('directory_update_kin'); const warning=experimental && !experimental.ok ? `Compatibility update ${compatibilityOperation.endpoint} returned HTTP ${experimental.status || 0} (${experimental.category || 'unknown'}): ${sanitizedSyncError(experimental) || 'No response detail.'}` : ''; return { ok:true, official, experimental, warning }; }
function recordDirectorySyncResult(person, result) { person.kindroid_sync = { ...(person.kindroid_sync || {}), last_operation:result.operation, last_status:result.status, last_completed_at:new Date().toISOString(), last_result:{ journals_attempted:result.journalsAttempted || 0, journals_synced:result.journalsSynced || 0, profile_status:result.profileStatus || 0, warnings:[...(result.warnings || [])] } }; }
function directoryTechnical(result, operationKey) { const operation = getKindroidOperation(operationKey); return { operationKey, route:operation?.endpoint || '', httpStatus:Number(result?.status || 0), category:result?.ok ? 'success' : result?.category || 'unknown', message:sanitizedSyncError(result) }; }
function failDirectorySync(error, result, operationKey) { const sync=state.directoryKindroidSync; sync.step='Failed'; sync.error=String(error?.message || error); sync.technical=directoryTechnical(result || error, operationKey); }
async function prepareDirectoryRemoteAction(uid, action) { const person=directoryPersonByUid(uid); if (!person) throw new Error('Directory person not found.'); flushDirectoryEditorToEntry(person); const validation=validateDirectoryKindroidAction(person, action); if (!validation.ok) throw new Error(validation.errors.join(' ')); updateDirectorySyncProgress('Saving locally'); await queueBridgeSave(`Prepare Directory Kindroid ${action}`); updateDirectorySyncProgress(action === 'rebuild' ? 'Creating Kin' : 'Replaying journals','Local Directory saved'); return directoryPersonByUid(uid); }

async function rebuildDirectoryPersonOnKindroid(directoryUid) {
  if (activeDirectoryKindroidOperations.has(directoryUid)) return; activeDirectoryKindroidOperations.set(directoryUid,'rebuild'); const sync=state.directoryKindroidSync; sync.busy=true; sync.action='rebuild'; sync.error=null; render(); let createResult=null;
  try { let person=await prepareDirectoryRemoteAction(directoryUid,'rebuild'); createResult=await createDirectoryKin(person); sync.technical=directoryTechnical(createResult,'directory_create_kin'); if (!createResult.ok) { if (['network','timeout','server','unknown','cancelled'].includes(createResult.category)) createResult.message=`${createResult.message} Kindroid may have created the Kin; verify manually before rebuilding again.`; throw new Error(createResult.message); } updateDirectorySyncProgress('Parsing AI ID','New Kin created'); const newAiId=extractKindroidAiId(createResult); if (!newAiId) throw new Error('Kindroid creation succeeded but returned no usable AI ID. Verify the new Kin manually before retrying.'); person=directoryPersonByUid(directoryUid); const previousAiId=String(person.ai_id || ''); person.kindroid_sync ||= {}; person.kindroid_sync.previous_ai_ids ||= []; if (previousAiId) person.kindroid_sync.previous_ai_ids.push({ ai_id:previousAiId, replaced_at:new Date().toISOString(), reason:'directory_rebuild' }); person.ai_id=newAiId; person.online=false; ensureGenerationPerson(person); updateDirectorySyncProgress('Saving new AI ID','New AI ID preserved'); await queueBridgeSave('Checkpoint rebuilt Directory AI ID'); updateDirectorySyncProgress('Replaying journals'); const journals=await replayDirectoryJournals(person,newAiId,'rebuild'); updateDirectorySyncProgress('Updating profile','Journal replay finished'); const profile=await pushDirectoryKinUpdate(person,newAiId); sync.technical=directoryTechnical(profile.experimental && !profile.experimental.ok ? profile.experimental : profile.official, profile.experimental && !profile.experimental.ok ? 'directory_update_kin' : 'update_info'); if (!profile.ok) throw new Error(profile.official.message || 'Kindroid profile update failed.'); if (profile.warning) sync.warnings.push(profile.warning); if (journals.failures.length) sync.warnings.push(`${journals.failures.length} journal(s) remain failed or uncertain.`); person=directoryPersonByUid(directoryUid); person.online=true; const result={ operation:'rebuild', status:sync.warnings.length?'completed_with_warnings':'success', newAiId, previousAiId, createStatus:createResult.status, journalsAttempted:journals.attempted, journalsSynced:journals.synced, profileStatus:profile.official.status, warnings:sync.warnings, online:true }; recordDirectorySyncResult(person,result); sync.result=result; updateDirectorySyncProgress('Saving final state','Kindroid profile updated'); try { await queueBridgeSave('Finalize Directory Kindroid rebuild'); updateDirectorySyncProgress(sync.warnings.length?'Completed with warnings':'Completed','Final bridge checkpoint'); } catch (error) { person.online=false; sync.retryBridgeSave=true; throw new Error(`Kindroid succeeded, but the final bridge save failed: ${error.message}`); }
  } catch(error) { const person=directoryPersonByUid(directoryUid); if (person) person.online=false; failDirectorySync(error,createResult,sync.technical?.operationKey || 'directory_create_kin'); } finally { sync.busy=false; activeDirectoryKindroidOperations.delete(directoryUid); render(); }
}

async function updateDirectoryPersonOnKindroid(directoryUid) {
  if (activeDirectoryKindroidOperations.has(directoryUid)) return; activeDirectoryKindroidOperations.set(directoryUid,'update'); const sync=state.directoryKindroidSync; sync.busy=true; sync.action='update'; sync.error=null; render(); let apiResult=null;
  try { let person=await prepareDirectoryRemoteAction(directoryUid,'update'); const aiId=String(person.ai_id); const journals=await replayDirectoryJournals(person,aiId,'update'); updateDirectorySyncProgress('Updating profile','Journal replay finished'); apiResult=await pushDirectoryKinUpdate(person,aiId); sync.technical=directoryTechnical(apiResult.experimental && !apiResult.experimental.ok ? apiResult.experimental : apiResult.official, apiResult.experimental && !apiResult.experimental.ok ? 'directory_update_kin' : 'update_info'); if (!apiResult.ok) throw new Error(apiResult.official.message || 'Kindroid profile update failed.'); if (apiResult.warning) sync.warnings.push(apiResult.warning); if (journals.failures.length) sync.warnings.push(`${journals.failures.length} journal(s) remain failed or uncertain.`); person=directoryPersonByUid(directoryUid); person.online=true; person.kindroid_sync={ ...(person.kindroid_sync||{}), last_updated_at:new Date().toISOString() }; const result={ operation:'update', status:sync.warnings.length?'completed_with_warnings':'success', aiId, journalsAttempted:journals.attempted, journalsSynced:journals.synced, profileStatus:apiResult.official.status, warnings:sync.warnings, online:true }; recordDirectorySyncResult(person,result); sync.result=result; updateDirectorySyncProgress('Saving final state','Kindroid profile updated'); try { await queueBridgeSave('Finalize Directory Kindroid update'); updateDirectorySyncProgress(sync.warnings.length?'Completed with warnings':'Completed','Final bridge checkpoint'); } catch(error) { person.online=false; sync.retryBridgeSave=true; throw new Error(`Kindroid succeeded, but the final bridge save failed: ${error.message}`); }
  } catch(error) { const person=directoryPersonByUid(directoryUid); if(person) person.online=false; failDirectorySync(error,apiResult?.official || apiResult,'update_info'); } finally { sync.busy=false; activeDirectoryKindroidOperations.delete(directoryUid); render(); if(sync.result && !sync.error && !sync.retryBridgeSave) autoCloseSuccessfulDirectoryUpdate(); }
}

async function markDirectoryPersonOnlineOnly(directoryUid) { if(activeDirectoryKindroidOperations.has(directoryUid)) return; activeDirectoryKindroidOperations.set(directoryUid,'local'); const sync=state.directoryKindroidSync; sync.busy=true; sync.action='local'; render(); try { const person=directoryPersonByUid(directoryUid); if(!person) throw new Error('Directory person not found.'); flushDirectoryEditorToEntry(person); updateDirectorySyncProgress('Saving locally'); await queueBridgeSave('Prepare local-only online status'); person.online=true; recordDirectorySyncResult(person,{ operation:'mark_online_only', status:'local_only' }); await queueBridgeSave('Mark Directory person online locally'); sync.result={ operation:'mark_online_only', status:'local_only', online:true }; updateDirectorySyncProgress('Completed','Local Directory saved'); } catch(error) { failDirectorySync(error,null,''); } finally { sync.busy=false; activeDirectoryKindroidOperations.delete(directoryUid); render(); } }
async function setDirectoryPersonOffline(directoryUid) { const person=directoryPersonByUid(directoryUid); if(!person) return; flushDirectoryEditorToEntry(person); person.online=false; recordDirectorySyncResult(person,{ operation:'mark_offline', status:'local_only' }); await queueBridgeSave('Mark Directory person offline locally'); render(); }
async function retryDirectoryFinalBridgeSave() { const sync=state.directoryKindroidSync; if(sync.busy || !sync.retryBridgeSave) return; sync.busy=true; render(); try { await queueBridgeSave(`Retry final Directory Kindroid ${sync.action} save`); const person=directoryPersonByUid(sync.personUid); if(person && sync.result?.online) person.online=true; sync.retryBridgeSave=false; sync.error=null; sync.step=sync.warnings.length?'Completed with warnings':'Completed'; await queueBridgeSave('Persist recovered Directory online state'); } catch(error) { sync.error=`Bridge retry failed: ${error.message}`; } finally { sync.busy=false; render(); } }

function selectedEntry() {
  return entries().find((entry) => ensureEntry(entry).directory_uid === state.selectedUid) || entries()[0];
}

function filteredEntries() {
  const query = state.search.trim().toLowerCase();
  return entries().map(ensureEntry).filter((entry) => {
    if (state.filter === 'active' && entry.archived) return false;
    if (state.filter === 'archived' && !entry.archived) return false;
    return !query || String(entry.name || '').toLowerCase().includes(query);
  }).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function renderLogin() {
  root.innerHTML = `<main class="login-shell"><section class="login-card"><div class="orb"></div><p class="eyebrow">LIFELINE</p><form id="login-form" class="access-form"><label>ACCESS KEY</label><input id="access-key" type="password" autocomplete="off" value="${escapeHtml(state.accessKey)}" placeholder="Access key" required /><label class="remember"><input id="remember-key" type="checkbox" ${state.rememberKey ? 'checked' : ''}/> Remember locally</label><button>Connect</button></form><p class="sync-note">${escapeHtml(state.syncState)} — ${escapeHtml(state.syncDetail)}</p></section></main>`;
  document.querySelector('#login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    state.accessKey = document.querySelector('#access-key').value.trim();
    state.rememberKey = document.querySelector('#remember-key').checked;
    localStorage.setItem(REMEMBER_STORAGE_KEY, String(state.rememberKey));
    if (state.rememberKey) localStorage.setItem(TOKEN_STORAGE_KEY, state.accessKey); else localStorage.removeItem(TOKEN_STORAGE_KEY);
    loadBridge();
  });
}

function entryInitials(entry) {
  const name = String(entry?.name || 'Unnamed person').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return escapeHtml((parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : name.slice(0, 2)).toUpperCase());
}

function entryMeta(entry) {
  return [entry.location, entry.activity].map((value) => String(value || '').trim()).filter(Boolean).slice(0, 2).join(' • ') || 'No location or activity yet';
}

function dashboardStats() {
  const all = entries().map(ensureEntry);
  const active = all.filter((entry) => !entry.archived);
  return [
    ['Total', all.length],
    ['Online', active.filter((entry) => entry.online).length],
    ['Active', active.length],
    ['Archived', all.filter((entry) => entry.archived).length],
  ];
}

function completionScore(entry) {
  if (!entry) return 0;
  const tracked = DIRECTORY_FIELDS.map(([key]) => key);
  const filled = tracked.filter((key) => String(entry[key] ?? '').trim()).length;
  return Math.round((filled / tracked.length) * 100);
}

function journalRecordFromComposer(person, status = 'draft') {
  const entry = document.querySelector('#journal-entry')?.value || '';
  const rawKeyphrases = document.querySelector('#journal-keyphrases')?.value || '';
  const validation = validateJournalDraft({ ai_id: person.ai_id, entry, keyphrases: rawKeyphrases }, { requireKey: status !== 'draft' });
  if (!validation.ok) return { validation };
  const now = new Date().toISOString();
  return { validation, record: ensureJournalEntry({ id: newJournalId(), directory_uid: person.directory_uid, ai_id: person.ai_id, person_name: person.name || 'Unknown person', entry: entry.trim(), keyphrases: validation.keyphrases, created_at: now, updated_at: now, remote_status: status, remote_http_status: 0, remote_created_at: '', attempt_count: status === 'draft' ? 0 : 1, archived: false }) };
}

function classifyJournalResult(result) {
  if (result?.ok && result.status >= 200 && result.status < 300) return 'synced';
  if (['network', 'timeout', 'cancelled', 'server', 'unknown', 'parse'].includes(result?.category) || !result?.status || result.status >= 500) return 'unknown';
  return 'failed';
}

async function submitJournalRecord(record) {
  const attemptedAt = new Date().toISOString(); record.remote_status = 'submitting'; record.updated_at = attemptedAt;
  await saveBridge('Save journal before Kindroid submission');
  const result = await executeKindroidOperation('create_journal_entry', { ai_id: record.ai_id, entry: record.entry, keyphrases: record.keyphrases });
  record.remote_status = classifyJournalResult(result);
  record.remote_http_status = Number(result?.status || 0);
  record.remote_created_at = record.remote_status === 'synced' ? String(result?.data?.created_at || result?.completedAt || new Date().toISOString()) : '';
  record.remote_ai_id = record.remote_status === 'synced' ? String(record.ai_id || '') : record.remote_ai_id;
  record.last_sync_operation = 'manual'; record.last_sync_error = record.remote_status === 'synced' ? '' : sanitizedSyncError(result);
  record.sync_history.push({ ai_id:String(record.ai_id || ''), operation:'manual', attempted_at:attemptedAt, completed_at:new Date().toISOString(), http_status:Number(result?.status || 0), result:record.remote_status });
  record.updated_at = new Date().toISOString();
  await saveBridge('Update Kindroid journal result');
}

async function saveJournalDraft(person) {
  const { record, validation } = journalRecordFromComposer(person, 'draft');
  if (!record) { alert(validation.errors.join('\n')); return; }
  journalEntries().push(record);
  await saveBridge('Save local journal draft');
}

async function createKindroidJournal(person) {
  const { record, validation } = journalRecordFromComposer(person, 'submitting');
  if (!record) { alert(validation.errors.join('\n')); return; }
  journalEntries().push(record);
  await submitJournalRecord(record);
}

async function retryJournal(id) {
  const record = journalEntries().find((journal) => journal.id === id);
  if (!record || !['draft', 'failed', 'unknown'].includes(record.remote_status)) return;
  const validation = validateJournalDraft(record, { requireKey: true });
  if (!validation.ok) { alert(validation.errors.join('\n')); return; }
  if (record.remote_status === 'unknown' && !confirm('Kindroid may already have created this journal. Retrying could create a duplicate. Retry anyway?')) return;
  record.attempt_count += 1;
  await submitJournalRecord(record);
}

function renderJournalSection(person) {
  const journals = journalsForPerson(person);
  const connected = getKindroidCredential().startsWith('kn_');
  const cards = journals.map((journal) => `<article class="journal-history-card ${journal.archived ? 'archived' : ''}"><div class="journal-card-head"><span class="journal-status status-${escapeHtml(journal.remote_status)}">${escapeHtml(journal.remote_status)}</span><time>${escapeHtml(new Date(journal.created_at).toLocaleString())}</time></div><p>${escapeHtml(journal.entry)}</p><div class="keyphrase-chips">${journal.keyphrases.map((phrase) => `<span>${escapeHtml(phrase)}</span>`).join('')}</div><small>Attempts: ${journal.attempt_count} · HTTP: ${journal.remote_http_status || '—'}</small><div class="journal-actions"><button type="button" class="ghost journal-copy" data-journal-id="${escapeHtml(journal.id)}">COPY</button>${['draft','failed','unknown'].includes(journal.remote_status) ? `<button type="button" class="journal-retry" data-journal-id="${escapeHtml(journal.id)}">RETRY</button>` : ''}<button type="button" class="ghost journal-archive" data-journal-id="${escapeHtml(journal.id)}">${journal.archived ? 'RESTORE' : 'ARCHIVE LOCALLY'}</button></div></article>`).join('');
  return `<section class="journal-section tab-panel ${state.activeEntryTab === 'journal' ? 'active' : ''}"><header><p class="eyebrow">JOURNAL</p><h3>${escapeHtml(person.name || 'Unknown person')}</h3><p class="sync-note">AI ID: ${escapeHtml(person.ai_id || 'Missing')} · Kindroid: <b>${connected ? 'Connected' : 'Not connected'}</b></p></header><section class="journal-composer"><label><span>JOURNAL ENTRY</span><textarea id="journal-entry" placeholder="Write a durable memory…"></textarea></label><label><span>KEYPHRASES</span><textarea id="journal-keyphrases" placeholder="Comma or new-line separated"></textarea><small><b id="journal-keyphrase-count">0</b> / 8 keyphrases</small></label><div class="journal-actions"><button id="journal-save-draft" type="button">SAVE DRAFT</button><button id="journal-create-remote" type="button">CREATE IN KINDROID</button><button id="journal-clear" class="ghost" type="button">CLEAR</button></div></section><div class="journal-history"><h4>Saved journals</h4>${cards || '<div class="empty small">No journals saved for this person yet.</div>'}</div></section>`;
}

function renderMemorySection(person) {
  const aiId = String(person?.ai_id || '').trim();
  const relatedSessions = groupmakerSessions().filter((session) => Array.isArray(session.ai_list) && session.ai_list.map(String).includes(aiId));
  const active = relatedSessions.filter((session) => !String(session.closed_at || '').trim() && !String(session.idle_at || '').trim());
  return `<section class="memory-card tab-panel ${state.activeEntryTab === 'memory' ? 'active' : ''}"><div><p class="eyebrow">MEMORY</p><h3>Bridge transcript memory pipeline</h3><p class="sync-note">Electron call windows capture Kindroid call text with DOM injection and append it to ${BRIDGE_REPO}/transcripts. The LIFELINE Memory Manager can be launched later to restore its SQLite memory database from the bridge and process pending transcript files.</p></div><div class="generation-summary"><div><b>${escapeHtml(aiId || '—')}</b><span>AI ID</span></div><div><b>${active.length}</b><span>Open call sessions</span></div></div><div class="relations-grid"><section class="relation-card"><h4>Transcript destinations</h4><p>Group calls involving this person are saved under <code>transcripts/&lt;group_id&gt;/YYYY-MM-DD.txt</code> in the bridge repo.</p></section><section class="relation-card"><h4>Memory backups</h4><p>The memory manager restores and backs up <code>memory/lifeline_memory.latest.db</code>, with timestamped snapshots under <code>memory/snapshots/</code>.</p></section></div><pre>${escapeHtml(JSON.stringify(relatedSessions.map((session) => ({ group_id: session.group_id, names: session.names, touched_at: session.touched_at, closed_at: session.closed_at })), null, 2))}</pre></section>`;
}

function renderSettingsPanel() {
  if (!state.settingsOpen) return '';
  return `<section class="settings-panel"><div><p class="eyebrow">SETTINGS</p><h3>Bridge settings</h3><p class="sync-note">Import a config.json file from one dedicated settings area.</p></div><button id="import" class="ghost" type="button">Import config.json</button><input id="file" type="file" accept="application/json,.json" hidden /><div class="github-session"><div><b>GitHub token</b><small>${state.rememberKey ? 'Saved on this device' : 'Used for this session only'}</small></div><div class="github-session-actions"><button id="change-github-token" class="ghost" type="button">Change token</button><button id="logout-github" class="danger" type="button">Log out</button></div></div></section>`;
}

function endGithubSession(detail) {
  if (groupmakerDraftSaveTimer) {
    clearTimeout(groupmakerDraftSaveTimer);
    groupmakerDraftSaveTimer = null;
  }
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(REMEMBER_STORAGE_KEY);
  state.accessKey = '';
  state.rememberKey = false;
  state.authenticated = false;
  state.bridgeSha = '';
  state.config = { directory_entries: [], journal_entries: [] };
  state.selectedUid = '';
  state.settingsOpen = false;
  state.syncState = 'Locked';
  state.syncDetail = detail;
  render();
  document.querySelector('#access-key')?.focus();
}

function weatherIconUrl(value) {
  const url = String(value || '').trim();
  return url.startsWith('//') ? `https:${url}` : url;
}

function formatWeatherDay(value, options) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, options);
}

function renderWeatherAutomation() {
  const weather = state.weatherData;
  const current = weather?.current;
  const location = weather?.location;
  const forecast = Array.isArray(weather?.forecast?.forecastday) ? weather.forecast.forecastday : [];
  const credentialLabel = state.weatherApiKey ? 'Credential saved on this device' : 'API key required';
  return `<section class="weather-automation"><button id="weather-back" class="weather-back ghost" type="button">← All automations</button><header class="weather-hero"><div><span class="weather-kicker">HEARTBEAT · WEATHER</span><h1>Montréal,<br><em>right now.</em></h1><p>Current conditions and the week ahead, delivered on demand.</p></div><div class="weather-orb" aria-hidden="true"><span>☀</span></div></header><section class="weather-controls"><div class="weather-key-copy"><span class="weather-lock">◆</span><div><b>WeatherAPI credential</b><small>${escapeHtml(credentialLabel)}</small></div></div><label class="weather-key-field"><span>API KEY</span><input id="weather-api-key" type="password" value="${escapeHtml(state.weatherApiKey)}" placeholder="Paste your WeatherAPI key" autocomplete="off" spellcheck="false"></label><div class="weather-actions"><button id="weather-fetch" type="button" ${state.weatherBusy ? 'disabled' : ''}>${state.weatherBusy ? 'FETCHING WEATHER…' : state.weatherApiKey ? 'REFRESH MONTRÉAL' : 'SAVE & FETCH'}</button>${state.weatherApiKey ? '<button id="weather-forget" class="ghost" type="button">FORGET KEY</button>' : ''}</div></section>${state.weatherError ? `<div class="weather-message weather-error" role="alert"><b>Weather unavailable</b><span>${escapeHtml(state.weatherError)}</span></div>` : ''}${current ? `<section class="weather-current"><div class="weather-current-main"><img src="${escapeHtml(weatherIconUrl(current.condition?.icon))}" alt=""><div><span>${escapeHtml(location?.name || 'Montreal')}, ${escapeHtml(location?.region || 'Quebec')}</span><strong>${Math.round(Number(current.temp_c))}°</strong><p>${escapeHtml(current.condition?.text || 'Current conditions')}</p></div></div><dl><div><dt>FEELS LIKE</dt><dd>${Math.round(Number(current.feelslike_c))}°</dd></div><div><dt>WIND</dt><dd>${Math.round(Number(current.wind_kph))} km/h</dd></div><div><dt>HUMIDITY</dt><dd>${Math.round(Number(current.humidity))}%</dd></div><div><dt>UPDATED</dt><dd>${escapeHtml(current.last_updated?.split(' ')[1] || 'Now')}</dd></div></dl></section><section class="weather-week"><div class="weather-section-head"><div><span>7-DAY OUTLOOK</span><h2>The week ahead</h2></div><small>Local time · ${escapeHtml(location?.localtime || '')}</small></div><div class="weather-days">${forecast.map((day, index) => `<article class="weather-day ${index === 0 ? 'today' : ''}"><span>${index === 0 ? 'TODAY' : escapeHtml(formatWeatherDay(day.date, { weekday: 'short' }).toUpperCase())}</span><img src="${escapeHtml(weatherIconUrl(day.day?.condition?.icon))}" alt=""><b>${Math.round(Number(day.day?.maxtemp_c))}°</b><small>${Math.round(Number(day.day?.mintemp_c))}°</small><p>${escapeHtml(day.day?.condition?.text || '')}</p><i><span style="width:${Math.min(100, Math.max(0, Number(day.day?.daily_chance_of_rain || 0)))}%"></span></i><em>${Math.round(Number(day.day?.daily_chance_of_rain || 0))}% rain</em></article>`).join('')}</div></section>` : `<section class="weather-welcome"><span aria-hidden="true">☁</span><div><h2>Your forecast is one click away</h2><p>Add your WeatherAPI key above. It stays in this browser and is only sent to WeatherAPI when you request Montréal weather.</p></div></section>`}</section>`;
}

async function fetchMontrealWeather() {
  const key = document.querySelector('#weather-api-key')?.value.trim() || state.weatherApiKey;
  if (!key) { state.weatherError = 'Enter your WeatherAPI key to continue.'; render(); return; }
  state.weatherApiKey = key;
  localStorage.setItem(WEATHER_API_KEY_STORAGE_KEY, key);
  state.weatherBusy = true;
  state.weatherError = '';
  render();
  try {
    const params = new URLSearchParams({ key, q: 'Montreal', days: '7', aqi: 'no', alerts: 'no' });
    const response = await fetch(`${WEATHER_API_URL}?${params.toString()}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `WeatherAPI returned HTTP ${response.status}.`);
    state.weatherData = payload;
  } catch (error) {
    state.weatherError = error instanceof TypeError ? 'Could not reach WeatherAPI. Check your connection and try again.' : String(error?.message || error);
  } finally {
    state.weatherBusy = false;
    render();
  }
}

const NEWS_REGIONS = Object.freeze({
  quebec: { label: 'Québec', country: 'ca', query: 'Quebec OR Québec' },
  canada: { label: 'Canada', country: 'ca' },
  usa: { label: 'USA', country: 'us' },
});

function formatNewsDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Recently' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderNewsAutomation() {
  const feeds = state.newsData || {};
  const articles = Array.isArray(feeds[state.newsRegion]?.articles) ? feeds[state.newsRegion].articles : [];
  const credentialLabel = state.newsApiKey ? 'Credential saved on this device' : 'API key required';
  return `<section class="news-automation"><button id="news-back" class="weather-back ghost" type="button">← All automations</button><header class="news-hero"><div><span class="news-kicker">HEARTBEAT · NEWS</span><h1>The stories<br><em>shaping home.</em></h1><p>Top headlines from Québec, Canada, and the United States—refreshed whenever you ask.</p></div><div class="news-globe" aria-hidden="true"><span>◉</span></div></header><section class="weather-controls news-controls"><div class="weather-key-copy"><span class="weather-lock">N</span><div><b>NewsAPI credential</b><small>${escapeHtml(credentialLabel)}</small></div></div><label class="weather-key-field"><span>API KEY</span><input id="news-api-key" type="password" value="${escapeHtml(state.newsApiKey)}" placeholder="Paste your NewsAPI key" autocomplete="off" spellcheck="false"></label><div class="weather-actions"><button id="news-fetch" type="button" ${state.newsBusy ? 'disabled' : ''}>${state.newsBusy ? 'FETCHING HEADLINES…' : state.newsApiKey ? 'REFRESH NEWS' : 'SAVE & FETCH'}</button>${state.newsApiKey ? '<button id="news-forget" class="ghost" type="button">FORGET KEY</button>' : ''}</div></section>${state.newsError ? `<div class="weather-message weather-error" role="alert"><b>News unavailable</b><span>${escapeHtml(state.newsError)}</span></div>` : ''}${state.newsData ? `<section class="news-feed"><div class="news-feed-head"><div><span>TOP HEADLINES</span><h2>Across the region</h2></div><nav class="news-tabs" aria-label="News region">${Object.entries(NEWS_REGIONS).map(([key, region]) => `<button class="${state.newsRegion === key ? 'active' : ''}" data-news-region="${key}" type="button">${region.label}<small>${Number(feeds[key]?.totalResults || feeds[key]?.articles?.length || 0)}</small></button>`).join('')}</nav></div><div class="news-grid">${articles.length ? articles.map((article) => `<article class="news-card">${article.urlToImage ? `<img src="${escapeHtml(article.urlToImage)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="news-placeholder" aria-hidden="true">NEWS</div>'}<div class="news-card-copy"><div><span>${escapeHtml(article.source?.name || 'News source')}</span><time datetime="${escapeHtml(article.publishedAt || '')}">${escapeHtml(formatNewsDate(article.publishedAt))}</time></div><h3>${escapeHtml(article.title || 'Untitled headline')}</h3><p>${escapeHtml(article.description || 'Open the story for the latest details.')}</p>${article.url ? `<a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">READ FULL STORY <span aria-hidden="true">↗</span></a>` : ''}</div></article>`).join('') : '<div class="news-empty"><b>No headlines found</b><p>Try refreshing in a moment.</p></div>'}</div></section>` : `<section class="weather-welcome news-welcome"><span aria-hidden="true">◎</span><div><h2>Your briefing is ready to begin</h2><p>Add your NewsAPI key above. It stays in this browser and is only sent to NewsAPI when you request headlines.</p></div></section>`}</section>`;
}

async function fetchRegionalNews() {
  const key = document.querySelector('#news-api-key')?.value.trim() || state.newsApiKey;
  if (!key) { state.newsError = 'Enter your NewsAPI key to continue.'; render(); return; }
  state.newsApiKey = key;
  localStorage.setItem(NEWS_API_KEY_STORAGE_KEY, key);
  state.newsBusy = true;
  state.newsError = '';
  render();
  try {
    const responses = await Promise.all(Object.entries(NEWS_REGIONS).map(async ([regionKey, region]) => {
      const params = new URLSearchParams({ country: region.country, pageSize: '20' });
      if (region.query) params.set('q', region.query);
      const response = await fetch(`${NEWS_API_URL}?${params.toString()}`, { headers: { Accept: 'application/json', 'X-Api-Key': key } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.status === 'error') throw new Error(payload.message || `NewsAPI returned HTTP ${response.status}.`);
      return [regionKey, payload];
    }));
    state.newsData = Object.fromEntries(responses);
  } catch (error) {
    state.newsError = error instanceof TypeError ? 'Could not reach NewsAPI. Check your connection and NewsAPI plan access, then try again.' : String(error?.message || error);
  } finally {
    state.newsBusy = false;
    render();
  }
}

function rawgReleaseWindow() {
  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + 30);
  const toDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return { start: toDate(start), end: toDate(end) };
}

function formatRawgDate(value, options = { month: 'short', day: 'numeric' }) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? 'Date TBA' : date.toLocaleDateString(undefined, options);
}

function renderRawgAutomation() {
  const games = Array.isArray(state.rawgData?.results) ? state.rawgData.results : [];
  const range = rawgReleaseWindow();
  const credentialLabel = state.rawgApiKey ? 'Credential saved on this device' : 'API key required';
  return `<section class="rawg-automation"><button id="rawg-back" class="weather-back ghost" type="button">← All automations</button><header class="rawg-hero"><div><span class="rawg-kicker">HEARTBEAT · GAMING</span><h1>Next up,<br><em>game on.</em></h1><p>Track the video games scheduled to launch during the next 30 days.</p></div><div class="rawg-controller" aria-hidden="true"><span>✦</span><i></i><b>＋</b></div></header><section class="weather-controls rawg-controls"><div class="weather-key-copy"><span class="weather-lock">R</span><div><b>RAWG credential</b><small>${escapeHtml(credentialLabel)}</small></div></div><label class="weather-key-field"><span>API KEY</span><input id="rawg-api-key" type="password" value="${escapeHtml(state.rawgApiKey)}" placeholder="Paste your RAWG API key" autocomplete="off" spellcheck="false"></label><div class="weather-actions"><button id="rawg-fetch" type="button" ${state.rawgBusy ? 'disabled' : ''}>${state.rawgBusy ? 'LOADING RELEASES…' : state.rawgApiKey ? 'REFRESH RELEASES' : 'SAVE & FETCH'}</button>${state.rawgApiKey ? '<button id="rawg-forget" class="ghost" type="button">FORGET KEY</button>' : ''}</div></section>${state.rawgError ? `<div class="weather-message weather-error" role="alert"><b>Games unavailable</b><span>${escapeHtml(state.rawgError)}</span></div>` : ''}${state.rawgData ? `<section class="rawg-releases"><div class="rawg-releases-head"><div><span>RELEASE RADAR</span><h2>The next 30 days</h2></div><small>${escapeHtml(formatRawgDate(range.start))} — ${escapeHtml(formatRawgDate(range.end))} · ${Number(state.rawgData.count || games.length).toLocaleString()} scheduled</small></div><div class="rawg-grid">${games.length ? games.map((game) => { const platforms = (game.parent_platforms || game.platforms || []).map((item) => item.platform?.name).filter(Boolean).slice(0, 4); const genres = (game.genres || []).map((genre) => genre.name).filter(Boolean).slice(0, 2); return `<article class="rawg-card">${game.background_image ? `<img src="${escapeHtml(game.background_image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="rawg-placeholder" aria-hidden="true">PLAY</div>'}<div class="rawg-card-copy"><div class="rawg-date"><span>${escapeHtml(formatRawgDate(game.released))}</span>${game.metacritic ? `<b>${Number(game.metacritic)}</b>` : ''}</div><h3>${escapeHtml(game.name || 'Untitled game')}</h3><p>${escapeHtml(genres.join(' · ') || 'Genre to be announced')}</p><div class="rawg-platforms">${platforms.length ? platforms.map((platform) => `<span>${escapeHtml(platform)}</span>`).join('') : '<span>Platform TBA</span>'}</div>${game.slug ? `<a href="https://rawg.io/games/${encodeURIComponent(game.slug)}" target="_blank" rel="noopener noreferrer">VIEW ON RAWG <span aria-hidden="true">↗</span></a>` : ''}</div></article>`; }).join('') : '<div class="news-empty"><b>No releases found</b><p>RAWG does not currently list any games for this window.</p></div>'}</div></section>` : `<section class="weather-welcome rawg-welcome"><span aria-hidden="true">◆</span><div><h2>Your release radar is waiting</h2><p>Add your RAWG API key above. It stays in this browser and is only sent to RAWG when you request upcoming releases.</p></div></section>`}</section>`;
}

async function fetchUpcomingGames() {
  const key = document.querySelector('#rawg-api-key')?.value.trim() || state.rawgApiKey;
  if (!key) { state.rawgError = 'Enter your RAWG API key to continue.'; render(); return; }
  state.rawgApiKey = key;
  localStorage.setItem(RAWG_API_KEY_STORAGE_KEY, key);
  state.rawgBusy = true;
  state.rawgError = '';
  render();
  try {
    const range = rawgReleaseWindow();
    const params = new URLSearchParams({ key, dates: `${range.start},${range.end}`, ordering: 'released', page_size: '24' });
    const response = await fetch(`${RAWG_API_URL}?${params.toString()}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || payload.error || `RAWG returned HTTP ${response.status}.`);
    state.rawgData = payload;
  } catch (error) {
    state.rawgError = error instanceof TypeError ? 'Could not reach RAWG. Check your connection and try again.' : String(error?.message || error);
  } finally {
    state.rawgBusy = false;
    render();
  }
}

function renderHeartbeatView() {
  if (state.weatherOpen) return renderWeatherAutomation();
  if (state.newsOpen) return renderNewsAutomation();
  if (state.rawgOpen) return renderRawgAutomation();
  const items = heartbeatEntries().slice().sort((a, b) => String(a.scheduled_at || '').localeCompare(String(b.scheduled_at || '')));
  const completedCount = items.filter((entry) => entry.completed).length;
  const scheduledCount = items.length - completedCount;
  const rows = items.map((entry, index) => {
    const scheduled = entry.scheduled_at ? new Date(entry.scheduled_at) : null;
    const date = scheduled && !Number.isNaN(scheduled.getTime()) ? scheduled.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Any time';
    return `<article class="heartbeat-item ${entry.completed ? 'completed' : ''}"><span class="heartbeat-order">${String(index + 4).padStart(2, '0')}</span><span class="heartbeat-copy"><strong>${escapeHtml(entry.title || 'Untitled operation')}</strong><small>${escapeHtml(entry.description || 'Details will be added soon.')}</small></span><span class="heartbeat-time"><b>${escapeHtml(date)}</b><small><i aria-hidden="true"></i>${entry.completed ? 'Completed' : 'Scheduled'}</small></span></article>`;
  }).join('');
  return `<section class="heartbeat-home"><header class="heartbeat-banner"><div class="heartbeat-signal" aria-hidden="true"><span class="signal-grid"></span><svg viewBox="0 0 1000 240" preserveAspectRatio="none"><defs><linearGradient id="heartbeat-line" x1="0" x2="1"><stop stop-color="#ff5f87"/><stop offset=".52" stop-color="#ff9bb4"/><stop offset="1" stop-color="#69e5ff"/></linearGradient><filter id="heartbeat-glow"><feGaussianBlur stdDeviation="6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><path class="signal-shadow" d="M0 130 H250 L280 112 L315 130 H390 L420 80 L452 190 L500 25 L550 152 L580 130 H690 L720 108 L755 130 H1000"/><path class="signal-line" d="M0 130 H250 L280 112 L315 130 H390 L420 80 L452 190 L500 25 L550 152 L580 130 H690 L720 108 L755 130 H1000"/></svg></div><div class="heartbeat-banner-shade"></div><div class="heartbeat-banner-copy"><div class="heartbeat-live"><i aria-hidden="true"></i> SYSTEM ONLINE</div><p class="eyebrow">LIFELINE OPERATIONS</p><h1>HEARTBEAT</h1><p>A clear, dependable view of every scheduled operation.</p></div><div class="heartbeat-vitals" aria-label="Heartbeat summary"><div><strong>${String(items.length + 3).padStart(2, '0')}</strong><span>Total</span></div><div><strong>${String(scheduledCount).padStart(2, '0')}</strong><span>Scheduled</span></div><div><strong>${String(completedCount).padStart(2, '0')}</strong><span>Complete</span></div></div></header><section class="heartbeat-board"><div class="heartbeat-board-head"><div><p class="eyebrow">AUTOMATIONS</p><h2>Available entries</h2><p>Open an automation to configure it and run it on demand.</p></div><span class="heartbeat-readonly"><i aria-hidden="true">◇</i> Heartbeat</span></div><div class="heartbeat-list"><button id="weather-automation" class="heartbeat-item heartbeat-automation" type="button"><span class="heartbeat-order weather-order">☀</span><span class="heartbeat-copy"><strong>Weather</strong><small>Current Montréal weather and a seven-day forecast.</small></span><span class="heartbeat-time"><b>On demand</b><small><i aria-hidden="true"></i>${state.weatherApiKey ? 'Ready' : 'Setup required'}</small></span></button><button id="news-automation" class="heartbeat-item heartbeat-automation news-entry" type="button"><span class="heartbeat-order news-order">N</span><span class="heartbeat-copy"><strong>News</strong><small>Top headlines from Québec, Canada, and the USA.</small></span><span class="heartbeat-time"><b>On demand</b><small><i aria-hidden="true"></i>${state.newsApiKey ? 'Ready' : 'Setup required'}</small></span></button><button id="rawg-automation" class="heartbeat-item heartbeat-automation rawg-entry" type="button"><span class="heartbeat-order rawg-order">R</span><span class="heartbeat-copy"><strong>Game releases</strong><small>Upcoming video game releases for the next 30 days.</small></span><span class="heartbeat-time"><b>On demand</b><small><i aria-hidden="true"></i>${state.rawgApiKey ? 'Ready' : 'Setup required'}</small></span></button>${rows}</div></section></section>`;
}

function renderDirectoryWorkspace(current, onlineLabel) {
  if (!current) return '<div class="empty">Add a person or import a legacy config to begin.</div>';
  return `<div class="hero-line"><div><h1>${escapeHtml(current.name || 'No person selected')}</h1><div class="hero-meta"><span>${escapeHtml(onlineLabel)}</span><span>${escapeHtml(current.location || 'No location')}</span></div></div><button id="save" title="Save locally to the GitHub bridge" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save'}</button></div><div class="entry-tabs" role="tablist"><button class="tab ${state.activeEntryTab === 'profile' ? 'active' : ''}" type="button" role="tab" aria-selected="${state.activeEntryTab === 'profile'}" data-tab="profile">PROFILE</button><button class="tab ${state.activeEntryTab === 'family' ? 'active' : ''}" type="button" role="tab" aria-selected="${state.activeEntryTab === 'family'}" data-tab="family">FAMILY</button><button class="tab ${state.activeEntryTab === 'memory' ? 'active' : ''}" type="button" role="tab" aria-selected="${state.activeEntryTab === 'memory'}" data-tab="memory">MEMORY</button><button class="tab ${state.activeEntryTab === 'journal' ? 'active' : ''}" type="button" role="tab" aria-selected="${state.activeEntryTab === 'journal'}" data-tab="journal">JOURNAL</button></div><div class="tab-stage"><section class="profile-panel tab-panel ${state.activeEntryTab === 'profile' ? 'active' : ''}"><div class="status-grid"><button id="toggle-online" class="status ${current.online ? 'on' : ''}" ${state.directoryKindroidSync.busy ? 'disabled' : ''}><span>${current.online ? 'ONLINE' : 'OFFLINE'}</span><small>${current.online ? 'Ready for routing' : 'Hidden from live flow'}</small></button><div class="asset-card accent"><b>${escapeHtml(current.location || '—')}</b><span>LOCATION</span></div><div class="asset-card accent"><b>${escapeHtml(current.activity || '—')}</b><span>ACTIVITY / CURRENT SCENE</span></div></div><form id="entry-form" class="field-grid">${DIRECTORY_FIELDS.map(([key, label, kind]) => fieldMarkup(current, key, label, kind)).join('')}</form></section>${renderGenerationsSection(current)}${renderMemorySection(current)}${renderJournalSection(current)}</div>`;
}

function renderWikiView() {
  const query = state.wikiSearch.trim().toLowerCase();
  const all = wikiEntries().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const visible = all.filter((entry) => !query || `${entry.word || ''} ${entry.content || ''} ${(entry.keywords || []).join(' ')}`.toLowerCase().includes(query));
  if (!state.selectedWikiId && all[0]) state.selectedWikiId = all[0].id;
  const current = all.find((entry) => entry.id === state.selectedWikiId);
  const reading = wikiReadingTime(current?.content);
  const sourceLabel = current?.source_type === 'kindroid_journal' ? 'KINDROID JOURNAL' : 'LIFELINE ORIGINAL';
  const articleKeywords = (Array.isArray(current?.keywords) ? current.keywords : []).map((keyword) => String(keyword || '').trim()).filter(Boolean);
  const supportingKeywordCount = Math.max(0, articleKeywords.length - 1);
  const keywordSummary = supportingKeywordCount ? `<div class="wiki-keywords"><small><b>ADDITIONAL TAGS RETAINED</b>+${supportingKeywordCount} available in search</small></div>` : '';
  const editor = current && state.wikiEditing ? `<div class="wiki-compose"><header><div><span class="wiki-kicker">EDITING ARTICLE</span><h2>Shape the knowledge.</h2></div><button id="wiki-cancel" class="ghost" type="button">CANCEL</button></header><label class="wiki-word"><span>ARTICLE TITLE</span><input id="wiki-word" value="${escapeHtml(current.word || '')}" placeholder="What are we defining?"></label><label class="wiki-content"><span>ARTICLE BODY</span><textarea id="wiki-content" placeholder="Write everything you want to preserve about this entry…">${escapeHtml(current.content || '')}</textarea></label><footer><button id="wiki-delete" class="ghost danger" type="button">DELETE</button><div><span>Changes sync to your bridge</span><button id="wiki-save" type="button">SAVE CHANGES <b>↗</b></button></div></footer></div>` : '';
  const article = current && !state.wikiEditing ? `<div class="wiki-article"><div class="wiki-article-glow"></div><header><div class="wiki-source"><i></i>${sourceLabel}</div><button id="wiki-edit" class="wiki-edit-button ghost" type="button">✦ EDIT ARTICLE</button></header><div class="wiki-article-title"><span>${escapeHtml((current.word || '?').slice(0, 1).toUpperCase())}</span><div><p class="wiki-kicker">${current.source_type === 'kindroid_journal' ? 'PRIMARY KEYWORD' : 'KNOWLEDGE'} / ${escapeHtml(sourceLabel)}</p><h2>${escapeHtml(current.word || 'Untitled')}</h2></div></div>${keywordSummary}<div class="wiki-article-rule"><span></span><b>◆</b><span></span></div><div class="wiki-prose">${wikiArticleMarkup(current.content)}</div><footer><div><b>${reading.words}</b><span>WORDS</span></div><div><b>${reading.minutes} MIN</b><span>READ TIME</span></div><div><b>${escapeHtml(current.updated_at ? new Date(current.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'TODAY')}</b><span>LAST EDIT</span></div><p>Already saved in your LIFELINE wiki</p></footer></div>` : '';
  const welcome = !current ? `<div class="wiki-welcome"><div>W</div><p class="eyebrow">A BEAUTIFUL PLACE FOR IDEAS</p><h2>Build your living<br>knowledge base.</h2><p>Your journal becomes a browsable library automatically. Create an original article whenever inspiration strikes.</p><button id="wiki-new-empty" type="button">CREATE FIRST ENTRY</button></div>` : '';
  return `<section class="wiki-shell"><header class="wiki-hero"><div><p class="eyebrow">LIFELINE KNOWLEDGE SYSTEM</p><h1>WIKI<span>.</span></h1><p>A living, cinematic library built automatically from everything worth remembering.</p></div><div class="wiki-orbit" aria-hidden="true"><i>W</i><span></span><b></b></div></header><div class="wiki-toolbar"><label><span>⌕</span><input id="wiki-search" value="${escapeHtml(state.wikiSearch)}" placeholder="Search articles, memories, keywords…" aria-label="Search wiki"></label><button id="wiki-journal-sync" class="ghost" type="button" ${state.journalWikiSync.busy ? 'disabled' : ''} title="Refresh journal.json from LIFELINE_BRIDGE"><span>↻</span> ${state.journalWikiSync.busy ? 'SYNCING…' : 'REFRESH JOURNAL'}</button><button id="wiki-new" type="button"><span>＋</span> NEW ARTICLE</button></div><div class="wiki-sync-status"><i class="${state.journalWikiSync.busy ? 'busy' : ''}"></i><span>${escapeHtml(state.journalWikiSync.status)}</span><b>${state.journalWikiSync.total} JOURNAL ${state.journalWikiSync.total === 1 ? 'ARTICLE' : 'ARTICLES'}</b></div><div class="wiki-layout"><aside class="wiki-index"><div class="wiki-index-head"><div><span>LIBRARY</span><b>${all.length}</b></div><small>${query ? `${visible.length} matches` : 'Latest first'}</small></div><div class="wiki-list">${visible.map((entry, index) => `<button class="wiki-item ${entry.id === state.selectedWikiId ? 'selected' : ''}" data-wiki-id="${escapeHtml(entry.id)}"><span>${String(index + 1).padStart(2, '0')}</span><div><b>${escapeHtml(entry.word || 'Untitled')}</b><small>${entry.source_type === 'kindroid_journal' ? 'JOURNAL' : 'ORIGINAL'} · ${escapeHtml((entry.content || 'No content yet').replace(/\s+/g, ' ').slice(0, 62))}</small></div><i>›</i></button>`).join('') || '<div class="wiki-empty">No matching knowledge yet.<br>Try another search.</div>'}</div></aside><article class="wiki-editor">${editor}${article}${welcome}</article></div></section>`;
}
function renderDirectoryKindroidSyncModal() {
  const sync=state.directoryKindroidSync; if(!sync.open) return ''; const person=directoryPersonByUid(sync.personUid); const disabled=sync.busy?'disabled':'';
  const progress=sync.completedSteps.map((step)=>`<li class="done">✓ ${escapeHtml(step)}</li>`).join('');
  const journalProgress=sync.totalJournals ? `<li>${sync.currentJournal} / ${sync.totalJournals} journals processed</li>` : '';
  const warnings=sync.warnings.map((warning)=>`<li>${escapeHtml(warning)}</li>`).join('');
  const result=sync.result ? `<section class="kindroid-sync-result"><b>${escapeHtml(sync.result.status)}</b><span>Online: ${sync.result.online?'Yes':'No'}</span>${sync.result.aiId||sync.result.newAiId?`<span>AI ID: ${escapeHtml(sync.result.aiId||sync.result.newAiId)}</span>`:''}${sync.result.journalsAttempted!==undefined?`<span>Journals: ${sync.result.journalsSynced}/${sync.result.journalsAttempted} synchronized</span>`:''}</section>` : '';
  const technical=sync.technical ? `<details><summary>Technical details</summary><dl><dt>Operation</dt><dd>${escapeHtml(sync.technical.operationKey||'—')}</dd><dt>Route</dt><dd>${escapeHtml(sync.technical.route||'—')}</dd><dt>HTTP</dt><dd>${escapeHtml(sync.technical.httpStatus||'—')}</dd><dt>Category</dt><dd>${escapeHtml(sync.technical.category||'—')}</dd><dt>Message</dt><dd>${escapeHtml(sync.technical.message||'—')}</dd></dl></details>`:'';
  return `<div class="kindroid-sync-backdrop ${sync.closing?'is-closing':''}"><section class="kindroid-sync-modal" role="dialog" aria-modal="true" aria-labelledby="kindroid-sync-title"><header><div><p class="eyebrow">DIRECTORY BRIDGE</p><h2 id="kindroid-sync-title">Kindroid Synchronization</h2><p>${escapeHtml(person?.name||'Directory person')}</p></div><button id="directory-sync-close" class="ghost" ${disabled} aria-label="Close">×</button></header>${!sync.action&&!sync.result?`<div class="kindroid-sync-choices">${sync.error?`<div class="kindroid-sync-error"><b>Confirmation required</b><p>${escapeHtml(sync.error)}</p></div>`:''}<article class="rebuild"><h3>Rebuild on Kindroid</h3><p>Create a new Kin, preserve the previous AI ID, replay every journal, and synchronize the profile.</p><label><input id="directory-rebuild-confirm" type="checkbox"/> I understand this replaces the remote identity.</label><button id="directory-sync-rebuild" class="danger" ${disabled}>REBUILD ON KINDROID</button></article><article><h3>Update on Kindroid</h3><p>Keep the current AI ID, replay only pending journals, push the latest profile, then mark online.</p><button id="directory-sync-update" ${disabled}>UPDATE ON KINDROID</button></article><article><h3>Mark Online Only</h3><p>Change only local LIFELINE status. No Kindroid API request is made.</p><button id="directory-sync-local" class="ghost" ${disabled}>MARK ONLINE ONLY</button></article></div>`:`<section class="kindroid-sync-progress"><div class="sync-spinner"></div><h3>${escapeHtml(sync.step)}</h3><ul>${progress}${journalProgress}</ul>${warnings?`<aside><b>Warnings</b><ul>${warnings}</ul></aside>`:''}${sync.error?`<div class="kindroid-sync-error"><b>Synchronization failed</b><p>${escapeHtml(sync.error)}</p></div>`:''}${result}${technical}${sync.retryBridgeSave?`<button id="directory-sync-retry-save" ${disabled}>RETRY BRIDGE SAVE</button>`:''}</section>`}<footer><button id="directory-sync-cancel" class="ghost" ${disabled}>${sync.result||sync.error?'CLOSE':'CANCEL'}</button></footer></section></div>`;
}

function renderDirectory() {
  const previousShell = root.querySelector('.app-shell');
  const previousEditorScroll = root.querySelector('.editor')?.scrollTop || 0;
  const previousPeopleScroll = root.querySelector('.people-list')?.scrollTop || 0;
  const activeElement = document.activeElement;
  const focusState = activeElement && root.contains(activeElement) ? {
    id: activeElement.id || '',
    field: activeElement.dataset?.field || '',
    generationField: activeElement.dataset?.generationField || '',
    selectionStart: typeof activeElement.selectionStart === 'number' ? activeElement.selectionStart : null,
    selectionEnd: typeof activeElement.selectionEnd === 'number' ? activeElement.selectionEnd : null,
  } : null;
  const list = filteredEntries();
  if (!state.selectedUid && list[0]) state.selectedUid = list[0].directory_uid;
  const current = selectedEntry();
  const onlineLabel = current?.online ? 'Available now' : 'Standing by';
  const editorContent = state.activeView === 'world' ? renderHeartbeatView() : state.activeView === 'wiki' ? renderWikiView() : renderDirectoryWorkspace(current, onlineLabel);
  root.innerHTML = `<main class="app-shell ${previousShell ? 'render-stable' : ''}"><button id="world-view" class="heartbeat-launch ${state.activeView === 'world' ? 'active' : ''}" type="button" aria-label="Open Heartbeat" title="Heartbeat"><img src="https://blogs.bcm.edu/wp-content/uploads/2019/08/heart-ekg-image-iStock.png" alt=""></button><aside class="sidebar"><nav class="view-tabs" aria-label="Main views"><button id="directory-view" class="ghost ${state.activeView === 'directory' ? 'active' : ''}" type="button">Directory</button><button id="wiki-view" class="ghost ${state.activeView === 'wiki' ? 'active' : ''}" type="button">Wiki</button></nav><div class="sync-pill" title="Sync status"><span></span><b>${escapeHtml(state.syncState)}</b><small>${escapeHtml(state.syncDetail)}</small></div><div class="search-card"><input id="search" value="${escapeHtml(state.search)}" placeholder="Search DIRECTORY…" aria-label="Search DIRECTORY"/><select id="filter" aria-label="Directory filter"><option value="active">Active</option><option value="all">All</option></select></div><div class="people-list">${list.map((entry) => `<button class="person ${entry.directory_uid === state.selectedUid ? 'selected' : ''}" data-uid="${entry.directory_uid}"><span class="avatar ${entry.online ? 'online' : ''}">${entryInitials(entry)}</span><span class="person-copy"><strong>${escapeHtml(entry.name || 'Unnamed person')}</strong><small>${escapeHtml(entry.online ? 'Live now' : 'Offline')} · ${escapeHtml(entryMeta(entry))}</small></span></button>`).join('') || '<div class="empty small">No people match this view.</div>'}</div><div class="action-stack icon-actions"><button id="add" title="Add person">＋</button><button id="remove" class="danger" title="Remove person">🗑</button><button id="settings-toggle" class="ghost" title="Settings">⚙</button><button id="groupmaker-toggle" class="ghost" title="GROUPMAKER Studio">☷</button><button id="api-studio-toggle" class="ghost" title="Kindroid API Studio">API</button><button id="kindroid-panel-toggle" class="kindroid-panel-button ${state.kindroidPanelOpen ? 'active' : ''}" title="Open the Kindroid website in a floating desktop panel"><span>K</span><b>${state.kindroidPanelOpen ? 'KINDROID OPEN' : 'OPEN KINDROID'}</b><small>kindroid.ai</small></button>${renderGroupmakerReconnectButton()}</div>${renderSettingsPanel()}</aside><section class="editor">${editorContent}</section>${renderKindroidApiStudio()}${renderGroupmakerWindow()}${renderDirectoryKindroidSyncModal()}</main>`;
  bindDirectoryEvents();
  const editor = root.querySelector('.editor');
  const peopleList = root.querySelector('.people-list');
  if (editor) editor.scrollTop = previousEditorScroll;
  if (peopleList) peopleList.scrollTop = previousPeopleScroll;
  if (focusState) {
    const selector = focusState.id
      ? `#${CSS.escape(focusState.id)}`
      : focusState.field ? `[data-field="${CSS.escape(focusState.field)}"]`
        : focusState.generationField ? `[data-generation-field="${CSS.escape(focusState.generationField)}"]` : '';
    const replacement = selector ? root.querySelector(selector) : null;
    replacement?.focus({ preventScroll: true });
    if (replacement && focusState.selectionStart !== null && typeof replacement.setSelectionRange === 'function') {
      replacement.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
    }
  }
}

function fieldMarkup(entry, key, label, kind) {
  const value = entry[key] ?? '';
  if (kind === 'age_combo') return `<label><span>${label} *</span><select data-field="${key}">${AGE_OPTIONS.map((age) => `<option ${age === value ? 'selected' : ''}>${age}</option>`).join('')}</select></label>`;
  if (kind === 'text') return `<label class="wide"><span class="field-label-row"><span>${label} *</span>${key === 'ai_memory' ? '<button id="update-family-memory" class="ghost field-update" type="button" title="Build this memory from GENERATIONS family links">UPDATE</button>' : ''}</span><textarea data-field="${key}">${escapeHtml(value)}</textarea></label>`;
  return `<label><span>${label} *</span><input data-field="${key}" value="${escapeHtml(value)}"/></label>`;
}



function groupmakerNamesSource() {
  return state.groupmakerUseNames ? state.groupmakerNames : state.groupmakerContext;
}

function groupmakerActivityValue() {
  return String(state.groupmakerUseActivity ? state.groupmakerActivity : state.groupmakerLocation).trim();
}

function groupmakerDetectedMarkup(people = detectGroupmakerPeople(groupmakerNamesSource())) {
  return people.length ? people.map((p) => `<b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.ai_id)}</small>`).join('') : '<em>No matching directory people yet.</em>';
}

function refreshGroupmakerDetectedList() {
  const box = document.querySelector('#gm-detected');
  if (box) box.innerHTML = groupmakerDetectedMarkup();
}


function groupmakerReconnectReady() {
  const session = reconnectGroupmakerSession();
  const people = detectGroupmakerPeople(groupmakerNamesSource());
  return Boolean(session?.group_id) || (state.kindroidApiKey.startsWith('kn_') && state.groupmakerContext.trim() && people.length);
}

function renderGroupmakerReconnectButton() {
  const session = reconnectGroupmakerSession();
  const ready = groupmakerReconnectReady();
  if (!ready && !session?.group_id) return '';
  const title = session?.group_id
    ? `Open saved Kindroid group ${session.group_id}`
    : 'Create Kindroid group from saved GROUPMAKER draft';
  return `<button id="gm-reconnect" class="gm-reconnect ready" title="${escapeHtml(title)}"><span>↻</span><b>GROUP RECONNECT</b><small>${escapeHtml(session?.group_id ? 'Open saved Kindroid group' : 'Create Kindroid group')}</small></button>`;
}

function reconnectGroupmaker() {
  const session = reconnectGroupmakerSession();
  if (session?.group_id) {
    state.config.groupmaker_active_session_key = String(session.session_key || session.group_id || '').trim();
    if (!state.groupmakerNames.trim() && Array.isArray(session.names)) state.groupmakerNames = session.names.join(', ');
    if (!state.groupmakerContext.trim()) state.groupmakerContext = String(session.group_context || '').trim();
    const opened = openPreparedGroupmakerTab(null, session.group_id);
    state.groupmakerStatus = opened
      ? `Opened saved Kindroid group ${session.group_id}.`
      : `Open manually: ${kindroidGroupCallUrl(session.group_id)}`;
    saveBridgeQuiet('GROUPMAKER reconnect saved session');
    render();
    return;
  }
  if (groupmakerReconnectReady()) {
    syncGroupmaker();
    return;
  }
  state.groupmakerOpen = true;
  state.groupmakerMinimized = false;
  state.groupmakerStatus = 'No saved Kindroid group was found. Create one in GROUPMAKER first.';
  render();
}


function kindroidAiOptions() { return entries().map(ensureEntry).filter(e=>String(e.ai_id||'').trim()).map(e=>`<option value="${escapeHtml(e.ai_id)}">${escapeHtml(e.name || 'Unnamed')} — ${escapeHtml(e.ai_id)}</option>`).join(''); }
function kindroidGroupOptions() { return groupmakerSessions().filter(s=>String(s.group_id||'').trim()).map(s=>`<option value="${escapeHtml(s.group_id)}">${escapeHtml(s.group_name || (s.names||[]).join(', ') || 'Group')} — ${escapeHtml(s.group_id)}</option>`).join(''); }
function apiStatusBadge(status) { return String(status).replaceAll('_',' ').toUpperCase(); }
function renderKindroidApiStudio() { if (!state.apiStudioOpen) return ''; const ops = listKindroidOperations({ category: state.apiStudioCategory, includeExperimental: state.apiStudioShowExperimental }); const opn = getKindroidOperation(state.apiStudioOperationKey) || ops[0] || getKindroidOperation('send_message'); if (opn && state.apiStudioOperationKey !== opn.key) state.apiStudioOperationKey = opn.key; const results = state.config.kindroid_test_results || []; const last = results.filter(r=>r.operationKey===opn.key).slice(-1)[0]; return `<section class="api-studio"><div class="api-head"><div><p class="eyebrow">KINDROID API STUDIO</p><h2>Manual capability explorer</h2><p class="sync-note">Registry → HTTP client → API Studio. Experimental routes are hidden until explicitly enabled; no automation or polling runs here.</p></div><button id="api-close" class="ghost">Close</button></div><div class="api-controls"><label><span>Credential mode</span><input id="api-key" type="password" value="${escapeHtml(state.kindroidApiKey)}" placeholder="kn_ API key (local only)" /></label><button id="api-use-session" class="ghost">Use for this session</button><button id="api-remember">Remember on this device</button><button id="api-forget" class="danger">Forget Kindroid key</button><label class="gm-check"><input id="api-show-exp" type="checkbox" ${state.apiStudioShowExperimental?'checked':''}/> Show Experimental Operations</label><label class="gm-check"><input id="api-debug" type="checkbox" ${state.apiStudioDebug?'checked':''}/> Temporary debug payload logging</label></div><div class="api-grid"><aside class="api-nav">${Object.entries(KINDROID_API_CATEGORIES).map(([key,label])=>`<button class="api-cat ${state.apiStudioCategory===key?'selected':''}" data-cat="${key}">${label}</button>`).join('')}</aside><div class="api-catalog">${ops.map(o=>{const lr=results.filter(r=>r.operationKey===o.key).slice(-1)[0];return `<button class="api-op ${opn.key===o.key?'selected':''}" data-op="${o.key}"><b>${escapeHtml(o.label)}</b><span>${o.method} ${escapeHtml(o.endpoint)}</span><em>${apiStatusBadge(o.stability)}</em><small>${escapeHtml(o.description || o.documentationNotes || 'Mapped Kindroid API operation.')}</small><small>Risk: ${o.destructive?'destructive':o.generatesContent?'generates content':'standard'} · Response: ${o.responseType} · Stream: ${o.supportsStreaming?'yes':'no'} · Last tested: ${escapeHtml(lr?.testedAt || 'never')} · Result: ${escapeHtml(lr?.resultCategory || 'unverified')}</small></button>`}).join('') || '<div class="empty small">Enable experimental operations or choose another category.</div>'}</div><section class="api-detail">${renderKindroidOperationForm(opn)}<div class="api-preview"><h3>Request preview</h3><pre>${escapeHtml(JSON.stringify(state.apiStudioPreview || safeBuildPreview(opn.key), null, 2))}</pre></div><div class="api-response"><h3>Response console</h3>${opn.supportsStreaming?`<div class="stream-box"><b>Live stream</b><pre>${escapeHtml(state.apiStudioLiveOutput || '')}</pre><button id="api-cancel" class="ghost">Cancel stream/request</button></div>`:''}<pre>${escapeHtml(JSON.stringify(state.apiStudioResponse || { status:'No request run in this session.' }, null, 2))}</pre><button id="api-copy" class="ghost">Copy redacted response</button><button id="api-save-result" class="ghost" ${state.apiStudioResponse?'':'disabled'}>Save-test-result</button></div><details class="api-matrix"><summary>Operation, field-support, legacy alias, validation, and unverified matrices</summary>${renderKindroidMatrices()}</details></section></div>${renderTranscriptExplorer()}</section>`; }
function safeBuildPreview(operationKey) { try { return redactKindroidData(buildKindroidRequest(operationKey, state.apiStudioValues[operationKey] || {})); } catch (e) { return { validation:e.message }; } }
function renderKindroidOperationForm(operation) { const values = state.apiStudioValues[operation.key] || {}; return `<form id="api-form" class="field-grid api-form"><div class="wide"><h3>${escapeHtml(operation.label)} <span class="badge">${apiStatusBadge(operation.stability)}</span></h3><p class="sync-note">${escapeHtml(operation.method)} ${escapeHtml(operation.endpoint)} — ${escapeHtml(operation.documentationNotes || operation.description || '')}</p>${operation.destructive?'<p class="risk">Destructive action: confirmation required before execution.</p>':''}${operation.stability!=='official'?'<p class="risk">Experimental/legacy route: preview payload and route before deliberate testing. No automatic fallback is used.</p>':''}</div>${operation.fields.map(f=>renderKindroidField(operation, f, values)).join('')}<label class="wide"><span>Destructive confirmation</span><input id="api-confirm" placeholder="Type CONFIRM for destructive operations" /></label><div class="gm-row wide"><button id="api-preview-btn" type="button" class="ghost">Refresh preview</button><button id="api-execute" type="submit">Execute selected operation</button></div></form>`; }
function renderKindroidField(operation, field, values) { const val = values[field.key] ?? field.defaultValue ?? ''; const support = field.officiallySupported ? 'official field' : (field.support || 'experimental field'); const include = operation.supportsPartialUpdates && field.partial ? `<select data-api-include="${field.key}"><option value="" ${!values[`__include_${field.key}`]?'selected':''}>Do not modify</option><option value="set" ${values[`__include_${field.key}`]==='set'?'selected':''}>Set value</option><option value="clear" ${values[`__include_${field.key}`]==='clear'?'selected':''}>Clear value</option>${field.type==='tri_boolean'?'<option value="enable">Enable</option><option value="disable">Disable</option>':''}</select>` : ''; let input=''; if (field.type==='textarea') input=`<textarea data-api-field="${field.key}" placeholder="${escapeHtml(field.placeholder||'')}">${escapeHtml(val)}</textarea>`; else if (field.type==='boolean') input=`<select data-api-field="${field.key}"><option value="false" ${!val?'selected':''}>False / No</option><option value="true" ${val?'selected':''}>True / Yes</option></select>`; else if (field.type==='json') input=`<textarea data-api-field="${field.key}" placeholder='[{"username":"...","text":"...","timestamp":"2026-07-23T00:00:00Z"}]'>${escapeHtml(typeof val==='string'?val:JSON.stringify(val||'',null,2))}</textarea>`; else if (field.type==='ai_selector') input=`<select data-api-field="${field.key}"><option value="">Manual or select AI…</option>${kindroidAiOptions()}</select><input data-api-field="${field.key}" value="${escapeHtml(val)}" placeholder="AI ID" />`; else if (field.type==='group_selector') input=`<select data-api-field="${field.key}"><option value="">Manual or select group…</option>${kindroidGroupOptions()}</select><input data-api-field="${field.key}" value="${escapeHtml(val)}" placeholder="Group ID" />`; else input=`<input data-api-field="${field.key}" type="${field.type==='number'?'number':field.type==='url'?'url':'text'}" value="${escapeHtml(Array.isArray(val)?val.join(', '):val)}" placeholder="${escapeHtml(field.placeholder||'')}" />`; return `<label class="${field.type==='textarea'||field.type==='json'?'wide':''}"><span>${escapeHtml(field.label || field.key)} ${field.required?'*':''} · ${escapeHtml(support)}</span>${include}${input}<small>${escapeHtml(field.description || field.experimentalNotes || field.officialEquivalent || '')}</small></label>`; }
function renderKindroidMatrices() { const ops=Object.values(ALL_KINDROID_OPERATIONS); return `<h4>Official vs experimental operation matrix</h4><pre>${escapeHtml(ops.map(o=>`${o.key}\t${o.stability}\t${o.method} ${o.endpoint}`).join('\n'))}</pre><h4>Field-support matrix</h4><pre>${escapeHtml(ops.flatMap(o=>o.fields.map(f=>`${o.key}.${f.key}\t${f.officiallySupported?'official':'experimental/legacy'}\t${f.officialEquivalent||''}`)).join('\n'))}</pre><h4>Legacy-route alias matrix</h4><pre>${escapeHtml(ops.filter(o=>o.stability==='legacy_alias'||o.aliases.length).map(o=>`${o.endpoint}\tmodern/alias: ${o.aliases.join(', ')||'see source notes'}`).join('\n'))}</pre><h4>Validation and error handling</h4><p>Validation checks required fields, exactly-one groups, numeric limits, rewind parity, and Discord conversation shape. HTTP errors normalize into validation, authentication, permission, not_found, rate_limit, server, network, timeout, cancelled, parse, or unknown.</p><h4>Manual test report</h4><p>No live Kindroid operations were deliberately executed by this implementation task. Official and experimental operations remain unverified until a user executes and saves a result in the Studio.</p>`; }
function renderTranscriptExplorer(){const t=state.transcriptState;return `<section class="transcript-panel"><p class="eyebrow">TRANSCRIPT EXPLORER</p><h3>Manual get-chat-messages paging</h3><div class="field-grid"><label><span>Type</span><select id="tx-type"><option value="individual" ${t.conversationType==='individual'?'selected':''}>Individual</option><option value="group" ${t.conversationType==='group'?'selected':''}>Group</option></select></label><label><span>Conversation ID</span><input id="tx-id" value="${escapeHtml(t.conversationId)}" /></label><label><span>Page size 1-100</span><input id="tx-limit" type="number" min="1" max="100" value="${escapeHtml(t.limit)}" /></label><label><span>Cursor</span><input id="tx-cursor" value="${escapeHtml(t.cursor)}" /></label></div><div class="gm-row"><button id="tx-first" class="ghost">Fetch first page</button><button id="tx-next">Fetch next page</button><button id="tx-stop" class="danger">Stop/cancel</button><button id="tx-copy" class="ghost">Copy normalized transcript</button></div><p class="sync-note">Requests this session: ${t.requestCount}. Cursor: ${escapeHtml(t.cursor || 'none')}. Documented transcript limit: 600 requests per 24 hours; no long polling.</p><pre>${escapeHtml(JSON.stringify({ lastResult:t.lastResult, normalized:t.messages, raw:t.raw }, null, 2))}</pre></section>`}

function renderGroupmakerWindow() {
  if (!state.groupmakerOpen) return '';
  const people = detectGroupmakerPeople(groupmakerNamesSource());
  const active = activeGroupmakerSession();
  const transcriptStatus = state.groupmakerTranscriptStatus ? `<p class="gm-status">${escapeHtml(state.groupmakerTranscriptStatus)}</p>` : '';
  const groupmakerStatus = state.groupmakerStatus ? `<p class="gm-status">${escapeHtml(state.groupmakerStatus)}</p>` : '';
  const sessions = groupmakerSessions().filter((row) => !String(row.closed_at || '').trim()).slice().sort((a, b) => String(b.touched_at || '').localeCompare(String(a.touched_at || '')));
  const namesField = state.groupmakerUseNames ? `<label><span>Names to detect</span><textarea id="gm-names" placeholder="Type names from the bridge directory…">${escapeHtml(state.groupmakerNames)}</textarea></label>` : '';
  const activityField = state.groupmakerUseActivity ? `<label><span>Activity</span><input id="gm-activity" value="${escapeHtml(state.groupmakerActivity)}" placeholder="Talking together at a patio table" /></label>` : '';
  return `<aside class="groupmaker-float ${state.groupmakerMinimized ? 'mini' : ''}"><div class="gm-head"><div><p class="eyebrow">GROUPMAKER</p><h3>Kindroid bridge</h3></div><div><button id="gm-min" class="ghost">${state.groupmakerMinimized ? 'Open' : 'Min'}</button><button id="gm-close" class="ghost">×</button></div></div>${state.groupmakerMinimized ? '' : `<label><span>Kindroid API key</span><input id="gm-api-key" type="password" value="${escapeHtml(state.kindroidApiKey)}" placeholder="kn_…" /></label><div class="gm-row"><button id="gm-connect">${state.kindroidConnected ? 'Reconnect' : 'Connect Kindroid'}</button><button id="gm-forget" class="ghost">Forget key</button></div><label class="gm-field-option"><span><input id="gm-use-names" type="checkbox" ${state.groupmakerUseNames ? 'checked' : ''}/> Use names field</span><small>${state.groupmakerUseNames ? 'Detect participants from this field.' : 'Participants are detected from group context.'}</small></label>${namesField}<div id="gm-detected" class="gm-detected">${groupmakerDetectedMarkup(people)}</div><label><span>Location</span><input id="gm-location" value="${escapeHtml(state.groupmakerLocation)}" placeholder="Coffee Shop" /></label><label class="gm-field-option"><span><input id="gm-use-activity" type="checkbox" ${state.groupmakerUseActivity ? 'checked' : ''}/> Use activity field</span><small>${state.groupmakerUseActivity ? 'Use the activity below as the current scene.' : 'Location is used as the activity.'}</small></label>${activityField}<label><span>Group context</span><textarea id="gm-context" placeholder="Persistent shared context for this group">${escapeHtml(state.groupmakerContext)}</textarea></label><label class="gm-field-option gm-auto-option"><span><input id="gm-auto-mode" type="checkbox" ${state.groupmakerAutoMode ? 'checked' : ''}/> Auto mode</span><small>Create or update once, 5 seconds after you stop editing.</small></label><div class="gm-row"><button id="gm-sync" ${state.groupmakerBusy ? 'disabled' : ''}>${active ? `Update ${localCalendarDate()}` : `Create ${localCalendarDate()}`}</button><button id="gm-close-session" class="danger" ${active ? '' : 'disabled'}>Close active</button></div>${groupmakerStatus}${transcriptStatus}<div class="gm-sessions"><b>Open sessions</b>${sessions.length ? sessions.map((row) => `<button class="gm-session ${String(row.session_key) === String(state.config.groupmaker_active_session_key) ? 'selected' : ''}" data-session="${escapeHtml(row.session_key)}"><span>${escapeHtml(row.group_name || (row.names || []).join(', ') || 'Unnamed')}</span><small>${escapeHtml(row.group_id || '')}</small></button>`).join('') : '<small>No sessions yet.</small>'}</div>`}</aside>`;
}


function groupmakerSessionHasGroupId(session) {
  return Boolean(String(session?.group_id || '').trim());
}

function resolveGroupmakerTranscriptSession() {
  const sessions = groupmakerSessions().filter(groupmakerSessionHasGroupId);
  if (!sessions.length) return null;
  const activeKey = String(state.config.groupmaker_active_session_key || '').trim();
  const selected = sessions.find((row) => String(row.session_key || row.group_id || '').trim() === activeKey);
  if (selected) return selected;
  const active = activeGroupmakerSession();
  if (groupmakerSessionHasGroupId(active)) return active;
  return sessions.slice().sort((a, b) => String(b.touched_at || b.closed_at || '').localeCompare(String(a.touched_at || a.closed_at || '')))[0] || null;
}

function groupmakerChatUrl(groupId) {
  return `https://kindroid.ai/v2/chat/group/${encodeURIComponent(String(groupId || '').trim())}/`;
}

async function fetchGroupmakerTranscript() {
  if (state.groupmakerTranscriptBusy) return;
  const session = resolveGroupmakerTranscriptSession();
  if (!session?.group_id) { state.groupmakerTranscriptStatus = 'No GROUPMAKER session with a group_id is available.'; render(); return; }
  if (!window.lifelineElectron?.fetchGroupTranscript) { state.groupmakerTranscriptStatus = 'Electron transcript bridge is not available.'; render(); return; }
  const groupId = String(session.group_id || '').trim();
  const participants = Array.isArray(session.names) ? session.names.map((name) => String(name || '').trim()).filter(Boolean) : [];
  const capturedAt = new Date().toISOString();
  const payload = { groupId, groupName: String(session.group_name || session.name || '').trim(), participants, capturedAt, accessKey: state.accessKey, chatUrl: groupmakerChatUrl(groupId) };
  state.groupmakerTranscriptBusy = true;
  state.groupmakerTranscriptResult = null;
  state.groupmakerTranscriptStatus = 'Opening group transcript page…\nLoading older transcript entries…\nExtracting transcript bubbles…\nComparing with bridge history…\nSaving transcript to LIFELINE_BRIDGE…';
  render();
  try {
    const result = await window.lifelineElectron.fetchGroupTranscript(payload);
    state.groupmakerTranscriptResult = result;
    if (!result?.ok) throw new Error(`${result?.stage || 'unknown'}: ${result?.message || 'Transcript capture failed.'}`);
    session.last_transcript_capture = { captured_at: result.capturedAt, repo_path: result.repoPath, entries_found: result.bubblesFound, new_entries: result.newEntries, total_entries: result.totalEntries, participants_present: [...participants] };
    session.touched_at = result.capturedAt;
    state.groupmakerTranscriptStatus = `Transcript saved for ${result.groupName || 'GROUPMAKER group'}.\nGroup: ${result.groupId}\nParticipants: ${result.participants.join(', ') || '—'}\nExtraction method: ${result.selectorUsed || 'unknown'}\nEntries found: ${result.bubblesFound}\nNew entries saved: ${result.newEntries}\nTotal stored entries: ${result.totalEntries}\nPath: ${result.repoPath}`;
    await saveBridgeQuiet('GROUPMAKER transcript metadata');
  } catch (error) {
    state.groupmakerTranscriptStatus = `Transcript capture failed at ${String(error.message || error).replace(/^([^:]+):/, '$1:')}`;
  } finally {
    state.groupmakerTranscriptBusy = false;
    render();
  }
}

function groupmakerPhysicalLocation() {
  return String(state.groupmakerLocation || '').trim();
}

function sameNormalizedText(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function sameAiRoster(left = [], right = []) {
  const leftIds = validAiIds(left).sort();
  const rightIds = validAiIds(right).sort();
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

function groupmakerConfigurationChanged(active, { aiList, groupName, context, activity }) {
  if (!active) return true;
  return !sameAiRoster(active.ai_list || [], aiList)
    || !sameNormalizedText(active.group_name, groupName)
    || !sameNormalizedText(active.group_context, context)
    || !sameNormalizedText(active.group_directive, PHONE_CALL_DIRECTIVE)
    || !sameNormalizedText(active.current_scene, activity);
}

function formatGroupmakerNames(names = []) {
  const clean = names.map((name) => String(name || '').trim()).filter(Boolean);
  if (clean.length <= 2) return clean.join(clean.length === 2 ? ' and ' : '');
  return `${clean.slice(0, -1).join(' , ')} and ${clean[clean.length - 1]}`;
}

function groupmakerPresenceChanged(active, aiList = [], location = '') {
  if (!active) return true;
  const priorIds = validAiIds(active.ai_list || []);
  const currentIds = validAiIds(aiList || []);
  const samePeople = priorIds.length === currentIds.length && priorIds.every((id) => currentIds.includes(id));
  const priorLocation = String(active.physical_location || active.location || '').trim();
  return !samePeople || (location && !sameNormalizedText(priorLocation, location));
}

function groupmakerPersonPresenceChanged(active, aiId, location = '') {
  if (!active) return true;
  const wasPresent = validAiIds(active.ai_list || []).includes(String(aiId || '').trim());
  const priorLocation = String(active.physical_location || active.location || '').trim();
  return !wasPresent || (location && !sameNormalizedText(priorLocation, location));
}

async function runGroupmakerPresenceAutomations({ people = [], groupId = '', active = null, aiList = [] } = {}) {
  const location = groupmakerPhysicalLocation();
  const activity = groupmakerActivityValue();
  const presenceChanged = groupmakerPresenceChanged(active, aiList, location);
  const report = { directSent: 0, groupSent: false, scenesUpdated: 0, changedNames: [], errors: [] };
  if (!people.length) return report;
  const requests = [];

  if (location && groupId && presenceChanged) {
    const names = formatGroupmakerNames(people.map((person) => person.name));
    if (names) {
      const message = `*${names} are now physically present together . Their location is ${location}*`;
      requests.push(kindroidApiClient.execute('group_user_message', { group_id: groupId, message }, { timeoutMs: 12000 }).then((result) => {
        if (result.ok) report.groupSent = true;
        else report.errors.push(`Group presence recap failed: ${result.message || result.status || 'Kindroid request failed'}`);
      }));
    }
  }

  for (const person of people) {
    const entry = entries().map(ensureEntry).find((row) => String(row.ai_id || '').trim() === String(person.ai_id || '').trim());
    if (!entry) continue;
    if (location && groupmakerPersonPresenceChanged(active, entry.ai_id, location)) {
      const oldLocation = String(entry.location || '').trim();
      if (!oldLocation || !sameNormalizedText(oldLocation, location)) {
        const message = `*${entry.name || person.name || 'This person'} is currently transiting from ${oldLocation || 'unknown location'} to ${location}*`;
        entry.location = location;
        report.changedNames.push(entry.name || person.name || entry.ai_id);
        requests.push(kindroidApiClient.execute('send_message', { ai_id: entry.ai_id, message, stream: false }, { timeoutMs: 12000 }).then((result) => {
          if (result.ok) report.directSent += 1;
          else report.errors.push(`Location notice failed for ${entry.name || person.name || entry.ai_id}: ${result.message || result.status || 'Kindroid request failed'}`);
        }));
      }
    }

    if (activity && !sameNormalizedText(entry.activity, activity)) {
      requests.push(kindroidApiClient.execute('update_info', { ai_id: entry.ai_id, current_scene: activity, __include_current_scene: 'set' }, { timeoutMs: 12000 }).then((sceneResult) => {
        if (sceneResult.ok) {
          entry.activity = activity;
          report.scenesUpdated += 1;
        } else {
          report.errors.push(`Activity update failed for ${entry.name || person.name || entry.ai_id}: ${sceneResult.message || sceneResult.status || 'Kindroid request failed'}`);
        }
      }));
    }
  }

  await Promise.all(requests);
  return report;
}

async function syncGroupmaker({ automatic = false, openCall = true } = {}) {
  const keyInput = document.querySelector('#gm-api-key');
  if (keyInput) state.kindroidApiKey = keyInput.value.trim();
  const active = activeGroupmakerSession();
  if (active && (!state.groupmakerNames.trim() || !state.groupmakerContext.trim())) {
    state.groupmakerNames = Array.isArray(active.names) ? active.names.join(', ') : state.groupmakerNames;
    state.groupmakerContext = String(active.group_context || state.groupmakerContext || '').trim();
    state.groupmakerActivity = String(active.current_scene || state.groupmakerActivity || '').trim();
  }
  const context = state.groupmakerContext.trim();
  const activity = groupmakerActivityValue();
  const people = detectGroupmakerPeople(groupmakerNamesSource());
  const detectedAiIds = validAiIds(people.map((person) => person.ai_id));
  const aiList = detectedAiIds.length ? detectedAiIds : validAiIds(active?.ai_list || []);
  const sessionNames = people.length ? people.map((p) => p.name) : (Array.isArray(active?.names) ? active.names : []);
  if (!state.kindroidApiKey.startsWith('kn_')) { state.groupmakerOpen = true; state.groupmakerStatus = 'Enter a valid Kindroid API key first.'; render(); return; }
  if (!groupmakerPhysicalLocation()) { state.groupmakerOpen = true; state.groupmakerStatus = 'Location is required so participant location changes can be announced and saved in DIRECTORY.'; render(); return; }
  if (!context) { state.groupmakerOpen = true; state.groupmakerStatus = 'Group context is required.'; render(); return; }
  if (!activity) { state.groupmakerOpen = true; state.groupmakerStatus = `${state.groupmakerUseActivity ? 'Activity' : 'Location'} is required so the group and every participant receive a current scene.`; render(); return; }
  if (!aiList.length) { state.groupmakerOpen = true; state.groupmakerStatus = `No valid AI IDs detected from the ${state.groupmakerUseNames ? 'names field' : 'group context'} or active session.`; render(); return; }
  const groupName = composeGroupName();
  const payload = { ai_list: aiList, group_name: groupName, group_context: context, group_directive: PHONE_CALL_DIRECTIVE, current_scene: activity, share_short_term_memory: true, use_manual_turntaking: true, ...(active ? { group_id: active.group_id, __include_group_name: 'set', __include_group_context: 'set', __include_group_directive: 'set', __include_current_scene: 'set' } : {}) };
  const toolKey = active ? 'group_update' : 'create_groupchat_current_discovery';
  const configurationChanged = groupmakerConfigurationChanged(active, { aiList, groupName, context, activity });
  const priorActive = active ? { ...active, ai_list: [...validAiIds(active.ai_list || [])] } : null;
  const preparedTab = !openCall || window.lifelineElectron?.openKindroidCall ? null : window.open('about:blank', '_blank');
  if (preparedTab) preparedTab.document.title = 'Opening Kindroid group…';
  state.groupmakerBusy = true; state.groupmakerStatus = `${active ? 'Updating' : 'Creating'} GROUPMAKER session…`; render();
  try {
    const result = configurationChanged ? await kindroidApiClient.execute(toolKey, payload) : { ok: true, status: 0, skipped: true, rawText: '', data: '' };
    if (!result.ok) throw new Error(result.message || `${toolKey} failed (${result.status || 0})`);
    result.detail = result.rawText || String(result.data || '');
    result.groupIdSource = [result.rawText, result.headers?.location, result.headers?.Location].filter(Boolean).join('\n');
    const now = new Date().toISOString();
    const sessionDate = localCalendarDate();
    let target = active;
    let automation = null;
    let automationChanged = false;
    if (active) {
      automation = await runGroupmakerPresenceAutomations({ people, groupId: target.group_id, active: priorActive, aiList });
      automationChanged = Boolean(automation.groupSent || automation.directSent || automation.scenesUpdated || automation.errors.length);
      if (configurationChanged || automationChanged) Object.assign(target, { ai_list: aiList, names: sessionNames, group_name: groupName, session_date: sessionDate, group_context: context, group_directive: PHONE_CALL_DIRECTIVE, current_scene: activity, physical_location: groupmakerPhysicalLocation(), share_short_term_memory: true, use_manual_turntaking: true, touched_at: now, last_automation: { ...automation, ran_at: now } });
    } else {
      const groupId = extractGroupId(result.groupIdSource || result.detail);
      if (!groupId) throw new Error('Create succeeded, but no group_id could be parsed from the response.');
      automation = await runGroupmakerPresenceAutomations({ people, groupId, active: null, aiList });
      target = { session_key: groupId, group_id: groupId, ai_list: aiList, names: sessionNames, group_name: groupName, session_date: sessionDate, group_context: context, group_directive: PHONE_CALL_DIRECTIVE, current_scene: activity, physical_location: groupmakerPhysicalLocation(), share_short_term_memory: true, use_manual_turntaking: true, created_at: now, touched_at: now, closed_at: '', idle_at: '', last_automation: { ...automation, ran_at: now } };
      state.config.groupmaker_sessions = groupmakerSessions().filter((row) => row.group_id !== groupId).concat(target);
      state.config.groupmaker_active_session_key = groupId;
    }
    target.names = [...sessionNames];
    persistGroupmakerDraft();
    state.groupmakerStatus = `Preparing transcript metadata for ${sessionNames.join(', ')} before opening the call…`;
    render();
    await saveBridge(`GROUPMAKER ${active ? 'update' : 'create'} session`, true);
    await ensureGroupTranscript(target.group_id, sessionNames);
    const opened = openCall && openPreparedGroupmakerTab(preparedTab, target.group_id);
    const callStatus = !openCall ? 'Auto mode completed without opening a call tab.' : opened ? 'Opened Kindroid call tab after preparing its transcript.' : `Open manually: ${kindroidGroupCallUrl(target.group_id)}`;
    state.groupmakerStatus = active && !configurationChanged && !automationChanged
      ? callStatus
      : `${automatic ? 'Auto mode: ' : ''}${active ? 'Updated active session' : `Created active session ${target.group_id}`} (${result.status}). Automation: ${automation.scenesUpdated}/${people.length} participant scene(s) updated; ${automation.groupSent ? 'group recap sent' : 'no group recap'}; ${automation.directSent} location notice(s) sent${automation.errors.length ? `; ${automation.errors.length} warning(s)` : ''}. ${callStatus}`;
  } catch (error) {
    if (preparedTab && !preparedTab.closed) preparedTab.close();
    state.groupmakerStatus = error.message;
  } finally { state.groupmakerBusy = false; render(); }
}


async function fetchTranscriptPage() {
  const t = state.transcriptState;
  t.conversationType = document.querySelector('#tx-type')?.value || t.conversationType;
  t.conversationId = document.querySelector('#tx-id')?.value.trim() || t.conversationId;
  t.limit = Math.max(1, Math.min(100, Number(document.querySelector('#tx-limit')?.value || t.limit || 25)));
  t.cursor = document.querySelector('#tx-cursor')?.value.trim() || t.cursor;
  if (t.busy) { t.lastResult = 'A transcript request is already running; parallel transcript reads are blocked.'; render(); return; }
  if (!t.conversationId) { t.lastResult = 'Conversation ID is required.'; render(); return; }
  t.busy = true; t.activeRequestId = `transcript_${Date.now()}`; render();
  const result = await fetchKindroidMessagesPage({ conversationType:t.conversationType, conversationId:t.conversationId, limit:t.limit, cursor:t.cursor, requestId:t.activeRequestId });
  t.busy = false; t.requestCount += 1; t.raw = result.data || result.rawText; t.lastResult = result.ok ? `Fetched page (${result.status})` : `${result.category}: ${result.message}`;
  if (result.ok) {
    const payload = result.data || {};
    const rawMessages = Array.isArray(payload.messages) ? payload.messages : (Array.isArray(payload) ? payload : []);
    const normalized = rawMessages.map((m) => normalizeKindroidMessage(m, { conversationType:t.conversationType, conversationId:t.conversationId }));
    t.messages = mergeKindroidMessagePages(t.messages, normalized);
    t.pages.push({ fetchedAt:new Date().toISOString(), count:normalized.length });
    t.cursor = String(payload.pagination?.lastTimestamp || payload.lastTimestamp || t.cursor || '');
  }
  render();
}

function bindDirectoryEvents() {
  document.querySelector('#filter').value = state.filter;
  document.querySelector('#world-view')?.addEventListener('click', () => { state.activeView = 'world'; render(); });
  document.querySelector('#directory-view')?.addEventListener('click', () => { state.activeView = 'directory'; render(); });
  document.querySelector('#wiki-view')?.addEventListener('click', () => { state.activeView = 'wiki'; render(); });
  const createWikiEntry = () => {
    const entry = { id: newWikiId(), word: 'Untitled', content: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    wikiEntries().unshift(entry); state.selectedWikiId = entry.id; state.wikiSearch = ''; state.wikiEditing = true; render();
    requestAnimationFrame(() => { const input = document.querySelector('#wiki-word'); input?.focus(); input?.select(); });
  };
  document.querySelector('#wiki-journal-sync')?.addEventListener('click', () => syncJournalWiki());
  document.querySelector('#wiki-new')?.addEventListener('click', createWikiEntry);
  document.querySelector('#wiki-new-empty')?.addEventListener('click', createWikiEntry);
  document.querySelectorAll('[data-wiki-id]').forEach((button) => button.addEventListener('click', () => { state.selectedWikiId = button.dataset.wikiId; state.wikiEditing = false; render(); }));
  document.querySelector('#wiki-edit')?.addEventListener('click', () => { state.wikiEditing = true; render(); requestAnimationFrame(() => document.querySelector('#wiki-word')?.focus()); });
  document.querySelector('#wiki-cancel')?.addEventListener('click', () => { state.wikiEditing = false; render(); });
  document.querySelector('#wiki-search')?.addEventListener('input', (event) => { state.wikiSearch = event.target.value; render(); requestAnimationFrame(() => { const input = document.querySelector('#wiki-search'); input?.focus(); input?.setSelectionRange(state.wikiSearch.length, state.wikiSearch.length); }); });
  document.querySelector('#wiki-save')?.addEventListener('click', () => {
    const entry = wikiEntries().find((item) => item.id === state.selectedWikiId); if (!entry) return;
    entry.word = document.querySelector('#wiki-word')?.value.trim() || 'Untitled'; entry.content = document.querySelector('#wiki-content')?.value || ''; entry.updated_at = new Date().toISOString(); state.wikiEditing = false; saveBridge(`Update wiki entry: ${entry.word}`);
  });
  document.querySelector('#wiki-delete')?.addEventListener('click', () => {
    const entry = wikiEntries().find((item) => item.id === state.selectedWikiId); if (!entry || !confirm(`Delete “${entry.word || 'Untitled'}” from the wiki?`)) return;
    state.config.wiki_entries = wikiEntries().filter((item) => item.id !== entry.id); state.selectedWikiId = state.config.wiki_entries[0]?.id || ''; saveBridge('Delete wiki entry');
  });
  document.querySelector('#weather-automation')?.addEventListener('click', () => { state.weatherOpen = true; render(); });
  document.querySelector('#weather-back')?.addEventListener('click', () => { state.weatherOpen = false; state.weatherError = ''; render(); });
  document.querySelector('#weather-fetch')?.addEventListener('click', fetchMontrealWeather);
  document.querySelector('#weather-api-key')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') fetchMontrealWeather(); });
  document.querySelector('#weather-forget')?.addEventListener('click', () => {
    localStorage.removeItem(WEATHER_API_KEY_STORAGE_KEY);
    state.weatherApiKey = '';
    state.weatherData = null;
    state.weatherError = '';
    render();
  });
  document.querySelector('#news-automation')?.addEventListener('click', () => { state.newsOpen = true; render(); });
  document.querySelector('#news-back')?.addEventListener('click', () => { state.newsOpen = false; state.newsError = ''; render(); });
  document.querySelector('#news-fetch')?.addEventListener('click', fetchRegionalNews);
  document.querySelector('#news-api-key')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') fetchRegionalNews(); });
  document.querySelector('#news-forget')?.addEventListener('click', () => {
    localStorage.removeItem(NEWS_API_KEY_STORAGE_KEY);
    state.newsApiKey = '';
    state.newsData = null;
    state.newsError = '';
    render();
  });
  document.querySelectorAll('[data-news-region]').forEach((button) => button.addEventListener('click', () => {
    if (NEWS_REGIONS[button.dataset.newsRegion]) state.newsRegion = button.dataset.newsRegion;
    render();
  }));
  document.querySelector('#rawg-automation')?.addEventListener('click', () => { state.rawgOpen = true; render(); });
  document.querySelector('#rawg-back')?.addEventListener('click', () => { state.rawgOpen = false; state.rawgError = ''; render(); });
  document.querySelector('#rawg-fetch')?.addEventListener('click', fetchUpcomingGames);
  document.querySelector('#rawg-api-key')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') fetchUpcomingGames(); });
  document.querySelector('#rawg-forget')?.addEventListener('click', () => {
    localStorage.removeItem(RAWG_API_KEY_STORAGE_KEY);
    state.rawgApiKey = '';
    state.rawgData = null;
    state.rawgError = '';
    render();
  });
  document.querySelector('#search').addEventListener('input', (event) => {
    const selectionStart = event.target.selectionStart;
    const selectionEnd = event.target.selectionEnd;
    state.search = event.target.value;
    render();

    const search = document.querySelector('#search');
    search?.focus({ preventScroll: true });
    if (search && selectionStart !== null && selectionEnd !== null) {
      search.setSelectionRange(selectionStart, selectionEnd);
    }
  });
  document.querySelector('#filter').addEventListener('change', (e) => { state.filter = e.target.value; render(); });
  document.querySelectorAll('.person').forEach((button) => button.addEventListener('click', () => {
    if (state.directoryKindroidSync.busy) return;
    const outgoing = selectedEntry();
    if (outgoing) scheduleDirectoryAutoSave(outgoing, 0);
    state.selectedUid = button.dataset.uid;
    state.activeView = 'directory';
    state.activeEntryTab = 'profile';
    render();
  }));
  document.querySelector('#add').addEventListener('click', () => {
    const entry = ensureEntry({ ...DEFAULT_ENTRY, name: 'New Person' });
    entries().push(entry);
    state.selectedUid = entry.directory_uid;
    state.activeView = 'directory';
    state.activeEntryTab = 'profile';
    state.search = '';
    state.filter = 'active';
    saveBridge('Add directory person');
  });
  document.querySelector('#remove').addEventListener('click', () => { const entry = selectedEntry(); if (entry && confirm(`Remove ${entry.name || 'this person'}?`)) { state.config.directory_entries = entries().filter((item) => item.directory_uid !== entry.directory_uid); state.selectedUid = ''; saveBridge('Remove directory person'); } });
  document.querySelector('#save')?.addEventListener('click', () => saveBridge('Update directory'));
  document.querySelector('#settings-toggle').addEventListener('click', () => { state.settingsOpen = !state.settingsOpen; render(); });
  document.querySelector('#import')?.addEventListener('click', () => document.querySelector('#file')?.click());
  document.querySelector('#file')?.addEventListener('change', importLegacyFile);
  document.querySelector('#change-github-token')?.addEventListener('click', () => endGithubSession('Enter a different GitHub access key.'));
  document.querySelector('#logout-github')?.addEventListener('click', () => endGithubSession('You are logged out. Enter your access key to reconnect.'));
  document.querySelector('#groupmaker-toggle').addEventListener('click', () => { state.groupmakerOpen = !state.groupmakerOpen; render(); });
  document.querySelector('#api-studio-toggle')?.addEventListener('click', () => { state.apiStudioOpen = !state.apiStudioOpen; render(); });
  document.querySelector('#kindroid-panel-toggle')?.addEventListener('click', async () => {
    if (!window.lifelineElectron?.toggleKindroidPanel) {
      window.open('https://kindroid.ai/', '_blank', 'popup,width=480,height=820');
      return;
    }
    const result = await window.lifelineElectron.toggleKindroidPanel();
    state.kindroidPanelOpen = Boolean(result?.open);
    render();
  });
  document.querySelector('#api-close')?.addEventListener('click', () => { state.apiStudioOpen = false; render(); });
  document.querySelectorAll('.api-cat').forEach((button) => button.addEventListener('click', () => { state.apiStudioCategory = button.dataset.cat; const first = listKindroidOperations({ category: state.apiStudioCategory, includeExperimental: state.apiStudioShowExperimental })[0]; if (first) state.apiStudioOperationKey = first.key; render(); }));
  document.querySelectorAll('.api-op').forEach((button) => button.addEventListener('click', () => { state.apiStudioOperationKey = button.dataset.op; render(); }));
  document.querySelector('#api-show-exp')?.addEventListener('change', (e) => { state.apiStudioShowExperimental = e.target.checked; render(); });
  document.querySelector('#api-debug')?.addEventListener('change', (e) => { state.apiStudioDebug = e.target.checked; render(); });
  document.querySelector('#api-use-session')?.addEventListener('click', () => { state.kindroidApiKey = document.querySelector('#api-key')?.value.trim() || ''; sessionStorage.setItem('lifeline.kindroid.sessionApiKey', state.kindroidApiKey); state.kindroidConnected = state.kindroidApiKey.startsWith('kn_'); render(); });
  document.querySelector('#api-remember')?.addEventListener('click', () => { rememberKindroidCredential(document.querySelector('#api-key')?.value.trim() || ''); render(); });
  document.querySelector('#api-forget')?.addEventListener('click', () => { forgetKindroidCredential(); render(); });
  document.querySelectorAll('[data-api-field]').forEach((input) => input.addEventListener('input', (e) => { const bucket = state.apiStudioValues[state.apiStudioOperationKey] ||= {}; bucket[e.target.dataset.apiField] = e.target.value; }));
  document.querySelectorAll('select[data-api-field]').forEach((input) => input.addEventListener('change', (e) => { if (!e.target.value) return; const bucket = state.apiStudioValues[state.apiStudioOperationKey] ||= {}; bucket[e.target.dataset.apiField] = e.target.value; render(); }));
  document.querySelectorAll('[data-api-include]').forEach((input) => input.addEventListener('change', (e) => { const bucket = state.apiStudioValues[state.apiStudioOperationKey] ||= {}; bucket[`__include_${e.target.dataset.apiInclude}`] = e.target.value; }));
  document.querySelector('#api-preview-btn')?.addEventListener('click', () => { state.apiStudioPreview = safeBuildPreview(state.apiStudioOperationKey); render(); });
  document.querySelector('#api-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const operation = getKindroidOperation(state.apiStudioOperationKey); const confirmText = document.querySelector('#api-confirm')?.value || ''; if (operation.destructive && confirmText !== 'CONFIRM') { state.apiStudioResponse = { ok:false, category:'validation', message:'Type CONFIRM before destructive operations.' }; render(); return; } if (operation.stability !== 'official' && !state.apiStudioShowExperimental) { state.apiStudioResponse = { ok:false, category:'validation', message:'Enable experimental operations before executing this route.' }; render(); return; } state.apiStudioLiveOutput = ''; state.apiStudioPreview = safeBuildPreview(operation.key); state.apiStudioResponse = { status:'Running…' }; render(); const result = await kindroidApiClient.execute(operation.key, state.apiStudioValues[operation.key] || {}, { onStreamChunk: (chunk) => { state.apiStudioLiveOutput += chunk; const box = document.querySelector('.stream-box pre'); if (box) box.textContent = state.apiStudioLiveOutput; } }); state.apiStudioResponse = redactKindroidData(result); render(); });
  document.querySelector('#api-copy')?.addEventListener('click', () => navigator.clipboard?.writeText(JSON.stringify(redactKindroidData(state.apiStudioResponse || {}), null, 2)));
  document.querySelector('#api-save-result')?.addEventListener('click', () => { if (state.apiStudioResponse) { recordKindroidTestResult(state.apiStudioResponse); saveBridgeQuiet('Kindroid API Studio save test metadata'); render(); } });
  document.querySelector('#tx-first')?.addEventListener('click', () => { state.transcriptState.cursor = ''; state.transcriptState.messages = []; state.transcriptState.pages = []; fetchTranscriptPage(); });
  document.querySelector('#tx-next')?.addEventListener('click', fetchTranscriptPage);
  document.querySelector('#tx-stop')?.addEventListener('click', () => cancelKindroidRequest(state.transcriptState.activeRequestId));
  document.querySelector('#tx-copy')?.addEventListener('click', () => navigator.clipboard?.writeText(JSON.stringify(state.transcriptState.messages, null, 2)));

  document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => { state.activeEntryTab = button.dataset.tab || 'profile'; render(); }));
  document.querySelector('#gm-reconnect')?.addEventListener('click', reconnectGroupmaker);
  document.querySelector('#gm-close')?.addEventListener('click', () => { state.groupmakerOpen = false; render(); });
  document.querySelector('#gm-min')?.addEventListener('click', () => { state.groupmakerMinimized = !state.groupmakerMinimized; render(); });
  document.querySelector('#gm-api-key')?.addEventListener('input', (e) => {
    state.kindroidApiKey = e.target.value.trim();
    if (state.kindroidApiKey.startsWith('kn_')) rememberKindroidApiKey();
  });
  document.querySelector('#gm-connect')?.addEventListener('click', () => { state.kindroidApiKey = document.querySelector('#gm-api-key').value.trim(); if (rememberKindroidApiKey()) { state.groupmakerStatus = 'Kindroid API key connected and remembered locally. Ready to create or update groups.'; } else { state.groupmakerStatus = 'Kindroid API keys should start with kn_.'; } render(); });
  document.querySelector('#gm-forget')?.addEventListener('click', () => { state.kindroidApiKey = ''; state.kindroidConnected = false; localStorage.removeItem(KINDROID_API_KEY_STORAGE_KEY); state.groupmakerStatus = 'Kindroid API key forgotten.'; render(); });
  document.querySelector('#gm-sync')?.addEventListener('click', () => syncGroupmaker());
  document.querySelector('#gm-close-session')?.addEventListener('click', () => { const active = activeGroupmakerSession(); if (active) { active.closed_at = new Date().toISOString(); state.config.groupmaker_active_session_key = ''; saveBridge('GROUPMAKER close session'); } });
  document.querySelectorAll('.gm-session').forEach((button) => button.addEventListener('click', () => { state.config.groupmaker_active_session_key = button.dataset.session; saveBridge('GROUPMAKER activate session'); }));
  ['names', 'location', 'activity', 'context'].forEach((key) => { document.querySelector(`#gm-${key}`)?.addEventListener('input', (e) => { state[`groupmaker${key[0].toUpperCase()}${key.slice(1)}`] = e.target.value; if (key === 'names' || (key === 'context' && !state.groupmakerUseNames)) refreshGroupmakerDetectedList(); scheduleGroupmakerDraftSave(); scheduleGroupmakerAutoSync(); }); });
  [['use-names', 'groupmakerUseNames'], ['use-activity', 'groupmakerUseActivity'], ['auto-mode', 'groupmakerAutoMode']].forEach(([id, stateKey]) => { document.querySelector(`#gm-${id}`)?.addEventListener('change', (event) => { state[stateKey] = event.target.checked; scheduleGroupmakerDraftSave(); render(); scheduleGroupmakerAutoSync(); }); });
  const current = selectedEntry();
  if (!current) return;
  const updateKeyphraseCount = () => { const count = normalizeJournalKeyphrases(document.querySelector('#journal-keyphrases')?.value || '').length; const output = document.querySelector('#journal-keyphrase-count'); if (output) output.textContent = String(count); };
  document.querySelector('#journal-keyphrases')?.addEventListener('input', updateKeyphraseCount);
  document.querySelector('#journal-clear')?.addEventListener('click', () => { document.querySelector('#journal-entry').value = ''; document.querySelector('#journal-keyphrases').value = ''; updateKeyphraseCount(); });
  document.querySelector('#journal-save-draft')?.addEventListener('click', () => saveJournalDraft(current));
  document.querySelector('#journal-create-remote')?.addEventListener('click', () => createKindroidJournal(current));
  document.querySelectorAll('.journal-copy').forEach((button) => button.addEventListener('click', () => { const record = journalEntries().find((row) => row.id === button.dataset.journalId); if (record) navigator.clipboard?.writeText(record.entry); }));
  document.querySelectorAll('.journal-retry').forEach((button) => button.addEventListener('click', () => retryJournal(button.dataset.journalId)));
  document.querySelectorAll('.journal-archive').forEach((button) => button.addEventListener('click', () => { const record = journalEntries().find((row) => row.id === button.dataset.journalId); if (record) { record.archived = !record.archived; record.updated_at = new Date().toISOString(); saveBridge(record.archived ? 'Archive journal locally' : 'Restore local journal'); } }));
  document.querySelector('#toggle-online')?.addEventListener('click', async () => { const person=selectedEntry(); if(!person || state.directoryKindroidSync.busy) return; if(person.online) await setDirectoryPersonOffline(person.directory_uid); else openDirectoryKindroidActionModal(person.directory_uid); });
  document.querySelector('#directory-sync-close')?.addEventListener('click', closeDirectoryKindroidActionModal);
  document.querySelector('#directory-sync-cancel')?.addEventListener('click', closeDirectoryKindroidActionModal);
  document.querySelector('#directory-sync-rebuild')?.addEventListener('click', () => { if (!document.querySelector('#directory-rebuild-confirm')?.checked) { state.directoryKindroidSync.error='Confirm that Rebuild replaces the remote identity.'; render(); return; } rebuildDirectoryPersonOnKindroid(state.directoryKindroidSync.personUid); });
  document.querySelector('#directory-sync-update')?.addEventListener('click', () => updateDirectoryPersonOnKindroid(state.directoryKindroidSync.personUid));
  document.querySelector('#directory-sync-local')?.addEventListener('click', () => markDirectoryPersonOnlineOnly(state.directoryKindroidSync.personUid));
  document.querySelector('#directory-sync-retry-save')?.addEventListener('click', retryDirectoryFinalBridgeSave);
  document.querySelectorAll('[data-field]').forEach((input) => {
    input.addEventListener('input', (event) => {
      current[event.target.dataset.field] = event.target.value;
      scheduleDirectoryAutoSave(current);
    });
    input.addEventListener('change', () => scheduleDirectoryAutoSave(current, 0));
  });
  document.querySelector('#update-family-memory')?.addEventListener('click', () => updateFamilyMemory(current));
  const generation = ensureGenerationPerson(current);
  document.querySelectorAll('[data-generation-field]').forEach((input) => input.addEventListener('input', (e) => {
    generation[e.target.dataset.generationField] = e.target.value;
    if (e.target.dataset.generationField === 'sex') current.gender = e.target.value;
    scheduleDirectoryAutoSave(current);
  }));
  const updatePregnancy = ({ active, partnerId, progress } = {}) => {
    const existing = generation.pregnancy && typeof generation.pregnancy === 'object' ? generation.pregnancy : {};
    const nextProgress = progress === undefined ? Number(existing.progress || 0) : Number(progress);
    const pregnancy = {
      active: active === undefined ? existing.active === true : Boolean(active),
      partner_id: partnerId === undefined ? String(existing.partner_id || '').trim() : String(partnerId || '').trim(),
      progress: Number.isFinite(nextProgress) ? Math.max(0, Math.min(100, nextProgress)) : 0,
    };
    generation.pregnancy = pregnancy;
    current.pregnancy = { ...pregnancy };
    persistLocalConfig(`Local pregnancy update: ${current.name || current.directory_uid}`);
  };
  document.querySelector('#generation-pregnant')?.addEventListener('change', (event) => {
    updatePregnancy({
      active: event.target.checked,
      partnerId: document.querySelector('#generation-pregnancy-partner')?.value || '',
      progress: document.querySelector('#generation-pregnancy-percent')?.value || 0,
    });
    render();
  });
  document.querySelector('#generation-pregnancy-partner')?.addEventListener('change', (event) => updatePregnancy({ partnerId: event.target.value }));
  const pregnancyRange = document.querySelector('#generation-pregnancy-progress');
  const pregnancyPercent = document.querySelector('#generation-pregnancy-percent');
  pregnancyRange?.addEventListener('input', (event) => {
    updatePregnancy({ progress: event.target.value });
    if (pregnancyPercent) pregnancyPercent.value = event.target.value;
  });
  pregnancyPercent?.addEventListener('input', (event) => {
    const progress = Math.max(0, Math.min(100, Number(event.target.value) || 0));
    updatePregnancy({ progress });
    if (pregnancyRange) pregnancyRange.value = String(progress);
  });
  document.querySelector('#save-pregnancy')?.addEventListener('click', () => saveBridge('Update pregnancy from GENERATIONS'));
  const updateRelations = () => {
    setDirectoryFamilyRelations(current, 'parents', [...document.querySelectorAll('#generation-parents input:checked')].map((input) => input.value));
    setDirectoryFamilyRelations(current, 'children', [...document.querySelectorAll('#generation-children input:checked')].map((input) => input.value));
    const updatedGeneration = ensureGenerationPerson(current);
    refreshGenerationRelationshipDisplay(updatedGeneration);
    queueBridgeSave('Update family relationships from GENERATIONS').catch((error) => {
      state.syncState = 'Save failed';
      state.syncDetail = error.message;
    });
  };
  document.querySelectorAll('#generation-parents input, #generation-children input').forEach((input) => input.addEventListener('change', updateRelations));
  [['generation-parent-search', 'generation-parents'], ['generation-child-search', 'generation-children']].forEach(([searchId, pickerId]) => {
    document.querySelector(`#${searchId}`)?.addEventListener('input', (event) => {
      const query = String(event.target.value || '').trim().toLowerCase();
      document.querySelectorAll(`#${pickerId} .relation-choice`).forEach((choice) => {
        choice.hidden = Boolean(query) && !String(choice.dataset.relationName || '').includes(query);
      });
    });
  });
}

async function importLegacyFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    state.config = normalizeImported(JSON.parse(await file.text()));
    entries().forEach(ensureEntry);
    journalEntries();
    hydrateGroupmakerDraft();
    state.selectedUid = entries()[0]?.directory_uid || '';
    await saveBridge('Import legacy directory');
  } catch (error) {
    state.syncState = 'Import failed'; state.syncDetail = error.message; render();
  }
}

function hasRememberedGitHubCredential() {
  return state.rememberKey && Boolean(String(state.accessKey || '').trim());
}

function startRememberedLogin() {
  if (!hasRememberedGitHubCredential()) return false;
  state.syncState = 'Auto login';
  state.syncDetail = 'Remembered access key found; connecting automatically…';
  loadBridge();
  return true;
}

function render() { state.authenticated ? renderDirectory() : renderLogin(); }



if (!startRememberedLogin()) render();
