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
const LEGACY_BRIDGE_PATHS = ['config.backup.json', 'kindroidxl_directory/config.json', 'kindroidxl_directory/config.backup.json', 'backups/config.json', 'backups/config.backup.json'];
const TOKEN_STORAGE_KEY = 'lifeline.bridge.accessKey';
const REMEMBER_STORAGE_KEY = 'lifeline.bridge.rememberAccessKey';
const KINDROID_API_KEY_STORAGE_KEY = 'lifeline.kindroid.apiKey';
const KINDROID_BASE_URL = 'https://api.kindroid.ai/v1';
const GROUPMAKER_REQUESTER = 'LIFELINE-MAINJS-GROUPMAKER';
const PHONE_CALL_DIRECTIVE = 'This is a phone call. Respond in direct speech only. Avoid action or inner thought narration. Keep it concise.';
const REMEMBERED_ACCESS_KEY = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
const REMEMBERED_KINDROID_API_KEY = localStorage.getItem(KINDROID_API_KEY_STORAGE_KEY) || '';
const REMEMBERED_KINDROID_CONNECTED = REMEMBERED_KINDROID_API_KEY.trim().startsWith('kn_');
const REMEMBERED_GITHUB_LOGIN_ENABLED = localStorage.getItem(REMEMBER_STORAGE_KEY) === 'true' && Boolean(REMEMBERED_ACCESS_KEY.trim());
let groupmakerDraftSaveTimer = null;
const groupmakerKindroidTabs = new Set();

const DIRECTORY_API_METADATA = {
  name: 'Officially synchronized: update_info.ai_name',
  gender: 'Officially synchronized: update_info.ai_gender',
  ai_id: 'Official conversation identifier',
  backstory: 'Officially synchronized: update_info.ai_backstory',
  ai_memory: 'Officially synchronized: update_info.ai_memory',
  greeting: 'Officially synchronized for chat-break greeting only',
  directive: 'Officially synchronized: update_info.ai_directive',
  additional_context: 'Officially synchronized: update_info.ai_additional_context',
  temperature: 'Experimentally synchronized: update_kin_legacy.user_set_temperature',
  reasoning_effort: 'Experimentally synchronized: update_kin_legacy.reasoning_effort',
  llm_flair: 'Experimentally synchronized: update_kin_legacy.llm_flair',
  avatar_preset: 'Experimentally synchronized: update_kin_legacy.ai_avatar',
  avatar_description: 'Experimentally synchronized: update_kin_legacy.custom_avatar_description',
  age: 'Local only',
  location: 'Local only',
  position: 'Local only',
};

const DIRECTORY_FIELDS = [
  ['name', 'NAME', 'line'],
  ['gender', 'GENDER', 'line'],
  ['age', 'AGE', 'age_combo'],
  ['ai_id', 'ID', 'line'],
  ['location', 'ACTIVITY', 'line'],
  ['position', 'POSITION', 'line'],
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
};

