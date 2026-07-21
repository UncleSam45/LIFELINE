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

const GITHUB_OWNER = 'unclesam45';
const BRIDGE_REPO = 'LIFELINE_BRIDGE';
const BRIDGE_BRANCH = 'main';
const BRIDGE_PATH = 'config.json';
const LEGACY_BRIDGE_PATHS = ['kindroidxl_directory/config.json'];
const TOKEN_STORAGE_KEY = 'lifeline.bridge.accessKey';
const REMEMBER_STORAGE_KEY = 'lifeline.bridge.rememberAccessKey';
const KINDROID_API_KEY_STORAGE_KEY = 'lifeline.kindroid.apiKey';
const KINDROID_BASE_URL = 'https://api.kindroid.ai/v1';
const GROUPMAKER_REQUESTER = 'LIFELINE-MAINJS-GROUPMAKER';
const PHONE_CALL_DIRECTIVE = 'This is a phone call. Respond in direct speech only. Avoid action or inner thought narration. Keep it concise.';
const REMEMBERED_ACCESS_KEY = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
const REMEMBERED_GITHUB_LOGIN_ENABLED = localStorage.getItem(REMEMBER_STORAGE_KEY) === 'true' && Boolean(REMEMBERED_ACCESS_KEY.trim());
let groupmakerDraftSaveTimer = null;

const DIRECTORY_FIELDS = [
  ['name', 'NAME', 'line'],
  ['gender', 'GENDER', 'line'],
  ['age', 'AGE', 'age_combo'],
  ['ai_id', 'ID', 'line'],
  ['location', 'ACTIVITY', 'line'],
  ['position', 'POSITION', 'line'],
  ['rank', 'RANK', 'line'],
  ['responsibilities', 'RESPONSIBILITIES', 'text'],
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
  online: false,
  archived: false,
  fetch_rules: [],
};

const state = {
  accessKey: REMEMBERED_ACCESS_KEY,
  rememberKey: localStorage.getItem(REMEMBER_STORAGE_KEY) === 'true',
  authenticated: false,
  syncState: REMEMBERED_GITHUB_LOGIN_ENABLED ? 'Auto login' : 'Locked',
  syncDetail: REMEMBERED_GITHUB_LOGIN_ENABLED
    ? 'Remembered GitHub credential found; connecting automatically…'
    : 'Enter an access key to connect to the bridge repository.',
  config: { directory_entries: [] },
  bridgeSha: '',
  selectedUid: '',
  filter: 'active',
  search: '',
  saving: false,
  kindroidApiKey: localStorage.getItem(KINDROID_API_KEY_STORAGE_KEY) || '',
  kindroidConnected: false,
  groupmakerOpen: false,
  groupmakerMinimized: false,
  groupmakerBusy: false,
  groupmakerStatus: 'Enter your Kindroid API key to enable GROUPMAKER.',
  groupmakerNames: '',
  groupmakerLocation: '',
  groupmakerPosition: '',
  groupmakerContext: '',
  groupmakerV2Mode: true,
};

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


function groupmakerSessions() {
  if (!Array.isArray(state.config.groupmaker_sessions)) state.config.groupmaker_sessions = [];
  state.config.groupmaker_sessions = state.config.groupmaker_sessions.filter((row) => row && typeof row === 'object');
  return state.config.groupmaker_sessions;
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
  state.groupmakerPosition = String(draft.position || '');
  state.groupmakerContext = String(draft.context || '');
  state.groupmakerV2Mode = draft.v2_mode === undefined ? true : Boolean(draft.v2_mode);
}

