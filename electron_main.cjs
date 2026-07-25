const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');

const APP_ROOT = __dirname;
const transcriptWindows = new Map();
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
  win.on('closed', () => {
    mainWindow = null;
    if (kindroidPanel && !kindroidPanel.isDestroyed()) kindroidPanel.close();
  });
  win.loadFile(path.join(APP_ROOT, 'index.html'));
  return win;
}

function kindroidPanelState() {
  return { available: true, open: Boolean(kindroidPanel && !kindroidPanel.isDestroyed() && kindroidPanel.isVisible()) };
}

function sendKindroidPanelState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lifeline:kindroid-panel-state', kindroidPanelState());
}

function createKindroidPanel() {
  if (kindroidPanel && !kindroidPanel.isDestroyed()) return kindroidPanel;
  const ownerBounds = mainWindow?.getBounds() || { x: 100, y: 100, width: 1500, height: 940 };
  kindroidPanel = new BrowserWindow({
    width: 480, height: Math.min(820, ownerBounds.height),
    x: ownerBounds.x + ownerBounds.width - 500, y: ownerBounds.y + 60,
    minWidth: 380, minHeight: 520,
    title: 'Kindroid · LIFELINE panel', parent: mainWindow || undefined,
    show: false, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'persist:lifeline-kindroid' },
  });
  kindroidPanel.on('show', sendKindroidPanelState);
  kindroidPanel.on('hide', sendKindroidPanelState);
  kindroidPanel.on('closed', () => { kindroidPanel = null; sendKindroidPanelState(); });
  kindroidPanel.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { parent: kindroidPanel, autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'persist:lifeline-kindroid' } },
  }));
  return kindroidPanel;
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

async function selectWholePageText(win) {
  win.show();
  win.focus();
  win.webContents.focus();
  await win.webContents.executeJavaScript('document.activeElement?.blur(); document.body?.focus()', true);
  const modifier = process.platform === 'darwin' ? 'meta' : 'control';
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [modifier] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [modifier] });
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    const selectedText = await win.webContents.executeJavaScript('window.getSelection()?.toString() || ""', true);
    return String(selectedText || '');
  } finally {
    await win.webContents.executeJavaScript('window.getSelection()?.removeAllRanges()', true).catch(() => {});
  }
}

function selectionTextToBubbles(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(normalizeText)
    .filter(Boolean);
  const rows = [];
  for (const line of lines) {
    if (rows.at(-1)?.text === line) continue;
    rows.push({ text: line, domIndex: rows.length, messageId: '', timestamp: '', speaker: '' });
  }
  rows.forEach((row, index) => {
    row.previousText = rows[index - 1]?.text || '';
    row.nextText = rows[index + 1]?.text || '';
  });
  return rows;
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

ipcMain.handle('lifeline:open-kindroid-call', async (_event, payload = {}) => {
  const win = new BrowserWindow({ width: 1280, height: 900, title: 'Kindroid call', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(String(payload.url || 'https://kindroid.ai/'));
  return true;
});

ipcMain.handle('lifeline:toggle-kindroid-panel', async () => {
  const panel = createKindroidPanel();
  if (panel.isVisible()) panel.hide();
  else {
    panel.show();
    panel.focus();
    if (!panel.webContents.getURL()) await panel.loadURL('https://kindroid.ai/v2/kins/');
  }
  sendKindroidPanelState();
  return kindroidPanelState();
});

ipcMain.handle('lifeline:get-kindroid-panel-state', () => kindroidPanelState());

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
    // Let the client-rendered chat settle, then use exactly the text selected
    // by the same Ctrl/Cmd+A operation that works manually. No DOM message
    // selectors participate in transcript extraction.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const selectedPageText = await selectWholePageText(win);
    const bubbles = selectionTextToBubbles(selectedPageText);
    if (!bubbles.length) return failure('selection_extraction', 'Select All did not produce transcript text. Confirm Kindroid is signed in and the group-chat page contains messages.', { groupId, sourceUrl });
    const merged = await saveMergedTranscript(token, repoPath, { groupId, groupName, participants, capturedAt, sourceUrl, bubbles });
    return { ok: true, groupId, groupName, participants, sourceUrl, repoPath, selectorUsed: 'keyboard-select-all', scrollAttempts: 0, bubblesFound: bubbles.length, newEntries: merged.newEntryIds.length, totalEntries: merged.doc.entries.length, capturedAt };
  } catch (error) {
    const stage = error.stage || (/ERR_|navigation/i.test(error.message) ? 'navigation' : 'selection_extraction');
    return failure(stage, error.message, { groupId, sourceUrl });
  }
});

app.whenReady().then(createMainWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