const state = {
  accessKey: REMEMBERED_ACCESS_KEY,
  rememberKey: localStorage.getItem(REMEMBER_STORAGE_KEY) === 'true',
  authenticated: false,
  syncState: REMEMBERED_GITHUB_LOGIN_ENABLED ? 'Auto login' : 'Locked',
  syncDetail: REMEMBERED_GITHUB_LOGIN_ENABLED
    ? 'Remembered access key found; connecting automatically…'
    : 'Enter your access key.',
  config: { directory_entries: [] },
  bridgeSha: '',
  selectedUid: '',
  filter: 'active',
  search: '',
  saving: false,
  kindroidApiKey: REMEMBERED_KINDROID_API_KEY,
  kindroidConnected: REMEMBERED_KINDROID_CONNECTED,
  groupmakerOpen: true,
  groupmakerMinimized: false,
  groupmakerBusy: false,
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
  groupmakerStatus: REMEMBERED_KINDROID_CONNECTED
    ? 'Remembered Kindroid API key loaded locally. Ready to create or update groups.'
    : 'Enter your Kindroid API key to enable GROUPMAKER.',
  groupmakerNames: '',
  groupmakerLocation: '',
  groupmakerPosition: '',
  groupmakerContext: '',
  activeEntryTab: 'profile',
  settingsOpen: false,
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
  draft.position = state.groupmakerPosition;
  draft.context = state.groupmakerContext;
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

function latestOpenGroupmakerSession() {
  return groupmakerSessions().filter((row) => !String(row.closed_at || '').trim() && !String(row.idle_at || '').trim() && String(row.group_id || '').trim()).slice().sort((a, b) => String(b.touched_at || '').localeCompare(String(a.touched_at || '')))[0] || null;
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




// KINDROID API FOUNDATION — registry, client, studio helpers.
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
  create_journal_entry: op('create_journal_entry','Create Journal Entry','memory_journals','experimental_unverified','POST','/create-journal-entry',[kField('ai_id','AI ID','ai_selector',{required:true}),kField('entry','Entry','textarea',{required:true,support:'experimental',officiallySupported:false,sensitive:true}),kField('keyphrases','Keyphrases','csv',{support:'experimental',officiallySupported:false})],{sourceNotes:[legacySource('Retained from Memory Cleaner/Feeder remote journal jobs.')] }),
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

function closePriorGroupmakerTabs() {
  for (const tab of [...groupmakerKindroidTabs]) {
    if (!tab || tab.closed) {
      groupmakerKindroidTabs.delete(tab);
      continue;
    }
    try { tab.close(); } catch {}
    groupmakerKindroidTabs.delete(tab);
  }
}

function rememberGroupmakerTab(tabRef) {
  if (tabRef && !tabRef.closed) groupmakerKindroidTabs.add(tabRef);
}

function openPreparedGroupmakerTab(tabRef, groupId) {
  const url = kindroidGroupCallUrl(groupId);
  if (!url) return false;
  if (window.lifelineElectron?.openKindroidCall) {
    window.lifelineElectron.openKindroidCall({ url, groupId, accessKey: state.accessKey, session: reconnectGroupmakerSession() }).catch(() => {});
    return true;
  }
  if (tabRef && !tabRef.closed) {
    tabRef.location.href = url;
    try { tabRef.focus(); } catch {}
    rememberGroupmakerTab(tabRef);
    return true;
  }
  const opened = window.open(url, '_blank');
  rememberGroupmakerTab(opened);
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

function findGenerationPersonForEntry(entry) {
  if (!entry) return null;
  const aiId = String(entry.ai_id || '').trim();
  const name = String(entry.name || '').trim().toLowerCase();
  return generationPeople().find((person) => (aiId && String(person.directory_ai_id || '').trim() === aiId) || (name && String(person.name || '').trim().toLowerCase() === name)) || null;
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
  person.directory_ai_id = String(entry.ai_id || '').trim();
  person.name = String(entry.name || '').trim();
  person.status = String(person.status || '').trim();
  person.sex = String(person.sex || entry.gender || '').trim();
  person.notes = String(person.notes || '').trim();
  return person;
}

function generationById() {
  return new Map(generationPeople().filter((person) => String(person.id || '').trim()).map((person) => [String(person.id).trim(), person]));
}

function cleanGenerationIds(ids, selfId = '') {
  const byId = generationById();
  const seen = new Set();
  return (Array.isArray(ids) ? ids : String(ids || '').split(/[\n,]+/)).map((id) => String(id || '').trim()).filter((id) => id && id !== selfId && byId.has(id) && !seen.has(id) && seen.add(id));
}

function generationOptions(selectedIds = [], selfId = '') {
  const selected = new Set(selectedIds);
  return generationPeople().filter((person) => String(person.id || '').trim() && String(person.id).trim() !== selfId).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))).map((person) => {
    const id = String(person.id).trim();
    const label = String(person.name || 'Unnamed').trim();
    return `<label class="relation-choice"><input type="checkbox" value="${escapeHtml(id)}" ${selected.has(id) ? 'checked' : ''}/><span>${escapeHtml(label)}</span><small>${escapeHtml(person.status || person.sex || 'Family profile')}</small></label>`;
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

function renderGenerationsSection(entry) {
  const person = ensureGenerationPerson(entry);
  const parents = cleanGenerationIds(person.parents, person.id);
  const children = cleanGenerationIds(person.children, person.id);
  return `<section id="generations-section" class="generations-card tab-panel ${state.activeEntryTab === 'family' ? 'active' : ''}"><div><p class="eyebrow">FAMILY MAP</p><h3>Relationships & household</h3><p class="sync-note">Build ancestry and descendant links with clean cards saved in config.json as generations_people.</p></div>${generationTreeMarkup({ ...person, parents, children })}<div class="generation-summary"><div><b>${parents.length}</b><span>Parents</span></div><div><b>${children.length}</b><span>Children</span></div></div><form id="generation-form" class="field-grid generation-form"><label><span>SEX</span><input data-generation-field="sex" value="${escapeHtml(person.sex || '')}" /></label><label class="wide"><span>NOTES</span><textarea data-generation-field="notes">${escapeHtml(person.notes || '')}</textarea></label></form><div class="relations-grid"><section class="relation-card"><div class="relation-card-head"><span>↑</span><div><h4>Parents & ancestry</h4><p>Choose people who sit above this profile.</p></div></div><ul class="relation-pills">${relationList(parents)}</ul><div id="generation-parents" class="relation-picker">${generationOptions(parents, person.id)}</div></section><section class="relation-card"><div class="relation-card-head"><span>↓</span><div><h4>Children & descendants</h4><p>Choose people directly below this profile.</p></div></div><ul class="relation-pills">${relationList(children)}</ul><div id="generation-children" class="relation-picker">${generationOptions(children, person.id)}</div></section></div></section>`;
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

function isGithubShaMismatch(error) {
  const message = String(error?.message || '');
  return /does not match/i.test(message) || /sha/i.test(message) && /match/i.test(message);
}

async function refreshBridgeSha() {
  const { sha } = await readGithubContentFile(BRIDGE_PATH);
  state.bridgeSha = sha;
  return sha;
}

async function writeBridgeConfig(reason, retryOnShaMismatch = true) {
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
    return { payload, retried: false };
  } catch (error) {
    if (!retryOnShaMismatch || !isGithubShaMismatch(error)) throw error;
    await refreshBridgeSha();
    const payload = await githubRequest(bridgeUrl(BRIDGE_PATH, false), {
      method: 'PUT',
      body: JSON.stringify({
        message: `${reason} via LIFELINE frontend`,
        content: encodeBase64(state.config),
        branch: BRIDGE_BRANCH,
        sha: state.bridgeSha,
      }),
    });
    state.bridgeSha = payload.content?.sha || state.bridgeSha;
    return { payload, retried: true };
  }
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
      const generationsCount = Array.isArray(config.generations_people) ? config.generations_people.length : 0;
      const sessionsCount = Array.isArray(config.groupmaker_sessions) ? config.groupmaker_sessions.length : 0;
      const richness = count * 1000 + generationsCount * 100 + sessionsCount * 10 + Object.keys(config || {}).length;
      loadedCandidates.push({ path, sha, config, count, generationsCount, sessionsCount, richness });
    } catch (error) {
      lastError = error;
      if (!/not found/i.test(error.message)) break;
    }
  }
  const bestCandidate = loadedCandidates.slice().sort((a, b) => b.richness - a.richness)[0];
  if (bestCandidate) {
    state.bridgeSha = bestCandidate.path === BRIDGE_PATH ? bestCandidate.sha : '';
    state.config = bestCandidate.config;
    entries().forEach(ensureEntry);
    hydrateGroupmakerDraft();
    state.authenticated = true;
    state.syncState = 'Online';
    state.syncDetail = bestCandidate.path === BRIDGE_PATH
      ? `Restored ${entries().length} directory entries from ${BRIDGE_REPO}/${BRIDGE_PATH}.`
      : `Recovered ${entries().length} entries from bridge backup path ${bestCandidate.path}; next save will migrate them to ${BRIDGE_PATH}.`;
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
    const { retried } = await writeBridgeConfig(reason);
    state.syncState = 'Synced';
    state.syncDetail = retried
      ? `Saved ${entries().length} entries to ${BRIDGE_PATH} after refreshing the latest GitHub version.`
      : `Saved ${entries().length} entries to ${BRIDGE_PATH}.`;
  } catch (error) {
    state.syncState = 'Save failed'; state.syncDetail = error.message;
  } finally {
    state.saving = false; render();
  }
}


async function saveBridgeQuiet(reason = 'Update directory') {
  try {
    const { retried } = await writeBridgeConfig(reason);
    state.syncState = 'Synced';
    state.syncDetail = retried
      ? `Saved GROUPMAKER draft to ${BRIDGE_PATH} after refreshing the latest GitHub version.`
      : `Saved GROUPMAKER draft to ${BRIDGE_PATH}.`;
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

function renderMemorySection(person) {
  const aiId = String(person?.ai_id || '').trim();
  const relatedSessions = groupmakerSessions().filter((session) => Array.isArray(session.ai_list) && session.ai_list.map(String).includes(aiId));
  const active = relatedSessions.filter((session) => !String(session.closed_at || '').trim() && !String(session.idle_at || '').trim());
  return `<section class="memory-card tab-panel ${state.activeEntryTab === 'memory' ? 'active' : ''}"><div><p class="eyebrow">MEMORY</p><h3>Bridge transcript memory pipeline</h3><p class="sync-note">Electron call windows capture Kindroid call text with DOM injection and append it to ${BRIDGE_REPO}/transcripts. The LIFELINE Memory Manager can be launched later to restore its SQLite memory database from the bridge and process pending transcript files.</p></div><div class="generation-summary"><div><b>${escapeHtml(aiId || '—')}</b><span>AI ID</span></div><div><b>${active.length}</b><span>Open call sessions</span></div></div><div class="relations-grid"><section class="relation-card"><h4>Transcript destinations</h4><p>Group calls involving this person are saved under <code>transcripts/&lt;group_id&gt;/YYYY-MM-DD.txt</code> in the bridge repo.</p></section><section class="relation-card"><h4>Memory backups</h4><p>The memory manager restores and backs up <code>memory/lifeline_memory.latest.db</code>, with timestamped snapshots under <code>memory/snapshots/</code>.</p></section></div><pre>${escapeHtml(JSON.stringify(relatedSessions.map((session) => ({ group_id: session.group_id, names: session.names, touched_at: session.touched_at, closed_at: session.closed_at })), null, 2))}</pre></section>`;
}

function renderSettingsPanel() {
  if (!state.settingsOpen) return '';
  return `<section class="settings-panel"><div><p class="eyebrow">SETTINGS</p><h3>Bridge settings</h3><p class="sync-note">Import a config.json file from one dedicated settings area.</p></div><button id="import" class="ghost" type="button">Import config.json</button><input id="file" type="file" accept="application/json,.json" hidden /></section>`;
}

function profileStatusMarkup(entry) {
  const generation = ensureGenerationPerson(entry);
  return `<label class="status-field"><span>STATUS</span><input data-generation-field="status" value="${escapeHtml(generation.status || '')}" placeholder="Alive, Elder, Deceased…" /></label>`;
}

function renderDirectory() {
  const list = filteredEntries();
  if (!state.selectedUid && list[0]) state.selectedUid = list[0].directory_uid;
  const current = selectedEntry();
  const onlineLabel = current?.online ? 'Available now' : 'Standing by';
  root.innerHTML = `<main class="app-shell"><aside class="sidebar"><div class="sync-pill" title="Sync status"><span></span><b>${escapeHtml(state.syncState)}</b><small>${escapeHtml(state.syncDetail)}</small></div><div class="search-card"><input id="search" value="${escapeHtml(state.search)}" placeholder="Search DIRECTORY…" aria-label="Search DIRECTORY"/><select id="filter" aria-label="Directory filter"><option value="active">Active</option><option value="all">All</option></select></div><div class="people-list">${list.map((entry) => `<button class="person ${entry.directory_uid === state.selectedUid ? 'selected' : ''}" data-uid="${entry.directory_uid}"><span class="avatar ${entry.online ? 'online' : ''}">${entryInitials(entry)}</span><span class="person-copy"><strong>${escapeHtml(entry.name || 'Unnamed person')}</strong><small>${escapeHtml(entry.online ? 'Live now' : 'Offline')} · ${escapeHtml(entryMeta(entry))}</small></span></button>`).join('') || '<div class="empty small">No people match this view.</div>'}</div><div class="action-stack icon-actions"><button id="add" title="Add person">＋</button><button id="remove" class="danger" title="Remove person">🗑</button><button id="settings-toggle" class="ghost" title="Settings">⚙</button><button id="groupmaker-toggle" class="ghost" title="GROUPMAKER Studio">☷</button><button id="api-studio-toggle" class="ghost" title="Kindroid API Studio">API</button>${renderGroupmakerReconnectButton()}</div>${renderSettingsPanel()}</aside><section class="editor"><div class="hero-line"><div><h1>${escapeHtml(current?.name || 'No person selected')}</h1><div class="hero-meta"><span>${escapeHtml(onlineLabel)}</span><span>${escapeHtml(current?.location || 'No location')}</span></div></div><button id="save" title="Save and sync" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save'}</button></div>${current ? `<div class="entry-tabs" role="tablist"><button class="tab ${state.activeEntryTab === 'profile' ? 'active' : ''}" type="button" role="tab" aria-selected="${state.activeEntryTab === 'profile'}" data-tab="profile">PROFILE</button><button class="tab ${state.activeEntryTab === 'family' ? 'active' : ''}" type="button" role="tab" aria-selected="${state.activeEntryTab === 'family'}" data-tab="family">FAMILY</button><button class="tab ${state.activeEntryTab === 'memory' ? 'active' : ''}" type="button" role="tab" aria-selected="${state.activeEntryTab === 'memory'}" data-tab="memory">MEMORY</button></div><div class="tab-stage"><section class="profile-panel tab-panel ${state.activeEntryTab === 'profile' ? 'active' : ''}"><div class="status-grid"><button id="toggle-online" class="status ${current.online ? 'on' : ''}"><span>${current.online ? 'ONLINE' : 'OFFLINE'}</span><small>${current.online ? 'Ready for routing' : 'Hidden from live flow'}</small></button>${profileStatusMarkup(current)}<div class="asset-card accent"><b>${escapeHtml(current.location || '—')}</b><span>ACTIVE LOCATION</span></div></div><form id="entry-form" class="field-grid">${DIRECTORY_FIELDS.map(([key, label, kind]) => fieldMarkup(current, key, label, kind)).join('')}</form></section>${renderGenerationsSection(current)}${renderMemorySection(current)}</div>` : '<div class="empty">Add a person or import a legacy config to begin.</div>'}</section>${renderKindroidApiStudio()}${renderGroupmakerWindow()}</main>`;
  bindDirectoryEvents();
}

function fieldMarkup(entry, key, label, kind) {
  const value = entry[key] ?? '';
  if (kind === 'age_combo') return `<label><span>${label} *</span><select data-field="${key}">${AGE_OPTIONS.map((age) => `<option ${age === value ? 'selected' : ''}>${age}</option>`).join('')}</select></label>`;
  if (kind === 'text') return `<label class="wide"><span>${label} *</span><textarea data-field="${key}">${escapeHtml(value)}</textarea></label>`;
  return `<label><span>${label} *</span><input data-field="${key}" value="${escapeHtml(value)}"/></label>`;
}



function groupmakerDetectedMarkup(people = detectGroupmakerPeople(state.groupmakerNames)) {
  return people.length ? people.map((p) => `<b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.ai_id)}</small>`).join('') : '<em>No matching directory people yet.</em>';
}

function refreshGroupmakerDetectedList() {
  const box = document.querySelector('#gm-detected');
  if (box) box.innerHTML = groupmakerDetectedMarkup();
}


function groupmakerReconnectReady() {
  const session = reconnectGroupmakerSession();
  const people = detectGroupmakerPeople(state.groupmakerNames);
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
  const people = detectGroupmakerPeople(state.groupmakerNames);
  const active = activeGroupmakerSession();
  const sessions = groupmakerSessions().filter((row) => !String(row.closed_at || '').trim()).slice().sort((a, b) => String(b.touched_at || '').localeCompare(String(a.touched_at || '')));
  return `<aside class="groupmaker-float ${state.groupmakerMinimized ? 'mini' : ''}"><div class="gm-head"><div><p class="eyebrow">GROUPMAKER</p><h3>Kindroid bridge</h3></div><div><button id="gm-min" class="ghost">${state.groupmakerMinimized ? 'Open' : 'Min'}</button><button id="gm-close" class="ghost">×</button></div></div>${state.groupmakerMinimized ? '' : `<label><span>Kindroid API key</span><input id="gm-api-key" type="password" value="${escapeHtml(state.kindroidApiKey)}" placeholder="kn_…" /></label><div class="gm-row"><button id="gm-connect">${state.kindroidConnected ? 'Reconnect' : 'Connect Kindroid'}</button><button id="gm-forget" class="ghost">Forget key</button></div><label><span>Names to detect</span><textarea id="gm-names" placeholder="Type names from the bridge directory…">${escapeHtml(state.groupmakerNames)}</textarea></label><div id="gm-detected" class="gm-detected">${groupmakerDetectedMarkup(people)}</div><label><span>Location</span><input id="gm-location" value="${escapeHtml(state.groupmakerLocation)}" placeholder="Coffee Shop" /></label><label><span>Position / group name hint</span><input id="gm-position" value="${escapeHtml(state.groupmakerPosition)}" placeholder="Patio table" /></label><label><span>Group context</span><textarea id="gm-context" placeholder="What is happening in this call?">${escapeHtml(state.groupmakerContext)}</textarea></label><div class="gm-row"><button id="gm-sync" ${state.groupmakerBusy ? 'disabled' : ''}>${active ? 'Update active group' : 'Create group'}</button><button id="gm-close-session" class="danger" ${active ? '' : 'disabled'}>Close active</button></div><p class="gm-status">${escapeHtml(state.groupmakerStatus)}</p><div class="gm-sessions"><b>Open sessions</b>${sessions.length ? sessions.map((row) => `<button class="gm-session ${String(row.session_key) === String(state.config.groupmaker_active_session_key) ? 'selected' : ''}" data-session="${escapeHtml(row.session_key)}"><span>${escapeHtml((row.names || []).join(', ') || 'Unnamed')}</span><small>${escapeHtml(row.group_id || '')}</small></button>`).join('') : '<small>No sessions yet.</small>'}</div>`}</aside>`;
}


function groupmakerPhysicalLocation() {
  return String(state.groupmakerLocation || '').trim();
}

function sameNormalizedText(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
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

async function runGroupmakerPresenceAutomations({ people = [], groupId = '', active = null, aiList = [] } = {}) {
  const location = groupmakerPhysicalLocation();
  const report = { directSent: 0, groupSent: false, changedNames: [], errors: [] };
  if (!location || !people.length) return report;

  if (groupId && groupmakerPresenceChanged(active, aiList, location)) {
    const names = formatGroupmakerNames(people.map((person) => person.name));
    if (names) {
      const message = `*${names} are now physically present together . Their location is ${location}*`;
      const result = await kindroidApiClient.execute('group_user_message', { group_id: groupId, message }, { timeoutMs: 12000 });
      if (result.ok) report.groupSent = true;
      else report.errors.push(`Group presence recap failed: ${result.message || result.status || 'Kindroid request failed'}`);
    }
  }

  for (const person of people) {
    const entry = entries().map(ensureEntry).find((row) => String(row.ai_id || '').trim() === String(person.ai_id || '').trim());
    if (!entry) continue;
    const oldLocation = String(entry.location || '').trim();
    if (oldLocation && sameNormalizedText(oldLocation, location)) continue;
    const message = `*${entry.name || person.name || 'This person'} is currently transiting from ${oldLocation || 'unknown location'} to ${location}*`;
    const result = await kindroidApiClient.execute('send_message', { ai_id: entry.ai_id, message, stream: false }, { timeoutMs: 12000 });
    if (!result.ok) {
      report.errors.push(`Location notice failed for ${entry.name || person.name || entry.ai_id}: ${result.message || result.status || 'Kindroid request failed'}`);
      continue;
    }
    entry.location = location;
    report.changedNames.push(entry.name || person.name || entry.ai_id);
    report.directSent += 1;
  }

  return report;
}

async function syncGroupmaker() {
  const keyInput = document.querySelector('#gm-api-key');
  if (keyInput) state.kindroidApiKey = keyInput.value.trim();
  const active = activeGroupmakerSession();
  if (active && (!state.groupmakerNames.trim() || !state.groupmakerContext.trim())) {
    state.groupmakerNames = Array.isArray(active.names) ? active.names.join(', ') : state.groupmakerNames;
    state.groupmakerContext = String(active.group_context || state.groupmakerContext || '').trim();
    state.groupmakerPosition = String(active.group_name || state.groupmakerPosition || '').trim();
  }
  const context = state.groupmakerContext.trim();
  const people = detectGroupmakerPeople(state.groupmakerNames);
  const detectedAiIds = validAiIds(people.map((person) => person.ai_id));
  const aiList = detectedAiIds.length ? detectedAiIds : validAiIds(active?.ai_list || []);
  const sessionNames = people.length ? people.map((p) => p.name) : (Array.isArray(active?.names) ? active.names : []);
  if (!state.kindroidApiKey.startsWith('kn_')) { state.groupmakerOpen = true; state.groupmakerStatus = 'Enter a valid Kindroid API key first.'; render(); return; }
  if (!context) { state.groupmakerOpen = true; state.groupmakerStatus = 'Group context is required.'; render(); return; }
  if (!aiList.length) { state.groupmakerOpen = true; state.groupmakerStatus = 'No valid AI IDs detected from the names field or active session.'; render(); return; }
  const groupName = composeGroupName(people, state.groupmakerPosition || state.groupmakerLocation);
  const locationByAiId = Object.fromEntries(people.filter((p) => state.groupmakerPosition || p.position).map((p) => [p.ai_id, state.groupmakerPosition || p.position]));
  const payload = { ai_list: aiList, group_name: groupName, group_context: context, group_directive: PHONE_CALL_DIRECTIVE, share_short_term_memory: true, use_manual_turntaking: true, ...(active ? { group_id: active.group_id } : {}) };
  const toolKey = active ? 'group_update' : 'create_groupchat_current_discovery';
  const priorActive = active ? { ...active, ai_list: [...validAiIds(active.ai_list || [])] } : null;
  closePriorGroupmakerTabs();
  const preparedTab = window.open('about:blank', '_blank');
  if (preparedTab) preparedTab.document.title = 'Opening Kindroid group…';
  state.groupmakerBusy = true; state.groupmakerStatus = `${active ? 'Updating' : 'Creating'} GROUPMAKER session…`; render();
  try {
    const result = await kindroidApiClient.execute(toolKey, payload);
    if (!result.ok) throw new Error(result.message || `${toolKey} failed (${result.status || 0})`);
    result.detail = result.rawText || String(result.data || '');
    result.groupIdSource = [result.rawText, result.headers?.location, result.headers?.Location].filter(Boolean).join('\n');
    const now = new Date().toISOString();
    let target = active;
    if (active) {
      const automation = await runGroupmakerPresenceAutomations({ people, groupId: target.group_id, active: priorActive, aiList });
      Object.assign(target, { ai_list: aiList, names: sessionNames, group_name: groupName, group_context: context, group_directive: PHONE_CALL_DIRECTIVE, location_by_ai_id: locationByAiId, physical_location: groupmakerPhysicalLocation(), share_short_term_memory: true, use_manual_turntaking: true, touched_at: now, last_automation: { ...automation, ran_at: now } });
      const opened = openPreparedGroupmakerTab(preparedTab, target.group_id);
      state.groupmakerStatus = `Updated active session (${result.status}). Automation: ${automation.groupSent ? 'group recap sent' : 'no group recap'}; ${automation.directSent} location notice(s) sent${automation.errors.length ? `; ${automation.errors.length} warning(s)` : ''}. ${opened ? 'Opened Kindroid call tab.' : `Open manually: ${kindroidGroupCallUrl(target.group_id)}`}`;
    } else {
      const groupId = extractGroupId(result.groupIdSource || result.detail);
      if (!groupId) throw new Error('Create succeeded, but no group_id could be parsed from the response.');
      const automation = await runGroupmakerPresenceAutomations({ people, groupId, active: null, aiList });
      target = { session_key: groupId, group_id: groupId, ai_list: aiList, names: sessionNames, group_name: groupName, group_context: context, group_directive: PHONE_CALL_DIRECTIVE, location_by_ai_id: locationByAiId, physical_location: groupmakerPhysicalLocation(), share_short_term_memory: true, use_manual_turntaking: true, touched_at: now, closed_at: '', idle_at: '', last_automation: { ...automation, ran_at: now } };
      state.config.groupmaker_sessions = groupmakerSessions().filter((row) => row.group_id !== groupId).concat(target);
      state.config.groupmaker_active_session_key = groupId;
      const opened = openPreparedGroupmakerTab(preparedTab, groupId);
      state.groupmakerStatus = `Created active session ${groupId} (${result.status}). Automation: ${automation.groupSent ? 'group recap sent' : 'no group recap'}; ${automation.directSent} location notice(s) sent${automation.errors.length ? `; ${automation.errors.length} warning(s)` : ''}. ${opened ? 'Opened Kindroid call tab.' : `Open manually: ${kindroidGroupCallUrl(groupId)}`}`;
    }
    persistGroupmakerDraft();
    await saveBridge(`GROUPMAKER ${active ? 'update' : 'create'} session`);
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
  document.querySelector('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  document.querySelector('#filter').addEventListener('change', (e) => { state.filter = e.target.value; render(); });
  document.querySelectorAll('.person').forEach((button) => button.addEventListener('click', () => { state.selectedUid = button.dataset.uid; state.activeEntryTab = 'profile'; render(); }));
  document.querySelector('#add').addEventListener('click', () => { const entry = ensureEntry({ ...DEFAULT_ENTRY, name: 'New Person' }); entries().push(entry); state.selectedUid = entry.directory_uid; saveBridge('Add directory person'); });
  document.querySelector('#remove').addEventListener('click', () => { const entry = selectedEntry(); if (entry && confirm(`Remove ${entry.name || 'this person'}?`)) { state.config.directory_entries = entries().filter((item) => item.directory_uid !== entry.directory_uid); state.selectedUid = ''; saveBridge('Remove directory person'); } });
  document.querySelector('#save').addEventListener('click', () => saveBridge('Update directory'));
  document.querySelector('#settings-toggle').addEventListener('click', () => { state.settingsOpen = !state.settingsOpen; render(); });
  document.querySelector('#import')?.addEventListener('click', () => document.querySelector('#file')?.click());
  document.querySelector('#file')?.addEventListener('change', importLegacyFile);
  document.querySelector('#groupmaker-toggle').addEventListener('click', () => { state.groupmakerOpen = !state.groupmakerOpen; render(); });
  document.querySelector('#api-studio-toggle')?.addEventListener('click', () => { state.apiStudioOpen = !state.apiStudioOpen; render(); });
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
  document.querySelector('#gm-sync')?.addEventListener('click', syncGroupmaker);
  document.querySelector('#gm-close-session')?.addEventListener('click', () => { const active = activeGroupmakerSession(); if (active) { active.closed_at = new Date().toISOString(); state.config.groupmaker_active_session_key = ''; saveBridge('GROUPMAKER close session'); } });
  document.querySelectorAll('.gm-session').forEach((button) => button.addEventListener('click', () => { state.config.groupmaker_active_session_key = button.dataset.session; saveBridge('GROUPMAKER activate session'); }));
  ['names', 'location', 'position', 'context'].forEach((key) => { document.querySelector(`#gm-${key}`)?.addEventListener('input', (e) => { state[`groupmaker${key[0].toUpperCase()}${key.slice(1)}`] = e.target.value; if (key === 'names') refreshGroupmakerDetectedList(); scheduleGroupmakerDraftSave(); }); });
  const current = selectedEntry();
  if (!current) return;
  document.querySelector('#toggle-online').addEventListener('click', () => { current.online = !current.online; saveBridge('Update online status'); });
  document.querySelectorAll('[data-field]').forEach((input) => input.addEventListener('input', (e) => { current[e.target.dataset.field] = e.target.value; }));
  const generation = ensureGenerationPerson(current);
  document.querySelectorAll('[data-generation-field]').forEach((input) => input.addEventListener('input', (e) => {
    generation[e.target.dataset.generationField] = e.target.value;
    if (e.target.dataset.generationField === 'sex') current.gender = e.target.value;
  }));
  const updateRelations = () => {
    generation.parents = cleanGenerationIds([...document.querySelectorAll('#generation-parents input:checked')].map((input) => input.value), generation.id);
    generation.children = cleanGenerationIds([...document.querySelectorAll('#generation-children input:checked')].map((input) => input.value), generation.id);
  };
  document.querySelectorAll('#generation-parents input, #generation-children input').forEach((input) => input.addEventListener('change', updateRelations));
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
  state.syncDetail = 'Remembered access key found; connecting automatically…';
  loadBridge();
  return true;
}

function render() { state.authenticated ? renderDirectory() : renderLogin(); }

const style = document.createElement('style');
style.textContent = `
:root{color-scheme:dark;--bg:#030512;--panel:rgba(9,15,33,.72);--panel-strong:rgba(13,20,43,.9);--line:rgba(255,255,255,.13);--text:#f8fbff;--muted:#9fb0cf;--cyan:#69e5ff;--violet:#8b5cf6;--green:#54f6a6;--pink:#ff6bcb;--warn:#ffb86b;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% 8%,rgba(105,229,255,.24),transparent 30rem),radial-gradient(circle at 82% 8%,rgba(139,92,246,.28),transparent 34rem),radial-gradient(circle at 50% 105%,rgba(84,246,166,.12),transparent 28rem),linear-gradient(135deg,#030512,#081126 58%,#14091f);overflow-x:hidden}body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(circle at center,#000,transparent 78%)}button,input,select,textarea{font:inherit}button{border:0;border-radius:18px;background:linear-gradient(135deg,var(--cyan),var(--violet));color:#03101c;font-weight:900;padding:.95rem 1.1rem;cursor:pointer;box-shadow:0 18px 42px rgba(72,132,255,.24);transition:transform .18s ease,filter .18s ease,box-shadow .18s ease}button:hover{transform:translateY(-2px);filter:saturate(1.12);box-shadow:0 22px 56px rgba(72,132,255,.32)}button:disabled{opacity:.6;cursor:wait;transform:none}.ghost{background:rgba(255,255,255,.075);color:#dce8ff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}.danger{background:linear-gradient(135deg,#ff6b8a,var(--warn))}.eyebrow{margin:0 0 .7rem;color:var(--cyan);font-size:.74rem;font-weight:950;letter-spacing:.2em;text-transform:uppercase}h1{margin:0;font-size:clamp(2.7rem,7vw,6.4rem);line-height:.88;letter-spacing:-.075em}input,select,textarea{width:100%;border:1px solid rgba(148,190,255,.22);border-radius:18px;background:rgba(4,9,22,.78);color:var(--text);padding:.95rem 1rem;outline:none;transition:border-color .2s,box-shadow .2s,background .2s}textarea{min-height:116px;resize:vertical}input:focus,select:focus,textarea:focus{border-color:var(--cyan);box-shadow:0 0 0 4px rgba(105,229,255,.12);background:rgba(7,14,33,.92)}.login-shell{display:grid;min-height:100vh;place-items:center;padding:2rem}.login-card{position:relative;isolation:isolate;width:min(760px,100%);padding:clamp(2rem,6vw,5rem);border:1px solid var(--line);border-radius:46px;background:linear-gradient(145deg,rgba(9,14,30,.86),rgba(15,8,32,.76));box-shadow:0 45px 130px rgba(0,0,0,.56);backdrop-filter:blur(30px);overflow:hidden;animation:rise .7s cubic-bezier(.2,.8,.2,1) both}.orb{position:absolute;inset:-30% auto auto 48%;z-index:-1;width:28rem;height:28rem;border-radius:999px;background:conic-gradient(from 90deg,var(--cyan),var(--violet),var(--green),var(--cyan));filter:blur(28px);opacity:.26;animation:spin 12s linear infinite}.lede,.sync-note{color:#c5d4ee;line-height:1.8}.access-form{display:grid;gap:1rem;margin-top:2rem}.access-form label,.field-grid span{color:#9cc8ff;font-size:.76rem;font-weight:950;letter-spacing:.13em;text-transform:uppercase}.remember{display:flex;gap:.65rem;align-items:center;letter-spacing:0!important;text-transform:none!important}.remember input{width:auto}.app-shell{display:grid;grid-template-columns:minmax(520px,38vw) minmax(0,1fr);gap:1.25rem;min-height:100vh;padding:1.25rem}.sidebar,.editor{border:1px solid var(--line);border-radius:34px;background:linear-gradient(180deg,rgba(12,19,42,.78),rgba(7,12,27,.68));box-shadow:0 26px 90px rgba(0,0,0,.36);backdrop-filter:blur(24px)}.sidebar{position:sticky;top:1.25rem;height:calc(100vh - 2.5rem);display:flex;flex-direction:column;gap:.75rem;padding:1rem;animation:slideIn .55s ease both}.brand-block{display:flex;gap:.85rem;align-items:center}.brand-mark{display:grid;place-items:center;width:3.25rem;height:3.25rem;border-radius:18px;background:linear-gradient(135deg,var(--cyan),var(--pink));color:#051022;font-weight:1000;box-shadow:0 14px 32px rgba(105,229,255,.22)}.sidebar h2{margin:0;font-size:2rem;letter-spacing:-.055em}.sync-pill{display:grid;grid-template-columns:auto 1fr;gap:.18rem .65rem;padding:.85rem;border:1px solid rgba(84,246,166,.2);border-radius:20px;background:linear-gradient(135deg,rgba(84,246,166,.09),rgba(105,229,255,.05))}.sync-pill span{grid-row:1/3;width:.72rem;height:.72rem;margin-top:.25rem;border-radius:999px;background:var(--green);box-shadow:0 0 0 0 rgba(84,246,166,.72);animation:pulse 1.8s infinite}.sync-pill small,.person small,.hero-meta,.gm-detected small,.gm-status,.gm-sessions small{color:var(--muted)}.quick-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:.55rem}.quick-stats div{padding:.72rem .5rem;border:1px solid rgba(255,255,255,.1);border-radius:18px;background:rgba(255,255,255,.055);text-align:center}.quick-stats b{display:block;font-size:1.25rem}.quick-stats span{font-size:.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:.12em}.search-card{display:grid;grid-template-columns:1fr;gap:.55rem;padding:.65rem;border:1px solid rgba(255,255,255,.09);border-radius:22px;background:rgba(255,255,255,.04)}.search-card label{grid-column:1/-1;color:#9cc8ff;font-size:.72rem;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.search-card select{min-width:0}.people-list{display:grid;gap:.55rem;overflow:auto;flex:1;min-height:360px;padding:.15rem .35rem .15rem 0;scrollbar-width:thin}.person{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:.85rem;background:rgba(255,255,255,.055);color:#eaf2ff;box-shadow:none;text-align:left;border:1px solid transparent;min-width:0;padding:.9rem 1rem}.person.selected{border-color:rgba(105,229,255,.8);background:linear-gradient(135deg,rgba(105,229,255,.16),rgba(139,92,246,.1));box-shadow:0 16px 34px rgba(105,229,255,.11)}.avatar{position:relative;display:grid;place-items:center;width:2.55rem;height:2.55rem;border-radius:16px;background:rgba(255,255,255,.1);color:#d8e8ff;font-size:.86rem}.avatar.online{background:rgba(84,246,166,.18);color:#a6ffd0}.avatar:after{content:"";position:absolute;right:-.12rem;bottom:-.12rem;width:.72rem;height:.72rem;border:2px solid #111a33;border-radius:999px;background:#ff6b8a}.avatar.online:after{background:var(--green)}.person-copy{min-width:0}.person-copy strong,.person-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:normal;overflow-wrap:anywhere}.person-copy strong{font-size:1.08rem;line-height:1.28}.person-copy small{margin-top:.2rem;line-height:1.35}.action-stack{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem;margin-top:.4rem}.action-stack .gm-reconnect{grid-column:1/-1}.editor{position:relative;padding:clamp(1.25rem,3vw,2.35rem);overflow:hidden;animation:rise .65s ease both}.editor:before{content:"";position:absolute;inset:0 0 auto;height:13rem;background:linear-gradient(135deg,rgba(105,229,255,.12),rgba(255,107,203,.08));pointer-events:none}.hero-line{position:relative;display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1.15rem}.hero-line h1{font-size:clamp(2.4rem,6vw,5.3rem)}.hero-meta{display:flex;flex-wrap:wrap;gap:.55rem;margin-top:.9rem}.hero-meta span{padding:.42rem .65rem;border:1px solid rgba(255,255,255,.1);border-radius:999px;background:rgba(255,255,255,.06);font-size:.78rem}.status-grid{position:relative;display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:1rem;margin-bottom:1rem}.status,.asset-card{min-height:108px;border:1px solid rgba(255,255,255,.12);border-radius:24px;background:rgba(255,80,103,.12);color:#ffc0ca;display:grid;align-content:center;gap:.25rem;padding:1rem;font-size:1.55rem;font-weight:950;box-shadow:none;text-align:left}.status.on{background:rgba(84,246,166,.12);color:#9dffc9}.status small,.asset-card span{font-size:.72rem;letter-spacing:.15em;text-transform:uppercase;color:var(--muted)}.asset-card{background:rgba(105,229,255,.08);color:#b5ecff}.asset-card.accent{background:rgba(139,92,246,.1);color:#dbcfff}.progress{height:.52rem;border-radius:999px;background:rgba(255,255,255,.09);overflow:hidden}.progress i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--green),var(--cyan));animation:grow .75s ease both}.field-grid{position:relative;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.field-grid label,.fetch-card,.generations-card,.memory-card{display:grid;gap:.5rem;padding:1rem;border:1px solid rgba(255,255,255,.1);border-radius:24px;background:rgba(255,255,255,.048);transition:transform .18s,border-color .18s,background .18s}.field-grid label:focus-within,.fetch-card:focus-within{transform:translateY(-2px);border-color:rgba(105,229,255,.45);background:rgba(105,229,255,.055)}.field-grid .wide{grid-column:1/-1}.fetch-card,.generations-card,.memory-card{position:relative;margin-top:1rem}.fetch-card h3,.generations-card h3,.memory-card h3{margin:.1rem 0;color:#f3b3ff;font-size:1.35rem}.generation-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:.7rem}.generation-summary div{padding:.85rem;border:1px solid rgba(255,255,255,.1);border-radius:18px;background:rgba(105,229,255,.06)}.generation-summary b{display:block;font-size:1.25rem}.generation-summary span,.relations-grid small,.tree-node small{display:block;color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.1em}.relations-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.relations-grid h4{margin:.25rem 0;color:#bdefff}.relations-grid ul{margin:.25rem 0 .75rem;padding-left:1.1rem}.relations-grid li{margin:.25rem 0}.muted{color:var(--muted)}.relation-picker{display:grid;gap:.35rem;max-height:220px;overflow:auto}.relation-choice{display:grid!important;grid-template-columns:auto 1fr;gap:.1rem .55rem;padding:.7rem!important;border-radius:16px!important}.relation-choice input{grid-row:1/3;width:auto}.tree-board{display:grid;gap:.8rem;padding:1rem;border:1px solid rgba(105,229,255,.18);border-radius:22px;background:rgba(4,9,22,.5);overflow:auto}.tree-row{display:flex;justify-content:center;gap:.75rem;min-width:max-content}.tree-node{min-width:150px;padding:.75rem;border:1px solid rgba(148,190,255,.24);border-radius:18px;background:rgba(255,255,255,.06);text-align:center}.tree-node.focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(84,246,166,.12)}.tree-edges{display:flex;flex-wrap:wrap;gap:.4rem;justify-content:center}.tree-edges span{padding:.35rem .55rem;border-radius:999px;background:rgba(76,118,189,.22);color:#cfe1ff;font-size:.75rem}.invalid{border-color:#ff6b8a!important}.gm-reconnect{display:grid;grid-template-columns:auto 1fr;gap:.05rem .55rem;align-items:center;width:100%;padding:.85rem 1rem;text-align:left;border:1px solid rgba(84,246,166,.42);background:linear-gradient(135deg,rgba(84,246,166,.96),rgba(105,229,255,.94));box-shadow:0 14px 34px rgba(84,246,166,.18)}.gm-reconnect span{grid-row:1/3;font-size:1.5rem}.gm-reconnect small{font-size:.7rem;color:#123042}.gm-reconnect.needs-setup{border-color:rgba(255,184,107,.55);background:linear-gradient(135deg,var(--warn),#ff6b8a)}.groupmaker-float{position:fixed;right:1.25rem;bottom:1.25rem;z-index:20;width:clamp(430px,34vw,680px);max-width:calc(100vw - 2.5rem);max-height:calc(100vh - 2.5rem);overflow:auto;padding:1rem;border:1px solid rgba(105,229,255,.28);border-radius:30px;background:rgba(5,10,24,.94);box-shadow:0 30px 100px rgba(0,0,0,.62);backdrop-filter:blur(26px);animation:floatUp .32s ease both}.groupmaker-float.mini{width:300px}.gm-head,.gm-row{display:flex;align-items:center;justify-content:space-between;gap:.7rem}.gm-head h3{margin:.1rem 0 0;font-size:1.35rem}.groupmaker-float label{display:grid;gap:.35rem;margin-top:.75rem}.groupmaker-float #gm-names{min-height:170px}.groupmaker-float #gm-context{min-height:150px}.groupmaker-float .gm-check{display:flex;align-items:center;gap:.55rem}.gm-check input{width:auto}.groupmaker-float label span{color:#9cc8ff;font-size:.72rem;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.gm-detected{display:grid;grid-template-columns:1fr auto;gap:.25rem .6rem;margin:.65rem 0;padding:.75rem;border:1px solid rgba(255,255,255,.1);border-radius:18px;background:rgba(255,255,255,.045)}.gm-status{line-height:1.45}.gm-sessions{display:grid;gap:.45rem;margin-top:.75rem}.gm-session{display:grid;gap:.15rem;text-align:left;background:rgba(255,255,255,.06);color:#eaf2ff;box-shadow:none}.gm-session.selected{outline:2px solid rgba(84,246,166,.7)}.empty{padding:4rem;text-align:center;color:var(--muted);border:1px dashed rgba(255,255,255,.18);border-radius:26px}.empty.small{padding:1rem}@keyframes pulse{70%{box-shadow:0 0 0 14px rgba(84,246,166,0)}100%{box-shadow:0 0 0 0 rgba(84,246,166,0)}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes rise{from{opacity:0;transform:translateY(20px) scale(.985)}to{opacity:1;transform:none}}@keyframes slideIn{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}@keyframes floatUp{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}@keyframes grow{from{width:0}}@media(max-width:1180px){.status-grid{grid-template-columns:1fr 1fr}.status-grid .accent{grid-column:1/-1}}@media(max-width:1180px){.app-shell{grid-template-columns:1fr}.sidebar{position:relative;top:0;height:auto;min-height:0}.people-list{min-height:260px}}@media(max-width:980px){.app-shell{grid-template-columns:1fr}.sidebar{position:relative;top:0;height:auto}.field-grid,.status-grid{grid-template-columns:1fr}.search-card{grid-template-columns:1fr}.quick-stats{grid-template-columns:repeat(2,1fr)}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
/* Modern DIRECTORY-focused shell overrides */
.app-shell{grid-template-columns:minmax(360px,31vw) minmax(0,1fr);gap:1rem;padding:1rem}.sidebar{gap:.65rem;padding:.85rem;border-radius:28px}.sync-pill{padding:.7rem .8rem}.search-card{grid-template-columns:minmax(0,1fr) 8rem;padding:.55rem}.search-card input,.search-card select{border-radius:16px;padding:.82rem .9rem}.people-list{min-height:0;padding-right:.2rem}.person{border-radius:20px;padding:.72rem .78rem;transition:transform .2s ease,border-color .2s ease,background .2s ease,box-shadow .2s ease}.person:hover{transform:translateX(4px)}.action-stack.icon-actions{grid-template-columns:repeat(4,1fr);gap:.4rem}.icon-actions button{min-height:2.7rem;padding:.55rem;border-radius:16px;font-size:1.05rem}.icon-actions .gm-reconnect{grid-column:1/-1}.editor{border-radius:30px}.hero-line{align-items:center}.hero-line h1{font-size:clamp(2.1rem,5vw,4.6rem)}.entry-tabs{position:relative;display:inline-flex;gap:.35rem;margin:0 0 1rem;padding:.35rem;border:1px solid rgba(255,255,255,.11);border-radius:999px;background:rgba(255,255,255,.055);box-shadow:inset 0 0 0 1px rgba(255,255,255,.035)}.entry-tabs .tab{padding:.65rem 1rem;border-radius:999px;background:transparent;color:var(--muted);box-shadow:none;letter-spacing:.14em;font-size:.78rem}.entry-tabs .tab.active{background:linear-gradient(135deg,rgba(105,229,255,.95),rgba(139,92,246,.95));color:#041020;box-shadow:0 12px 30px rgba(105,229,255,.22)}.tab-stage{position:relative}.tab-panel{display:none;animation:tabIn .34s cubic-bezier(.2,.8,.2,1) both}.tab-panel.active{display:block}.profile-panel{position:relative}.field-grid label,.generations-card{box-shadow:0 18px 50px rgba(0,0,0,.14)}.generations-card{margin-top:0}.groupmaker-float{transition:width .2s ease,transform .2s ease,opacity .2s ease}.gm-head button{padding:.55rem .75rem;border-radius:14px}@keyframes tabIn{from{opacity:0;transform:translateY(10px) scale(.992);filter:blur(4px)}to{opacity:1;transform:none;filter:none}}@media(max-width:1180px){.app-shell{grid-template-columns:1fr}.action-stack.icon-actions{grid-template-columns:repeat(4,minmax(2.5rem,1fr))}}@media(max-width:620px){.action-stack.icon-actions{grid-template-columns:repeat(4,1fr)}.search-card{grid-template-columns:1fr}.relations-grid{grid-template-columns:1fr}}

/* Settings, family cards, and fixed viewport refinements */
html,body,#lifeline-root{height:100%;overflow:hidden}.app-shell{height:100%;min-height:0}.sidebar,.editor{max-height:calc(100vh - 2rem)}.editor{overflow:auto}.settings-panel{display:grid;gap:.8rem;margin-top:.75rem;padding:1rem;border:1px solid rgba(105,229,255,.18);border-radius:24px;background:linear-gradient(135deg,rgba(105,229,255,.08),rgba(139,92,246,.08));box-shadow:0 18px 45px rgba(0,0,0,.16)}.settings-panel h3{margin:.1rem 0;color:#f3b3ff}.status-field{display:grid;align-content:center;gap:.45rem;min-height:108px;padding:1rem;border:1px solid rgba(255,255,255,.12);border-radius:24px;background:rgba(255,255,255,.048)}.status-field span{color:#9cc8ff;font-size:.72rem;font-weight:950;letter-spacing:.15em;text-transform:uppercase}.status-grid{grid-template-columns:1.05fr 1fr 1fr}.generation-summary{grid-template-columns:repeat(2,1fr)}.relations-grid{align-items:start}.relation-card{display:grid;gap:.85rem;padding:1rem;border:1px solid rgba(148,190,255,.16);border-radius:26px;background:linear-gradient(145deg,rgba(255,255,255,.07),rgba(105,229,255,.035));box-shadow:0 18px 42px rgba(0,0,0,.18)}.relation-card-head{display:flex;gap:.75rem;align-items:center}.relation-card-head>span{display:grid;place-items:center;width:2.5rem;height:2.5rem;border-radius:16px;background:linear-gradient(135deg,var(--cyan),var(--violet));color:#041020;font-weight:1000}.relation-card h4{margin:0;color:#e9f7ff}.relation-card p{margin:.2rem 0 0;color:var(--muted);font-size:.86rem}.relation-pills{display:flex;flex-wrap:wrap;gap:.45rem;margin:0!important;padding:0!important;list-style:none}.relation-pills li{margin:0!important;padding:.45rem .65rem;border-radius:999px;background:rgba(105,229,255,.1);border:1px solid rgba(105,229,255,.18);color:#dff7ff}.relation-choice{align-items:center;background:rgba(3,8,20,.62)!important;border:1px solid rgba(255,255,255,.08)!important;transition:transform .16s ease,border-color .16s ease,background .16s ease}.relation-choice:hover{transform:translateX(3px);border-color:rgba(105,229,255,.38)!important;background:rgba(105,229,255,.08)!important}.relation-choice input{accent-color:#69e5ff}.relation-choice span{letter-spacing:0;text-transform:none;color:#f8fbff;font-size:.95rem}@media(max-width:980px){html,body,#lifeline-root{height:auto;overflow:auto}.sidebar,.editor{max-height:none}.editor{overflow:hidden}}

.api-studio{grid-column:1/-1;margin:1rem 0;padding:1rem;border:1px solid rgba(105,229,255,.28);border-radius:30px;background:rgba(5,10,24,.94);box-shadow:0 26px 80px rgba(0,0,0,.44)}.api-head,.api-controls{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}.api-head h2{margin:.1rem 0;font-size:2rem}.api-controls{margin:1rem 0}.api-controls label{min-width:240px;display:grid;gap:.35rem}.api-grid{display:grid;grid-template-columns:180px minmax(240px,330px) minmax(0,1fr);gap:1rem}.api-nav,.api-catalog{display:grid;align-content:start;gap:.45rem;max-height:68vh;overflow:auto}.api-cat,.api-op{background:rgba(255,255,255,.06);color:#eaf2ff;box-shadow:none;text-align:left}.api-cat.selected,.api-op.selected{outline:2px solid rgba(105,229,255,.75);background:rgba(105,229,255,.13)}.api-op{display:grid;gap:.25rem}.api-op span,.api-op small{color:var(--muted);font-size:.76rem}.api-op em,.badge{display:inline-block;width:max-content;padding:.24rem .45rem;border-radius:999px;background:rgba(84,246,166,.16);color:#a6ffd0;font-size:.65rem;font-style:normal;letter-spacing:.08em}.api-detail{min-width:0}.api-form h3,.api-preview h3,.api-response h3,.transcript-panel h3{margin:.2rem 0;color:#bdefff}.api-preview,.api-response,.transcript-panel,.api-matrix{margin-top:1rem;padding:1rem;border:1px solid rgba(255,255,255,.1);border-radius:24px;background:rgba(255,255,255,.045)}pre{max-width:100%;overflow:auto;white-space:pre-wrap;word-break:break-word;padding:1rem;border-radius:18px;background:rgba(0,0,0,.28);color:#dbeafe}.risk{padding:.7rem;border-radius:16px;background:rgba(255,184,107,.12);border:1px solid rgba(255,184,107,.28);color:#ffd5a8}.stream-box{display:grid;gap:.5rem;margin-bottom:1rem}.api-matrix summary{cursor:pointer;color:#69e5ff;font-weight:900}.api-form small{color:var(--muted);line-height:1.45}@media(max-width:1180px){.api-grid{grid-template-columns:1fr}.api-nav{grid-template-columns:repeat(2,minmax(0,1fr));max-height:none}.api-catalog{max-height:360px}}

`;
document.head.append(style);

if (!startRememberedLogin()) render();