function persistGroupmakerDraft() {
  const draft = groupmakerDraft();
  draft.names = state.groupmakerNames;
  draft.location = state.groupmakerLocation;
  draft.position = state.groupmakerPosition;
  draft.context = state.groupmakerContext;
  draft.v2_mode = state.groupmakerV2Mode;
  draft.touched_at = new Date().toISOString();
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
  const activeKey = String(state.config.groupmaker_active_session_key || '').trim();
  if (!activeKey) return null;
  return groupmakerSessions().find((row) => String(row.session_key || '').trim() === activeKey && !String(row.closed_at || '').trim() && !String(row.idle_at || '').trim()) || null;
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
    if (matched) byId.set(aiId, { ai_id: aiId, name, location: person.location || '', position: person.position || '' });
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

function composeGroupName(people, hint = '') {
  const trimmed = String(hint || '').trim();
  if (trimmed) return trimmed.slice(0, 50);
  return [...new Set(people.map((person) => person.name).filter(Boolean))].sort().join(' + ').slice(0, 50) || 'Live Session';
}


function kindroidGroupCallUrl(groupId) {
  const cleanGroupId = String(groupId || '').trim().replace(/^\/+|\/+$/g, '');
  if (!cleanGroupId) return '';
  const path = state.groupmakerV2Mode ? `/v2/call/group/${encodeURIComponent(cleanGroupId)}/` : `/call/group/${encodeURIComponent(cleanGroupId)}/`;
  return `https://kindroid.ai${path}`;
}

function openPreparedGroupmakerTab(tabRef, groupId) {
  const url = kindroidGroupCallUrl(groupId);
  if (!url) return false;
  if (tabRef && !tabRef.closed) {
    tabRef.location.href = url;
    try { tabRef.focus(); } catch {}
    return true;
  }
  const opened = window.open(url, '_blank');
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

async function kindroidRequest(toolKey, endpointPath, payload) {
  const response = await fetch(`${KINDROID_BASE_URL}${endpointPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${state.kindroidApiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Kindroid-Requester': GROUPMAKER_REQUESTER,
    },
    body: JSON.stringify(payload),
  });
  const detail = await response.text();
  const location = response.headers.get('Location') || response.headers.get('location') || '';
  const groupIdSource = [detail, location, response.url].filter(Boolean).join('\n');
  if (!response.ok) throw new Error(`${toolKey} failed (${response.status}): ${detail.slice(0, 240)}`);
  return { status: response.status, detail, groupIdSource };
}

function ensureEntry(entry) {
  Object.entries(DEFAULT_ENTRY).forEach(([key, value]) => {
    if (entry[key] === undefined) entry[key] = Array.isArray(value) ? [...value] : value;
  });
  if (!String(entry.directory_uid || '').trim()) entry.directory_uid = newDirectoryUid();
  if (String(entry.ai_id || '').endsWith('\\')) entry.ai_id = String(entry.ai_id).replace(/\\+$/g, '').trim();
  return entry;
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
  if (!response.ok) throw new Error(payload.message || `GitHub request failed (${response.status})`);
  return payload;
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
  if (Array.isArray(payload)) return { directory_entries: payload };
  if (payload && typeof payload === 'object') return { ...payload, directory_entries: Array.isArray(payload.directory_entries) ? payload.directory_entries : [] };
  throw new Error('Imported file must be a legacy config object or directory_entries array.');
}

async function loadBridge() {
  state.syncState = 'Syncing'; state.syncDetail = `Restoring directory from ${BRIDGE_REPO}/${BRIDGE_PATH}…`; render();
  const loadedCandidates = [];
  let lastError = null;
  for (const path of [BRIDGE_PATH, ...LEGACY_BRIDGE_PATHS]) {
    try {
      const { sha, config } = await readGithubContentFile(path);
      const count = Array.isArray(config.directory_entries) ? config.directory_entries.length : 0;
      loadedCandidates.push({ path, sha, config, count });
    } catch (error) {
      lastError = error;
      if (!/not found/i.test(error.message)) break;
    }
  }
  const bestCandidate = loadedCandidates.find((candidate) => candidate.count > 0) || loadedCandidates[0];
  if (bestCandidate) {
    state.bridgeSha = bestCandidate.path === BRIDGE_PATH ? bestCandidate.sha : '';
    state.config = bestCandidate.config;
    entries().forEach(ensureEntry);
    hydrateGroupmakerDraft();
    state.authenticated = true;
    state.syncState = 'Online';
    state.syncDetail = bestCandidate.path === BRIDGE_PATH
      ? `Restored ${entries().length} directory entries from ${BRIDGE_REPO}/${BRIDGE_PATH}.`
      : `Recovered ${entries().length} entries from old bridge path ${bestCandidate.path}; next save will migrate them to ${BRIDGE_PATH}.`;
  } else if (lastError && !/not found/i.test(lastError.message)) {
    state.authenticated = false;
    state.syncState = 'Denied'; state.syncDetail = lastError.message;
  } else {
    state.config = { directory_entries: [] };
    hydrateGroupmakerDraft();
    state.bridgeSha = '';
    state.authenticated = true;
    state.syncState = 'New bridge'; state.syncDetail = `${BRIDGE_PATH} will be created on first save.`;
  }
  render();
}

async function saveBridge(reason = 'Update directory') {
  state.saving = true; state.syncState = 'Saving'; state.syncDetail = 'Writing directory changes to GitHub…'; render();
  try {
    const payload = await githubRequest(bridgeUrl(BRIDGE_PATH, false), {
      method: 'PUT',
      body: JSON.stringify({
        message: `${reason} via LIFELINE frontend`,
        content: encodeBase64(state.config),
        branch: BRIDGE_BRANCH,
        ...(state.bridgeSha ? { sha: state.bridgeSha } : {}),
      }),
    });
    state.bridgeSha = payload.content?.sha || state.bridgeSha;
    state.syncState = 'Synced'; state.syncDetail = `Saved ${entries().length} entries to ${BRIDGE_PATH}.`;
  } catch (error) {
    state.syncState = 'Save failed'; state.syncDetail = error.message;
  } finally {
    state.saving = false; render();
  }
}


async function saveBridgeQuiet(reason = 'Update directory') {
  try {
    const payload = await githubRequest(bridgeUrl(BRIDGE_PATH, false), {
      method: 'PUT',
      body: JSON.stringify({
        message: `${reason} via LIFELINE frontend`,
        content: encodeBase64(state.config),
        branch: BRIDGE_BRANCH,
        ...(state.bridgeSha ? { sha: state.bridgeSha } : {}),
      }),
    });
    state.bridgeSha = payload.content?.sha || state.bridgeSha;
    state.syncState = 'Synced';
    state.syncDetail = `Saved GROUPMAKER draft to ${BRIDGE_PATH}.`;
  } catch (error) {
    state.syncState = 'Draft save failed';
    state.syncDetail = error.message;
  }
}

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
  root.innerHTML = `<main class="login-shell"><section class="login-card"><div class="orb"></div><p class="eyebrow">LIFELINE BRIDGE</p><h1>Secure directory access.</h1><p class="lede">Enter the GitHub fine-grained token configured for ${GITHUB_OWNER}/${BRIDGE_REPO}. The key is only used in this browser session unless you choose to remember it locally.</p><form id="login-form" class="access-form"><label>ACCESS KEY :</label><input id="access-key" type="password" autocomplete="off" value="${escapeHtml(state.accessKey)}" placeholder="github_pat_…" required /><label class="remember"><input id="remember-key" type="checkbox" ${state.rememberKey ? 'checked' : ''}/> Remember locally</label><button>Connect bridge</button></form><p class="sync-note">${escapeHtml(state.syncState)} — ${escapeHtml(state.syncDetail)}</p></section></main>`;
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
  return [entry.position, entry.location].map((value) => String(value || '').trim()).filter(Boolean).slice(0, 2).join(' • ') || 'No role details yet';
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

function renderDirectory() {
  const list = filteredEntries();
  if (!state.selectedUid && list[0]) state.selectedUid = list[0].directory_uid;
  const current = selectedEntry();
  const score = completionScore(current);
  const onlineLabel = current?.online ? 'Available now' : 'Standing by';
  root.innerHTML = `<main class="app-shell"><aside class="sidebar"><div class="brand-block"><div class="brand-mark">LL</div><div><p class="eyebrow">LIFELINE OS</p><h2>Bridge roster</h2></div></div><div class="sync-pill"><span></span><b>${escapeHtml(state.syncState)}</b><small>${escapeHtml(state.syncDetail)}</small></div><div class="search-card"><label for="search">Find people</label><input id="search" value="${escapeHtml(state.search)}" placeholder="Search by name…"/><select id="filter"><option value="active">Active roster</option><option value="archived">Archived</option><option value="all">Everyone</option></select></div><div class="people-list">${list.map((entry) => `<button class="person ${entry.directory_uid === state.selectedUid ? 'selected' : ''}" data-uid="${entry.directory_uid}"><span class="avatar ${entry.online ? 'online' : ''}">${entryInitials(entry)}</span><span class="person-copy"><strong>${escapeHtml(entry.name || 'Unnamed person')}</strong><small>${escapeHtml(entry.archived ? 'Archived' : entry.online ? 'Live now' : 'Offline')} · ${escapeHtml(entryMeta(entry))}</small></span></button>`).join('') || '<div class="empty small">No people match this view.</div>'}</div><div class="action-stack"><button id="add">+ Add Person</button><button id="archive" class="ghost">${current?.archived ? 'Unarchive Person' : 'Archive Person'}</button><button id="remove" class="danger">Remove Person</button><button id="import" class="ghost">Import config.json</button><button id="groupmaker-toggle" class="ghost">GROUPMAKER Studio</button>${renderGroupmakerReconnectButton()}<input id="file" type="file" accept="application/json,.json" hidden /><button id="logout" class="ghost">Lock access</button></div></aside><section class="editor"><div class="hero-line"><div><p class="eyebrow">CHARACTER COMMAND CENTER</p><h1>${escapeHtml(current?.name || 'No person selected')}</h1><div class="hero-meta"><span>${escapeHtml(onlineLabel)}</span><span>${score}% profile complete</span><span>${escapeHtml(current?.rank || 'No rank')}</span></div></div><button id="save" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save & Sync'}</button></div>${current ? `<div class="status-grid"><button id="toggle-online" class="status ${current.online ? 'on' : ''}"><span>${current.online ? 'ONLINE' : 'OFFLINE'}</span><small>${current.online ? 'Ready for routing' : 'Hidden from live flow'}</small></button><div class="asset-card"><b>${score}%</b><span>PROFILE HEALTH</span><div class="progress"><i style="width:${score}%"></i></div></div><div class="asset-card accent"><b>${escapeHtml(current.location || '—')}</b><span>ACTIVE LOCATION</span></div></div><form id="entry-form" class="field-grid">${DIRECTORY_FIELDS.map(([key, label, kind]) => fieldMarkup(current, key, label, kind)).join('')}</form><section class="fetch-card"><div><p class="eyebrow">AUTOMATION</p><h3>Fetcher settings</h3></div><textarea id="fetch-rules" placeholder='[{"source_id":"...","frequency":"none","time":"09:00"}]'>${escapeHtml(JSON.stringify(current.fetch_rules || [], null, 2))}</textarea></section>` : '<div class="empty">Add a person or import a legacy config to begin.</div>'}</section>${renderGroupmakerWindow()}</main>`;
  bindDirectoryEvents();
}

function fieldMarkup(entry, key, label, kind) {
  const value = entry[key] ?? '';
  if (kind === 'age_combo') return `<label><span>${label} *</span><select data-field="${key}">${AGE_OPTIONS.map((age) => `<option ${age === value ? 'selected' : ''}>${age}</option>`).join('')}</select></label>`;
  if (kind === 'text') return `<label class="wide"><span>${label} *</span><textarea data-field="${key}">${escapeHtml(value)}</textarea></label>`;
  return `<label><span>${label} *</span><input data-field="${key}" value="${escapeHtml(value)}" ${key === 'rank' ? 'placeholder="Auto-filled from GENERATIONS / HOUSES rank"' : ''}/></label>`;
}



function groupmakerDetectedMarkup(people = detectGroupmakerPeople(state.groupmakerNames)) {
  return people.length ? people.map((p) => `<b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.ai_id)}</small>`).join('') : '<em>No matching directory people yet.</em>';
}

function refreshGroupmakerDetectedList() {
  const box = document.querySelector('#gm-detected');
  if (box) box.innerHTML = groupmakerDetectedMarkup();
}


function renderGroupmakerReconnectButton() {
  const active = activeGroupmakerSession();
  const people = detectGroupmakerPeople(state.groupmakerNames);
  const ready = state.kindroidApiKey.startsWith('kn_') && state.groupmakerContext.trim() && people.length;
  const title = ready
    ? `${active ? 'Update' : 'Create'} Kindroid group from saved GROUPMAKER draft`
    : 'Open GROUPMAKER to finish API key, names, and context setup';
  return `<button id="gm-reconnect" class="gm-reconnect ${ready ? 'ready' : 'needs-setup'}" title="${escapeHtml(title)}"><span>↻</span><b>RECONNECT</b><small>${escapeHtml(active ? 'Update active Kindroid group' : ready ? 'Create Kindroid group' : 'Needs setup')}</small></button>`;
}

function renderGroupmakerWindow() {
  if (!state.groupmakerOpen) return '';
  const people = detectGroupmakerPeople(state.groupmakerNames);
  const active = activeGroupmakerSession();
  const sessions = groupmakerSessions().filter((row) => !String(row.closed_at || '').trim()).slice().sort((a, b) => String(b.touched_at || '').localeCompare(String(a.touched_at || '')));
  return `<aside class="groupmaker-float ${state.groupmakerMinimized ? 'mini' : ''}"><div class="gm-head"><div><p class="eyebrow">GROUPMAKER</p><h3>Kindroid bridge</h3></div><div><button id="gm-min" class="ghost">${state.groupmakerMinimized ? 'Open' : 'Min'}</button><button id="gm-close" class="ghost">×</button></div></div>${state.groupmakerMinimized ? '' : `<label><span>Kindroid API key</span><input id="gm-api-key" type="password" value="${escapeHtml(state.kindroidApiKey)}" placeholder="kn_…" /></label><div class="gm-row"><button id="gm-connect">${state.kindroidConnected ? 'Reconnect' : 'Connect Kindroid'}</button><button id="gm-forget" class="ghost">Forget key</button></div><label><span>Names to detect</span><textarea id="gm-names" placeholder="Type names from the bridge directory…">${escapeHtml(state.groupmakerNames)}</textarea></label><div id="gm-detected" class="gm-detected">${groupmakerDetectedMarkup(people)}</div><label class="gm-check"><input id="gm-v2-mode" type="checkbox" ${state.groupmakerV2Mode ? 'checked' : ''}/><span>Kindroid v2 call URL</span></label><label><span>Location</span><input id="gm-location" value="${escapeHtml(state.groupmakerLocation)}" placeholder="Coffee Shop" /></label><label><span>Position / group name hint</span><input id="gm-position" value="${escapeHtml(state.groupmakerPosition)}" placeholder="Patio table" /></label><label><span>Group context</span><textarea id="gm-context" placeholder="What is happening in this call?">${escapeHtml(state.groupmakerContext)}</textarea></label><div class="gm-row"><button id="gm-sync" ${state.groupmakerBusy ? 'disabled' : ''}>${active ? 'Update active group' : 'Create group'}</button><button id="gm-close-session" class="danger" ${active ? '' : 'disabled'}>Close active</button></div><p class="gm-status">${escapeHtml(state.groupmakerStatus)}</p><div class="gm-sessions"><b>Open sessions</b>${sessions.length ? sessions.map((row) => `<button class="gm-session ${String(row.session_key) === String(state.config.groupmaker_active_session_key) ? 'selected' : ''}" data-session="${escapeHtml(row.session_key)}"><span>${escapeHtml((row.names || []).join(', ') || 'Unnamed')}</span><small>${escapeHtml(row.group_id || '')}</small></button>`).join('') : '<small>No sessions yet.</small>'}</div>`}</aside>`;
}

async function syncGroupmaker() {
  const keyInput = document.querySelector('#gm-api-key');
  if (keyInput) state.kindroidApiKey = keyInput.value.trim();
  const context = state.groupmakerContext.trim();
  const people = detectGroupmakerPeople(state.groupmakerNames);
  const aiList = validAiIds(people.map((person) => person.ai_id));
  if (!state.kindroidApiKey.startsWith('kn_')) { state.groupmakerOpen = true; state.groupmakerStatus = 'Enter a valid Kindroid API key first.'; render(); return; }
  if (!context) { state.groupmakerOpen = true; state.groupmakerStatus = 'Group context is required.'; render(); return; }
  if (!aiList.length) { state.groupmakerOpen = true; state.groupmakerStatus = 'No valid AI IDs detected from the names field.'; render(); return; }
  const active = activeGroupmakerSession();
  const groupName = composeGroupName(people, state.groupmakerPosition || state.groupmakerLocation);
  const locationByAiId = Object.fromEntries(people.filter((p) => state.groupmakerPosition || p.position).map((p) => [p.ai_id, state.groupmakerPosition || p.position]));
  const payload = { ai_list: aiList, group_name: groupName, group_context: context, group_directive: PHONE_CALL_DIRECTIVE, share_short_term_memory: true, use_manual_turntaking: true, ...(active ? { group_id: active.group_id } : {}) };
  const toolKey = active ? 'update_groupchat' : 'create_groupchat';
  const endpoint = active ? '/groupchats-update' : '/groupchats-create';
  const preparedTab = window.open('about:blank', '_blank');
  if (preparedTab) preparedTab.document.title = 'Opening Kindroid group…';
  state.groupmakerBusy = true; state.groupmakerStatus = `${active ? 'Updating' : 'Creating'} GROUPMAKER session…`; render();
  try {
    const result = await kindroidRequest(toolKey, endpoint, payload);
    const now = new Date().toISOString();
    let target = active;
    if (active) {
      Object.assign(target, { ai_list: aiList, names: people.map((p) => p.name), group_name: groupName, group_context: context, group_directive: PHONE_CALL_DIRECTIVE, location_by_ai_id: locationByAiId, share_short_term_memory: true, use_manual_turntaking: true, touched_at: now });
      const opened = openPreparedGroupmakerTab(preparedTab, target.group_id);
      state.groupmakerStatus = `Updated active session (${result.status}). ${opened ? 'Opened Kindroid call tab.' : `Open manually: ${kindroidGroupCallUrl(target.group_id)}`}`;
    } else {
      const groupId = extractGroupId(result.groupIdSource || result.detail);
      if (!groupId) throw new Error('Create succeeded, but no group_id could be parsed from the response.');
      target = { session_key: groupId, group_id: groupId, ai_list: aiList, names: people.map((p) => p.name), group_name: groupName, group_context: context, group_directive: PHONE_CALL_DIRECTIVE, location_by_ai_id: locationByAiId, share_short_term_memory: true, use_manual_turntaking: true, touched_at: now, closed_at: '', idle_at: '' };
      state.config.groupmaker_sessions = groupmakerSessions().filter((row) => row.group_id !== groupId).concat(target);
      state.config.groupmaker_active_session_key = groupId;
      const opened = openPreparedGroupmakerTab(preparedTab, groupId);
      state.groupmakerStatus = `Created active session ${groupId} (${result.status}). ${opened ? 'Opened Kindroid call tab.' : `Open manually: ${kindroidGroupCallUrl(groupId)}`}`;
    }
    persistGroupmakerDraft();
    await saveBridge(`GROUPMAKER ${active ? 'update' : 'create'} session`);
  } catch (error) {
    if (preparedTab && !preparedTab.closed) preparedTab.close();
    state.groupmakerStatus = error.message;
  } finally { state.groupmakerBusy = false; render(); }
}

function bindDirectoryEvents() {
  document.querySelector('#filter').value = state.filter;
  document.querySelector('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  document.querySelector('#filter').addEventListener('change', (e) => { state.filter = e.target.value; render(); });
  document.querySelectorAll('.person').forEach((button) => button.addEventListener('click', () => { state.selectedUid = button.dataset.uid; render(); }));
  document.querySelector('#add').addEventListener('click', () => { const entry = ensureEntry({ ...DEFAULT_ENTRY, name: 'New Person' }); entries().push(entry); state.selectedUid = entry.directory_uid; saveBridge('Add directory person'); });
  document.querySelector('#archive').addEventListener('click', () => { const entry = selectedEntry(); if (entry) { entry.archived = !entry.archived; saveBridge('Archive directory person'); } });
  document.querySelector('#remove').addEventListener('click', () => { const entry = selectedEntry(); if (entry && confirm(`Remove ${entry.name || 'this person'}?`)) { state.config.directory_entries = entries().filter((item) => item.directory_uid !== entry.directory_uid); state.selectedUid = ''; saveBridge('Remove directory person'); } });
  document.querySelector('#logout').addEventListener('click', () => { state.authenticated = false; state.accessKey = ''; localStorage.removeItem(TOKEN_STORAGE_KEY); render(); });
  document.querySelector('#save').addEventListener('click', () => saveBridge('Update directory'));
  document.querySelector('#import').addEventListener('click', () => document.querySelector('#file').click());
  document.querySelector('#file').addEventListener('change', importLegacyFile);
  document.querySelector('#groupmaker-toggle').addEventListener('click', () => { state.groupmakerOpen = !state.groupmakerOpen; render(); });
  document.querySelector('#gm-reconnect')?.addEventListener('click', syncGroupmaker);
  document.querySelector('#gm-close')?.addEventListener('click', () => { state.groupmakerOpen = false; render(); });
  document.querySelector('#gm-min')?.addEventListener('click', () => { state.groupmakerMinimized = !state.groupmakerMinimized; render(); });
  document.querySelector('#gm-api-key')?.addEventListener('input', (e) => { state.kindroidApiKey = e.target.value.trim(); });
  document.querySelector('#gm-v2-mode')?.addEventListener('change', (e) => { state.groupmakerV2Mode = e.target.checked; state.groupmakerStatus = `${state.groupmakerV2Mode ? 'Kindroid v2 mode enabled' : 'Kindroid standard mode enabled'}. The next create/update opens the matching group call URL.`; scheduleGroupmakerDraftSave(); render(); });
  document.querySelector('#gm-connect')?.addEventListener('click', () => { state.kindroidApiKey = document.querySelector('#gm-api-key').value.trim(); state.kindroidConnected = state.kindroidApiKey.startsWith('kn_'); if (state.kindroidConnected) { localStorage.setItem(KINDROID_API_KEY_STORAGE_KEY, state.kindroidApiKey); state.groupmakerStatus = 'Kindroid API key connected locally. Ready to create or update groups.'; } else { state.groupmakerStatus = 'Kindroid API keys should start with kn_.'; } render(); });
  document.querySelector('#gm-forget')?.addEventListener('click', () => { state.kindroidApiKey = ''; state.kindroidConnected = false; localStorage.removeItem(KINDROID_API_KEY_STORAGE_KEY); state.groupmakerStatus = 'Kindroid API key forgotten.'; render(); });
  document.querySelector('#gm-sync')?.addEventListener('click', syncGroupmaker);
  document.querySelector('#gm-close-session')?.addEventListener('click', () => { const active = activeGroupmakerSession(); if (active) { active.closed_at = new Date().toISOString(); state.config.groupmaker_active_session_key = ''; saveBridge('GROUPMAKER close session'); } });
  document.querySelectorAll('.gm-session').forEach((button) => button.addEventListener('click', () => { state.config.groupmaker_active_session_key = button.dataset.session; saveBridge('GROUPMAKER activate session'); }));
  ['names', 'location', 'position', 'context'].forEach((key) => { document.querySelector(`#gm-${key}`)?.addEventListener('input', (e) => { state[`groupmaker${key[0].toUpperCase()}${key.slice(1)}`] = e.target.value; if (key === 'names') refreshGroupmakerDetectedList(); scheduleGroupmakerDraftSave(); }); });
  const current = selectedEntry();
  if (!current) return;
  document.querySelector('#toggle-online').addEventListener('click', () => { current.online = !current.online; saveBridge('Update online status'); });
  document.querySelectorAll('[data-field]').forEach((input) => input.addEventListener('input', (e) => { current[e.target.dataset.field] = e.target.value; }));
  document.querySelector('#fetch-rules').addEventListener('input', (e) => { try { current.fetch_rules = JSON.parse(e.target.value || '[]'); e.target.classList.remove('invalid'); } catch { e.target.classList.add('invalid'); } });
}

async function importLegacyFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    state.config = normalizeImported(JSON.parse(await file.text()));
    entries().forEach(ensureEntry);
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
  state.syncDetail = 'Remembered GitHub credential found; connecting automatically…';
  loadBridge();
  return true;
}

function render() { state.authenticated ? renderDirectory() : renderLogin(); }

const style = document.createElement('style');
style.textContent = `
:root{color-scheme:dark;--bg:#030512;--panel:rgba(9,15,33,.72);--panel-strong:rgba(13,20,43,.9);--line:rgba(255,255,255,.13);--text:#f8fbff;--muted:#9fb0cf;--cyan:#69e5ff;--violet:#8b5cf6;--green:#54f6a6;--pink:#ff6bcb;--warn:#ffb86b;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% 8%,rgba(105,229,255,.24),transparent 30rem),radial-gradient(circle at 82% 8%,rgba(139,92,246,.28),transparent 34rem),radial-gradient(circle at 50% 105%,rgba(84,246,166,.12),transparent 28rem),linear-gradient(135deg,#030512,#081126 58%,#14091f);overflow-x:hidden}body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(circle at center,#000,transparent 78%)}button,input,select,textarea{font:inherit}button{border:0;border-radius:18px;background:linear-gradient(135deg,var(--cyan),var(--violet));color:#03101c;font-weight:900;padding:.95rem 1.1rem;cursor:pointer;box-shadow:0 18px 42px rgba(72,132,255,.24);transition:transform .18s ease,filter .18s ease,box-shadow .18s ease}button:hover{transform:translateY(-2px);filter:saturate(1.12);box-shadow:0 22px 56px rgba(72,132,255,.32)}button:disabled{opacity:.6;cursor:wait;transform:none}.ghost{background:rgba(255,255,255,.075);color:#dce8ff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}.danger{background:linear-gradient(135deg,#ff6b8a,var(--warn))}.eyebrow{margin:0 0 .7rem;color:var(--cyan);font-size:.74rem;font-weight:950;letter-spacing:.2em;text-transform:uppercase}h1{margin:0;font-size:clamp(2.7rem,7vw,6.4rem);line-height:.88;letter-spacing:-.075em}input,select,textarea{width:100%;border:1px solid rgba(148,190,255,.22);border-radius:18px;background:rgba(4,9,22,.78);color:var(--text);padding:.95rem 1rem;outline:none;transition:border-color .2s,box-shadow .2s,background .2s}textarea{min-height:116px;resize:vertical}input:focus,select:focus,textarea:focus{border-color:var(--cyan);box-shadow:0 0 0 4px rgba(105,229,255,.12);background:rgba(7,14,33,.92)}.login-shell{display:grid;min-height:100vh;place-items:center;padding:2rem}.login-card{position:relative;isolation:isolate;width:min(760px,100%);padding:clamp(2rem,6vw,5rem);border:1px solid var(--line);border-radius:46px;background:linear-gradient(145deg,rgba(9,14,30,.86),rgba(15,8,32,.76));box-shadow:0 45px 130px rgba(0,0,0,.56);backdrop-filter:blur(30px);overflow:hidden;animation:rise .7s cubic-bezier(.2,.8,.2,1) both}.orb{position:absolute;inset:-30% auto auto 48%;z-index:-1;width:28rem;height:28rem;border-radius:999px;background:conic-gradient(from 90deg,var(--cyan),var(--violet),var(--green),var(--cyan));filter:blur(28px);opacity:.26;animation:spin 12s linear infinite}.lede,.sync-note{color:#c5d4ee;line-height:1.8}.access-form{display:grid;gap:1rem;margin-top:2rem}.access-form label,.field-grid span{color:#9cc8ff;font-size:.76rem;font-weight:950;letter-spacing:.13em;text-transform:uppercase}.remember{display:flex;gap:.65rem;align-items:center;letter-spacing:0!important;text-transform:none!important}.remember input{width:auto}.app-shell{display:grid;grid-template-columns:minmax(520px,38vw) minmax(0,1fr);gap:1.25rem;min-height:100vh;padding:1.25rem}.sidebar,.editor{border:1px solid var(--line);border-radius:34px;background:linear-gradient(180deg,rgba(12,19,42,.78),rgba(7,12,27,.68));box-shadow:0 26px 90px rgba(0,0,0,.36);backdrop-filter:blur(24px)}.sidebar{position:sticky;top:1.25rem;height:calc(100vh - 2.5rem);display:flex;flex-direction:column;gap:.75rem;padding:1rem;animation:slideIn .55s ease both}.brand-block{display:flex;gap:.85rem;align-items:center}.brand-mark{display:grid;place-items:center;width:3.25rem;height:3.25rem;border-radius:18px;background:linear-gradient(135deg,var(--cyan),var(--pink));color:#051022;font-weight:1000;box-shadow:0 14px 32px rgba(105,229,255,.22)}.sidebar h2{margin:0;font-size:2rem;letter-spacing:-.055em}.sync-pill{display:grid;grid-template-columns:auto 1fr;gap:.18rem .65rem;padding:.85rem;border:1px solid rgba(84,246,166,.2);border-radius:20px;background:linear-gradient(135deg,rgba(84,246,166,.09),rgba(105,229,255,.05))}.sync-pill span{grid-row:1/3;width:.72rem;height:.72rem;margin-top:.25rem;border-radius:999px;background:var(--green);box-shadow:0 0 0 0 rgba(84,246,166,.72);animation:pulse 1.8s infinite}.sync-pill small,.person small,.hero-meta,.gm-detected small,.gm-status,.gm-sessions small{color:var(--muted)}.quick-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:.55rem}.quick-stats div{padding:.72rem .5rem;border:1px solid rgba(255,255,255,.1);border-radius:18px;background:rgba(255,255,255,.055);text-align:center}.quick-stats b{display:block;font-size:1.25rem}.quick-stats span{font-size:.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:.12em}.search-card{display:grid;grid-template-columns:1fr;gap:.55rem;padding:.65rem;border:1px solid rgba(255,255,255,.09);border-radius:22px;background:rgba(255,255,255,.04)}.search-card label{grid-column:1/-1;color:#9cc8ff;font-size:.72rem;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.search-card select{min-width:0}.people-list{display:grid;gap:.55rem;overflow:auto;flex:1;min-height:360px;padding:.15rem .35rem .15rem 0;scrollbar-width:thin}.person{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:.85rem;background:rgba(255,255,255,.055);color:#eaf2ff;box-shadow:none;text-align:left;border:1px solid transparent;min-width:0;padding:.9rem 1rem}.person.selected{border-color:rgba(105,229,255,.8);background:linear-gradient(135deg,rgba(105,229,255,.16),rgba(139,92,246,.1));box-shadow:0 16px 34px rgba(105,229,255,.11)}.avatar{position:relative;display:grid;place-items:center;width:2.55rem;height:2.55rem;border-radius:16px;background:rgba(255,255,255,.1);color:#d8e8ff;font-size:.86rem}.avatar.online{background:rgba(84,246,166,.18);color:#a6ffd0}.avatar:after{content:"";position:absolute;right:-.12rem;bottom:-.12rem;width:.72rem;height:.72rem;border:2px solid #111a33;border-radius:999px;background:#ff6b8a}.avatar.online:after{background:var(--green)}.person-copy{min-width:0}.person-copy strong,.person-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:normal;overflow-wrap:anywhere}.person-copy strong{font-size:1.08rem;line-height:1.28}.person-copy small{margin-top:.2rem;line-height:1.35}.action-stack{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem;margin-top:.4rem}.action-stack .gm-reconnect,.action-stack #logout{grid-column:1/-1}.editor{position:relative;padding:clamp(1.25rem,3vw,2.35rem);overflow:hidden;animation:rise .65s ease both}.editor:before{content:"";position:absolute;inset:0 0 auto;height:13rem;background:linear-gradient(135deg,rgba(105,229,255,.12),rgba(255,107,203,.08));pointer-events:none}.hero-line{position:relative;display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1.15rem}.hero-line h1{font-size:clamp(2.4rem,6vw,5.3rem)}.hero-meta{display:flex;flex-wrap:wrap;gap:.55rem;margin-top:.9rem}.hero-meta span{padding:.42rem .65rem;border:1px solid rgba(255,255,255,.1);border-radius:999px;background:rgba(255,255,255,.06);font-size:.78rem}.status-grid{position:relative;display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:1rem;margin-bottom:1rem}.status,.asset-card{min-height:108px;border:1px solid rgba(255,255,255,.12);border-radius:24px;background:rgba(255,80,103,.12);color:#ffc0ca;display:grid;align-content:center;gap:.25rem;padding:1rem;font-size:1.55rem;font-weight:950;box-shadow:none;text-align:left}.status.on{background:rgba(84,246,166,.12);color:#9dffc9}.status small,.asset-card span{font-size:.72rem;letter-spacing:.15em;text-transform:uppercase;color:var(--muted)}.asset-card{background:rgba(105,229,255,.08);color:#b5ecff}.asset-card.accent{background:rgba(139,92,246,.1);color:#dbcfff}.progress{height:.52rem;border-radius:999px;background:rgba(255,255,255,.09);overflow:hidden}.progress i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--green),var(--cyan));animation:grow .75s ease both}.field-grid{position:relative;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.field-grid label,.fetch-card{display:grid;gap:.5rem;padding:1rem;border:1px solid rgba(255,255,255,.1);border-radius:24px;background:rgba(255,255,255,.048);transition:transform .18s,border-color .18s,background .18s}.field-grid label:focus-within,.fetch-card:focus-within{transform:translateY(-2px);border-color:rgba(105,229,255,.45);background:rgba(105,229,255,.055)}.field-grid .wide{grid-column:1/-1}.fetch-card{position:relative;margin-top:1rem}.fetch-card h3{margin:.1rem 0;color:#f3b3ff;font-size:1.35rem}.invalid{border-color:#ff6b8a!important}.gm-reconnect{display:grid;grid-template-columns:auto 1fr;gap:.05rem .55rem;align-items:center;width:100%;padding:.85rem 1rem;text-align:left;border:1px solid rgba(84,246,166,.42);background:linear-gradient(135deg,rgba(84,246,166,.96),rgba(105,229,255,.94));box-shadow:0 14px 34px rgba(84,246,166,.18)}.gm-reconnect span{grid-row:1/3;font-size:1.5rem}.gm-reconnect small{font-size:.7rem;color:#123042}.gm-reconnect.needs-setup{border-color:rgba(255,184,107,.55);background:linear-gradient(135deg,var(--warn),#ff6b8a)}.groupmaker-float{position:fixed;right:1.25rem;bottom:1.25rem;z-index:20;width:clamp(430px,34vw,680px);max-width:calc(100vw - 2.5rem);max-height:calc(100vh - 2.5rem);overflow:auto;padding:1rem;border:1px solid rgba(105,229,255,.28);border-radius:30px;background:rgba(5,10,24,.94);box-shadow:0 30px 100px rgba(0,0,0,.62);backdrop-filter:blur(26px);animation:floatUp .32s ease both}.groupmaker-float.mini{width:300px}.gm-head,.gm-row{display:flex;align-items:center;justify-content:space-between;gap:.7rem}.gm-head h3{margin:.1rem 0 0;font-size:1.35rem}.groupmaker-float label{display:grid;gap:.35rem;margin-top:.75rem}.groupmaker-float #gm-names{min-height:170px}.groupmaker-float #gm-context{min-height:150px}.groupmaker-float .gm-check{display:flex;align-items:center;gap:.55rem}.gm-check input{width:auto}.groupmaker-float label span{color:#9cc8ff;font-size:.72rem;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.gm-detected{display:grid;grid-template-columns:1fr auto;gap:.25rem .6rem;margin:.65rem 0;padding:.75rem;border:1px solid rgba(255,255,255,.1);border-radius:18px;background:rgba(255,255,255,.045)}.gm-status{line-height:1.45}.gm-sessions{display:grid;gap:.45rem;margin-top:.75rem}.gm-session{display:grid;gap:.15rem;text-align:left;background:rgba(255,255,255,.06);color:#eaf2ff;box-shadow:none}.gm-session.selected{outline:2px solid rgba(84,246,166,.7)}.empty{padding:4rem;text-align:center;color:var(--muted);border:1px dashed rgba(255,255,255,.18);border-radius:26px}.empty.small{padding:1rem}@keyframes pulse{70%{box-shadow:0 0 0 14px rgba(84,246,166,0)}100%{box-shadow:0 0 0 0 rgba(84,246,166,0)}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes rise{from{opacity:0;transform:translateY(20px) scale(.985)}to{opacity:1;transform:none}}@keyframes slideIn{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}@keyframes floatUp{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}@keyframes grow{from{width:0}}@media(max-width:1180px){.status-grid{grid-template-columns:1fr 1fr}.status-grid .accent{grid-column:1/-1}}@media(max-width:1180px){.app-shell{grid-template-columns:1fr}.sidebar{position:relative;top:0;height:auto;min-height:0}.people-list{min-height:260px}}@media(max-width:980px){.app-shell{grid-template-columns:1fr}.sidebar{position:relative;top:0;height:auto}.field-grid,.status-grid{grid-template-columns:1fr}.search-card{grid-template-columns:1fr}.quick-stats{grid-template-columns:repeat(2,1fr)}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
document.head.append(style);
if (!startRememberedLogin()) render();
