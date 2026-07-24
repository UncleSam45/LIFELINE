const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');

const APP_ROOT = __dirname;
const transcriptWindows = new Map();
const KINDROID_PANEL_URL = 'https://kindroid.ai/v2/kins/';
let mainWindow = null;
let kindroidPanel = null;
const BRIDGE_OWNER = 'unclesam45';
const BRIDGE_REPO = 'LIFELINE_BRIDGE';
const BRIDGE_BRANCH = 'main';

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    title: 'LIFELINE',
    webPreferences: {
      preload: path.join(APP_ROOT, 'electron_preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => { mainWindow = null; });
  win.loadFile(path.join(APP_ROOT, 'index.html'));
  return win;
}

function openKindroidPanel() {
  if (kindroidPanel && !kindroidPanel.isDestroyed()) {
    if (kindroidPanel.isMinimized()) kindroidPanel.restore();
    kindroidPanel.show();
    kindroidPanel.focus();
    return { ok: true, reused: true, url: kindroidPanel.webContents.getURL() || KINDROID_PANEL_URL };
  }
  kindroidPanel = new BrowserWindow({
    width: 520, height: 780, minWidth: 380, minHeight: 520,
    title: 'Kindroid · LIFELINE panel', parent: mainWindow || undefined,
    show: false, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  kindroidPanel.setMenuBarVisibility(false);
  kindroidPanel.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://kindroid.ai/')) kindroidPanel.loadURL(url);
    return { action: 'deny' };
  });
  kindroidPanel.once('ready-to-show', () => kindroidPanel?.show());
  kindroidPanel.on('closed', () => { kindroidPanel = null; });
  kindroidPanel.loadURL(KINDROID_PANEL_URL);
  return { ok: true, reused: false, url: KINDROID_PANEL_URL };
}

function cleanGroupId(value) {
  return String(value || '').trim();
}

function groupChatUrl(groupId) {
  return `https://kindroid.ai/v2/chat/group/${encodeURIComponent(groupId)}/`;
}

function failure(stage, message, extra = {}) {
  return { ok: false, stage, message: String(message || 'Unknown error'), ...extra };
}

function headers(token) {
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
}

function contentUrl(repoPath, includeRef = true) {
  const encoded = encodeURIComponent(repoPath).replaceAll('%2F', '/');
  return `https://api.github.com/repos/${BRIDGE_OWNER}/${BRIDGE_REPO}/contents/${encoded}${includeRef ? `?ref=${BRIDGE_BRANCH}` : ''}`;
}

async function githubJson(url, options, stage) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = { raw: text }; }
  if (!res.ok) {
    const error = new Error(data.message || `GitHub request failed (${res.status})`);
    error.status = res.status;
    error.stage = stage;
    throw error;
  }
  return data;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stableEntryId(groupId, bubble, occurrence) {
  const id = normalizeText(bubble.messageId);
  if (id) return `dom:${id}`;
  const seed = [groupId, normalizeText(bubble.text), occurrence, normalizeText(bubble.previousText), normalizeText(bubble.nextText)].join('\n');
  return `sha256:${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

function withEntryIds(groupId, bubbles, capturedAt, sourceUrl) {
  const counts = new Map();
  return bubbles.map((bubble) => {
    const text = normalizeText(bubble.text);
    const seen = (counts.get(text) || 0) + 1;
    counts.set(text, seen);
    return {
      entry_id: stableEntryId(groupId, bubble, seen),
      text,
      first_captured_at: capturedAt,
      source_url: sourceUrl,
      dom_message_id: normalizeText(bubble.messageId),
      timestamp: normalizeText(bubble.timestamp),
      speaker: normalizeText(bubble.speaker),
    };
  });
}

function mergeTranscript(existing, { groupId, groupName, participants, capturedAt, sourceUrl, bubbles }) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const doc = {
    version: 1,
    group_id: groupId,
    group_name: groupName || base.group_name || '',
    created_at: base.created_at || capturedAt,
    updated_at: capturedAt,
    entries: Array.isArray(base.entries) ? base.entries : [],
    captures: Array.isArray(base.captures) ? base.captures : [],
  };
  const existingIds = new Set(doc.entries.map((entry) => String(entry.entry_id || '')));
  const entries = withEntryIds(groupId, bubbles, capturedAt, sourceUrl);
  const newEntryIds = [];
  for (const entry of entries) {
    if (!entry.text || existingIds.has(entry.entry_id)) continue;
    doc.entries.push(entry);
    existingIds.add(entry.entry_id);
    newEntryIds.push(entry.entry_id);
  }
  doc.captures.push({
    capture_id: crypto.randomUUID(),
    captured_at: capturedAt,
    participants_present: participants,
    entries_found: bubbles.length,
    new_entry_ids: newEntryIds,
  });
  return { doc, newEntryIds };
}

async function readTranscriptFile(token, repoPath) {
  const res = await fetch(contentUrl(repoPath), { headers: headers(token) });
  if (res.status === 404) return { sha: '', doc: null };
  const text = await res.text();
  const file = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(file.message || `GitHub read failed (${res.status})`), { status: res.status });
  const content = Buffer.from(String(file.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  try { return { sha: file.sha || '', doc: content.trim() ? JSON.parse(content) : null }; }
  catch (error) { throw Object.assign(new Error(`Could not parse existing transcript JSON: ${error.message}`), { parse: true }); }
}

async function writeTranscriptFile(token, repoPath, doc, sha) {
  return githubJson(contentUrl(repoPath, false), {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ message: `Update group transcript ${doc.group_id}`, branch: BRIDGE_BRANCH, content: Buffer.from(JSON.stringify(doc, null, 2), 'utf8').toString('base64'), ...(sha ? { sha } : {}) }),
  }, 'github_write');
}

async function saveMergedTranscript(token, repoPath, mergeInput) {
  let current;
  try { current = await readTranscriptFile(token, repoPath); } catch (error) { throw Object.assign(error, { stage: error.parse ? 'github_parse' : 'github_read' }); }
  let merged = mergeTranscript(current.doc, mergeInput);
  try {
    await writeTranscriptFile(token, repoPath, merged.doc, current.sha);
    return merged;
  } catch (error) {
    if (error.status !== 409) throw Object.assign(error, { stage: 'github_write' });
    current = await readTranscriptFile(token, repoPath);
    merged = mergeTranscript(current.doc, mergeInput);
    await writeTranscriptFile(token, repoPath, merged.doc, current.sha);
    return merged;
  }
}

function extractionScript() {
  return `(() => new Promise(async (resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
    const selectors = [
      'p.chat-bubble-v2_bubble-text__QUcZ9.v2-message-selectable',
      'p.chat-bubble-v2_bubble-text__QUcZ9',
      'p[class*="chat-bubble-v2_bubble-text"].v2-message-selectable',
      'p[class*="chat-bubble-v2_bubble-text"]',
      'p.v2-message-selectable',
    ];
    const visible = (node) => {
      const rect = node.getBoundingClientRect?.();
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      return (!rect || rect.width || rect.height) && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rootsForDocument = (doc) => {
      const roots = [doc];
      const walk = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
      let node = walk.currentNode;
      while (node) {
        if (node.shadowRoot) roots.push(node.shadowRoot);
        node = walk.nextNode();
      }
      return roots;
    };
    const documents = () => {
      const docs = [document];
      for (const frame of [...document.querySelectorAll('iframe')]) {
        try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (_error) {}
      }
      return docs;
    };
    const queryAllDeep = (selector) => {
      const out = [];
      for (const doc of documents()) {
        for (const root of rootsForDocument(doc)) out.push(...root.querySelectorAll(selector));
      }
      return [...new Set(out)];
    };
    const findBubbles = () => {
      for (const selector of selectors) {
        const nodes = queryAllDeep(selector).filter((node) => clean(node.innerText || node.textContent) && visible(node));
        if (nodes.length) return { selector, nodes };
      }
      return { selector: '', nodes: [] };
    };
    const scrollParent = (node) => {
      let cur = node && node.parentElement;
      while (cur && cur !== node.ownerDocument.body) {
        const style = node.ownerDocument.defaultView.getComputedStyle(cur);
        if (/(auto|scroll)/.test(style.overflowY) && cur.scrollHeight > cur.clientHeight + 20) return cur;
        cur = cur.parentElement;
      }
      return node?.ownerDocument?.scrollingElement || document.scrollingElement || document.documentElement;
    };
    let found = findBubbles();
    let container = scrollParent(found.nodes[0]);
    let stable = 0, attempts = 0, lastCount = -1, lastHeight = -1;
    while (attempts < 40 && stable < 3) {
      found = findBubbles();
      container = scrollParent(found.nodes[0]) || container;
      const height = container ? container.scrollHeight : document.documentElement.scrollHeight;
      if (found.nodes.length === lastCount && height === lastHeight) stable += 1; else stable = 0;
      lastCount = found.nodes.length; lastHeight = height; attempts += 1;
      if (container) container.scrollTop = 0; else window.scrollTo(0, 0);
      await sleep(850);
    }
    found = findBubbles();
    const nodes = found.nodes;
    const rows = nodes.map((node, domIndex) => {
      const wrapper = node.closest('[data-message-id], [data-id], [data-testid], [id], [data-index]') || node.parentElement;
      const pick = (el, attrs) => attrs.map((a) => el?.getAttribute?.(a)).find((v) => clean(v));
      const timeEl = wrapper?.querySelector?.('time,[datetime],[data-time],[data-timestamp]') || node.closest('time,[datetime]');
      const speakerEl = wrapper?.querySelector?.('[data-speaker],[data-display-name],[class*="speaker" i],[class*="display-name" i],[class*="name" i]');
      return { text: clean(node.innerText || node.textContent), domIndex, messageId: clean(pick(node, ['data-message-id','data-id','data-testid','id','data-index']) || pick(wrapper, ['data-message-id','data-id','data-testid','id','data-index'])), timestamp: clean(timeEl?.getAttribute?.('datetime') || timeEl?.getAttribute?.('data-time') || timeEl?.getAttribute?.('data-timestamp') || timeEl?.textContent), speaker: clean(speakerEl?.getAttribute?.('data-speaker') || speakerEl?.getAttribute?.('data-display-name') || speakerEl?.textContent) };
    });
    rows.forEach((row, i) => { row.previousText = rows[i - 1]?.text || ''; row.nextText = rows[i + 1]?.text || ''; });
    resolve({ selectorUsed: found.selector, scrollAttempts: attempts, bubblesFound: rows.length, oldestTextPreview: rows[0]?.text?.slice(0, 120) || '', newestTextPreview: rows[rows.length - 1]?.text?.slice(0, 120) || '', bubbles: rows });
  }))();`;
}

function getTranscriptWindow(groupId) {
  const existing = transcriptWindows.get(groupId);
  if (existing && !existing.isDestroyed()) return existing;
  const win = new BrowserWindow({ width: 1280, height: 900, title: `Kindroid transcript ${groupId}`, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  win.on('closed', () => transcriptWindows.delete(groupId));
  transcriptWindows.set(groupId, win);
  return win;
}

function isExpectedGroupPage(url, groupId) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'kindroid.ai' && parsed.pathname.replace(/\/$/, '') === `/v2/chat/group/${groupId}`;
  } catch (_error) {
    return false;
  }
}

function isKindroidAuthenticationPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'kindroid.ai' && /\/(login|signin|auth)(?:\/|$)/i.test(parsed.pathname);
  } catch (_error) {
    return false;
  }
}

async function navigateTranscriptWindow(win, sourceUrl, groupId) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (win.webContents.isLoading()) win.webContents.stop();
    const result = await new Promise((resolve) => {
      let failureTimer;
      const timeout = setTimeout(() => finish({ error: new Error(`Timed out loading ${sourceUrl}`) }), 30000);
      const finish = (value) => {
        clearTimeout(timeout);
        clearTimeout(failureTimer);
        win.webContents.removeListener('did-finish-load', onFinish);
        win.webContents.removeListener('did-fail-load', onFail);
        resolve(value);
      };
      const onFinish = () => finish({ ok: true });
      const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        const error = Object.assign(new Error(`${errorDescription} (${errorCode}) loading '${validatedURL || sourceUrl}'`), { code: errorCode });
        // Give Kindroid's client-side router a short opportunity to commit a
        // replacement navigation before treating the initial failure as final.
        clearTimeout(failureTimer);
        failureTimer = setTimeout(() => finish({ error }), 2000);
      };
      win.webContents.once('did-finish-load', onFinish);
      win.webContents.on('did-fail-load', onFail);
      win.loadURL(sourceUrl).catch(() => {});
    });
    if (result.ok) {
      const currentUrl = win.webContents.getURL();
      if (isKindroidAuthenticationPage(currentUrl)) {
        throw Object.assign(new Error(`Kindroid authentication is required (redirected to ${currentUrl}).`), { stage: 'authentication' });
      }
      if (isExpectedGroupPage(currentUrl, groupId)) return;
      lastError = new Error(`Kindroid loaded an unexpected page: ${currentUrl || '(blank page)'}`);
    } else {
      lastError = result.error;
    }
  }
  throw Object.assign(lastError || new Error(`Could not load ${sourceUrl}`), { stage: 'navigation' });
}

async function waitForBubbles(win) {
  for (let i = 0; i < 30; i += 1) {
    const count = await win.webContents.executeJavaScript(`document.querySelectorAll('p.chat-bubble-v2_bubble-text__QUcZ9.v2-message-selectable, p.chat-bubble-v2_bubble-text__QUcZ9, p[class*="chat-bubble-v2_bubble-text"].v2-message-selectable, p[class*="chat-bubble-v2_bubble-text"], p.v2-message-selectable').length`, true);
    if (count > 0) return count;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return 0;
}

ipcMain.handle('lifeline:open-kindroid-call', async (_event, payload = {}) => {
  const win = new BrowserWindow({ width: 1280, height: 900, title: 'Kindroid call', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(String(payload.url || 'https://kindroid.ai/'));
  return true;
});

ipcMain.handle('lifeline:open-kindroid-panel', () => openKindroidPanel());

ipcMain.handle('lifeline:fetch-group-transcript', async (_event, payload = {}) => {
  const groupId = cleanGroupId(payload.groupId);
  const sourceUrl = groupId ? groupChatUrl(groupId) : '';
  if (!/^[A-Za-z0-9_-]{6,}$/.test(groupId)) return failure('validation', 'A valid Kindroid groupId is required.', { groupId, sourceUrl });
  const token = String(payload.accessKey || '').trim();
  if (!token) return failure('validation', 'GitHub access key is required to save the transcript.', { groupId, sourceUrl });
  const groupName = normalizeText(payload.groupName);
  const participants = Array.isArray(payload.participants) ? payload.participants.map(normalizeText).filter(Boolean) : [];
  const capturedAt = normalizeText(payload.capturedAt) || new Date().toISOString();
  const repoPath = `transcripts/${groupId}/transcript.json`;
  try {
    const win = getTranscriptWindow(groupId);
    await navigateTranscriptWindow(win, sourceUrl, groupId);
    if (isKindroidAuthenticationPage(win.webContents.getURL())) {
      return failure('authentication', 'Kindroid authentication is required before a transcript can be captured.', { groupId, sourceUrl });
    }
    await waitForBubbles(win);
    const extracted = await win.webContents.executeJavaScript(extractionScript(), true);
    if (!extracted || !Array.isArray(extracted.bubbles)) return failure('dom_extraction', 'Transcript extraction returned an invalid payload.', { groupId, sourceUrl });
    if (!extracted.bubbles.length) return failure('dom_wait', 'No transcript bubbles were found. Confirm Kindroid is signed in and the group-chat page contains messages.', { groupId, sourceUrl });
    const merged = await saveMergedTranscript(token, repoPath, { groupId, groupName, participants, capturedAt, sourceUrl, bubbles: extracted.bubbles });
    return { ok: true, groupId, groupName, participants, sourceUrl, repoPath, selectorUsed: extracted.selectorUsed, scrollAttempts: extracted.scrollAttempts, bubblesFound: extracted.bubblesFound, newEntries: merged.newEntryIds.length, totalEntries: merged.doc.entries.length, capturedAt };
  } catch (error) {
    const stage = error.stage || (/ERR_|navigation/i.test(error.message) ? 'navigation' : 'dom_extraction');
    return failure(stage, error.message, { groupId, sourceUrl });
  }
});

app.whenReady().then(createMainWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
