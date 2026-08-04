const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const { KindroidJournalAdapter } = require('./kindroid_journal_adapter.cjs');
const JournalSyncEngine = require('./journal_sync_engine.js');

const APP_ROOT = __dirname;
const transcriptWindows = new Map();
const transcriptCaptureTimers = new Map();
let mainWindow = null;
let kindroidPanel = null;
let activeJournalSync = null;
let tray = null;
let allowQuit = false;
let trayNoticeShown = false;
const BRIDGE_OWNER = 'unclesam45';
const BRIDGE_REPO = 'LIFELINE_BRIDGE';
const BRIDGE_BRANCH = 'main';
const KINDROID_PARTITION = 'persist:lifeline-kindroid';
const KINDROID_HOME_URL = 'https://kindroid.ai/';
// Keep the small PNG in code so installers and pull requests do not need a
// separate binary image asset. Unlike the former SVG data URL, this decodes to
// a native bitmap reliably on Windows, Linux, and macOS.
const TRAY_ICON_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAiElEQVR42mNgF5T/P5CYYdQBow4YdcCQc4DBp2MD5wCQ5TA88hyAbDk1HUETB5DiOKo7gNQQYiAn7vFZQmo0UdUB2EKJkCMYiDEA3SBSHYDPLAZSNGOzjNiQwmUe0SFAq2ghuy4gJWHSpDIacAdQq3QcdQDFDRJKK6eh7wBKW0mjjdJRBwy4AwCd+c2NtKBJNgAAAABJRU5ErkJggg==';
// The same standalone userscript is injected by Electron and installed directly
// in Tampermonkey, keeping a single source of truth for the call-page UI.
const KINDROID_TOOLKIT_SOURCE = require('fs').readFileSync(path.join(APP_ROOT, 'lifeline-kindroid-call-toolkit.user.js'), 'utf8');
let kindroidSessionReady = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

function kindroidWebPreferences() {
  return { contextIsolation: true, nodeIntegration: false, partition: KINDROID_PARTITION };
}

function prepareKindroidSession() {
  if (!kindroidSessionReady) {
    // The persistent partition owns Kindroid's cookies, local storage, cache,
    // and service worker. Do not clear any of them during startup: doing so can
    // invalidate the SPA boot sequence and authentication stored by Kindroid.
    kindroidSessionReady = Promise.resolve();
  }
  return kindroidSessionReady;
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    title: 'LIFELINE',
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'electron_preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on('close', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    win.hide();
    if (kindroidPanel && !kindroidPanel.isDestroyed()) kindroidPanel.hide();
    showTrayNotice();
  });
  win.on('closed', () => {
    mainWindow = null;
    if (kindroidPanel && !kindroidPanel.isDestroyed()) kindroidPanel.close();
  });
  win.loadFile(path.join(APP_ROOT, 'index.html'));
  return win;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return tray;
  const trayIcon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64'));
  tray = new Tray(trayIcon);
  tray.setToolTip('LIFELINE');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open LIFELINE', click: showMainWindow },
    { label: 'Minimize to Tray', click: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
      if (kindroidPanel && !kindroidPanel.isDestroyed()) kindroidPanel.hide();
    } },
    { type: 'separator' },
    { label: 'Quit', click: quitApplication },
  ]));
  tray.on('click', showMainWindow);
  return tray;
}

function showTrayNotice() {
  if (!tray || trayNoticeShown || process.platform !== 'win32') return;
  trayNoticeShown = true;
  tray.displayBalloon({
    iconType: 'info',
    title: 'LIFELINE is still running',
    content: 'Use the LIFELINE system tray icon to reopen the main window or quit.',
  });
}

function quitApplication() {
  // This is deliberately the only normal path that is allowed to terminate
  // LIFELINE. A close request from a window or renderer must leave the tray
  // process and its background work running.
  allowQuit = true;
  app.quit();
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
    webPreferences: kindroidWebPreferences(),
  });
  kindroidPanel.on('show', sendKindroidPanelState);
  kindroidPanel.on('hide', sendKindroidPanelState);
  kindroidPanel.on('closed', () => { kindroidPanel = null; sendKindroidPanelState(); });
  kindroidPanel.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    if (validatedURL === KINDROID_HOME_URL || kindroidPanel?.isDestroyed()) return;
    kindroidPanel.loadURL(KINDROID_HOME_URL).catch(() => {});
  });
  kindroidPanel.webContents.on('did-finish-load', () => {
    if (/^https:\/\/(?:www\.)?kindroid\.ai\//.test(kindroidPanel.webContents.getURL())) {
      kindroidPanel.webContents.executeJavaScript(KINDROID_TOOLKIT_SOURCE).catch(() => {});
    }
  });
  kindroidPanel.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { parent: kindroidPanel, autoHideMenuBar: true, webPreferences: kindroidWebPreferences() },
  }));
  return kindroidPanel;
}

async function loadKindroidPanel(panel) {
  await prepareKindroidSession();
  const kindroidSession = panel.webContents.session;
  await kindroidSession.clearCache();
  await kindroidSession.clearStorageData({ origin: KINDROID_HOME_URL, storages: ['serviceworkers', 'cachestorage'] });
  await panel.loadURL(KINDROID_HOME_URL, { extraHeaders: 'Cache-Control: no-cache, no-store\nPragma: no-cache' });
}

function cleanGroupId(value) {
  return String(value || '').trim();
}

function groupCallUrl(groupId) {
  return `https://kindroid.ai/v2/call/group/${encodeURIComponent(groupId)}/`;
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

const LOGIN_PAGE_MARKERS = [
  'choose your login method',
  'continue with google',
  'continue with apple',
  'by continuing, you agree to the',
];

const TRANSCRIPT_PAGE_LABELS = new Set([
  'voice call',
  'message from you',
  'kindroid - your personal artificial intelligence companion',
]);

function isLoginPageText(text) {
  const normalized = normalizeText(text).toLowerCase();
  return LOGIN_PAGE_MARKERS.filter((marker) => normalized.includes(marker)).length >= 2;
}

function isTranscriptPageNoise(text) {
  const normalized = normalizeText(text).toLowerCase();
  return TRANSCRIPT_PAGE_LABELS.has(normalized)
    || /^message from\s+[^\n]+$/i.test(normalized)
    || /^(?:\d+\s*[hms]\s*){1,3}$/i.test(normalized);
}

function removeStoredPageNoise(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const loginCaptureTimes = new Set();
  const byCapture = new Map();
  for (const entry of rows) {
    const capturedAt = normalizeText(entry?.first_captured_at);
    if (!byCapture.has(capturedAt)) byCapture.set(capturedAt, []);
    byCapture.get(capturedAt).push(entry);
  }
  for (const [capturedAt, capturedRows] of byCapture) {
    if (isLoginPageText(capturedRows.map((entry) => entry?.text).join('\n'))) loginCaptureTimes.add(capturedAt);
  }
  return rows.filter((entry) => !loginCaptureTimes.has(normalizeText(entry?.first_captured_at)) && !isTranscriptPageNoise(entry?.text));
}

function transcriptTextEntries(existing) {
  if (Array.isArray(existing?.transcript)) return existing.transcript.map(normalizeText).filter(Boolean);
  // One-way migration from the older diagnostic-heavy document shape.
  return removeStoredPageNoise(existing?.entries).map((entry) => normalizeText(entry?.text)).filter(Boolean);
}

function transcriptOverlap(existing, captured) {
  const max = Math.min(existing.length, captured.length);
  for (let size = max; size > 0; size -= 1) {
    const tail = existing.slice(existing.length - size);
    const head = captured.slice(0, size);
    if (tail.every((text, index) => text === head[index])) return size;
  }
  return 0;
}

function mergeTranscript(existing, { groupId, participants, bubbles }) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const priorTranscript = transcriptTextEntries(base);
  const capturedTranscript = bubbles.map((bubble) => normalizeText(bubble.text)).filter((text) => text && !isTranscriptPageNoise(text));
  const overlap = transcriptOverlap(priorTranscript, capturedTranscript);
  const appended = capturedTranscript.slice(overlap);
  const doc = {
    version: 2,
    group_id: groupId,
    participants: Array.isArray(base.participants) && base.participants.length
      ? base.participants.map(normalizeText).filter(Boolean)
      : participants.map(normalizeText).filter(Boolean),
    transcript: priorTranscript.concat(appended),
  };
  const newEntryIds = appended.map((_text, index) => String(priorTranscript.length + index));
  return { doc, newEntryIds, changed: JSON.stringify(base) !== JSON.stringify(doc) };
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
  if (!merged.changed) return merged;
  try {
    await writeTranscriptFile(token, repoPath, merged.doc, current.sha);
    return merged;
  } catch (error) {
    if (error.status !== 409) throw Object.assign(error, { stage: 'github_write' });
    current = await readTranscriptFile(token, repoPath);
    merged = mergeTranscript(current.doc, mergeInput);
    if (!merged.changed) return merged;
    await writeTranscriptFile(token, repoPath, merged.doc, current.sha);
    return merged;
  }
}

async function extractCallTranscript(win) {
  win.show();
  win.focus();
  win.webContents.focus();
  return win.webContents.executeJavaScript(`(${async function extractKindroidCallTranscript() {
    const THREE_DOT_PATH = 'M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3';
    const TRANSCRIPT_ICON_PATH = 'M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293l-4.7 1';
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const textOf = (element) => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const unique = (elements) => [...new Set(elements.filter(Boolean))];
    const click = (element) => {
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      element.click();
    };
    const isThreeDots = (button) => {
      if (button?.tagName?.toLowerCase() !== 'button' || button.getAttribute('type') !== 'button') return false;
      const legacyPath = button.querySelector("svg[viewBox='0 0 16 16'] path")?.getAttribute('d') || '';
      if (button.getAttribute('aria-haspopup') === 'listbox' && (legacyPath === THREE_DOT_PATH || legacyPath.includes('M3 9.5a1.5'))) return true;
      const svg = button.querySelector("svg[viewBox='0 0 24 24']");
      const dots = [...(svg?.querySelectorAll('circle') || [])]
        .map((circle) => `${circle.getAttribute('cx')},${circle.getAttribute('cy')},${circle.getAttribute('r')}`).sort();
      return dots.join('|') === '12,12,1|19,12,1|5,12,1';
    };
    const isTranscriptOption = (option) => {
      const role = option?.getAttribute?.('role');
      const tag = option?.tagName?.toLowerCase();
      if (!option || (role && !['option', 'menuitem'].includes(role))) return false;
      if (!role && tag !== 'button' && !String(option.className || '').includes('call-dock-v2_menu-row')) return false;
      const label = option.querySelector?.('p.chakra-text') || option;
      if (!/^Transcript$/i.test(textOf(label))) return false;
      const iconPath = option.querySelector?.('svg path')?.getAttribute('d');
      return !iconPath || iconPath.trim() === TRANSCRIPT_ICON_PATH;
    };
    const findTranscriptOption = () => {
      const candidates = [...document.querySelectorAll("[role='option'], [role='menuitem'], button")];
      const exact = candidates.find((option) => visible(option) && isTranscriptOption(option));
      if (exact) return exact;
      // Kindroid has changed the Transcript icon without changing the menu
      // label. Retain the narrow exact-label fallback from the legacy bridge.
      const label = [...document.querySelectorAll("[role='option'] p, [role='menuitem'] p, button p, [role='option'], [role='menuitem'], button")]
        .find((element) => visible(element) && /^Transcript$/i.test(textOf(element)));
      return label?.closest?.("[role='option'], [role='menuitem'], button") || null;
    };

    let opened = Boolean(document.querySelector('[class*="call-transcript-panel-v2_row__"], [class*="call-transcript-panel_row__"]'));
    if (!opened) {
      const menuButtons = [...document.querySelectorAll('button[type="button"]')].filter((button) => visible(button) && isThreeDots(button));
      for (const menuButton of menuButtons) {
        click(menuButton);
        let option = null;
        for (let attempt = 0; attempt < 16 && !option; attempt += 1) {
          await sleep(attempt ? 150 : 350);
          option = findTranscriptOption();
        }
        if (!option) continue;
        click(option);
        await sleep(900);
        opened = true;
        break;
      }
    }

    const rowSelectors = [
      '[class*="call-transcript-panel-v2_row__"]',
      '[class*="call-transcript-panel_row__"]',
      '[class*="transcript"][class*="row"]',
    ];
    let rows = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      rows = unique(rowSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])).filter(visible);
      if (rows.length) break;
      await sleep(150);
    }
    const bubbles = rows.map((row, domIndex) => {
      const textElement = row.querySelector('[class*="call-transcript-panel-v2_text__"], [class*="call-transcript-panel_text__"], [class*="transcript"][class*="text"]');
      const speakerElement = row.querySelector('[class*="speaker"], [class*="name"], [data-speaker]');
      const timestampElement = row.querySelector('time, [class*="timestamp"], [class*="time"]');
      return {
        text: textOf(textElement || row),
        domIndex,
        messageId: row.getAttribute('data-message-id') || row.id || '',
        timestamp: timestampElement?.getAttribute('datetime') || textOf(timestampElement),
        speaker: row.getAttribute('data-speaker') || textOf(speakerElement),
      };
    }).filter((bubble) => bubble.text);
    bubbles.forEach((bubble, index) => {
      bubble.previousText = bubbles[index - 1]?.text || '';
      bubble.nextText = bubbles[index + 1]?.text || '';
    });
    return { opened, bubbles, pageText: textOf(document.body) };
  }})()`, true);
}

function getTranscriptWindow(groupId) {
  const existing = transcriptWindows.get(groupId);
  if (existing && !existing.isDestroyed()) return existing;
  const win = new BrowserWindow({ width: 1280, height: 900, title: `Kindroid transcript ${groupId}`, show: true, webPreferences: kindroidWebPreferences() });
  win.on('closed', () => transcriptWindows.delete(groupId));
  transcriptWindows.set(groupId, win);
  return win;
}

function rememberTranscriptWindow(groupId, win) {
  if (!groupId || !win || win.isDestroyed()) return;
  transcriptWindows.set(groupId, win);
  win.once('closed', () => {
    if (transcriptWindows.get(groupId) === win) transcriptWindows.delete(groupId);
    const timer = transcriptCaptureTimers.get(groupId);
    if (timer) clearTimeout(timer);
    transcriptCaptureTimers.delete(groupId);
  });
}

async function captureTranscriptWindow(win, payload = {}) {
  const groupId = cleanGroupId(payload.groupId);
  const token = String(payload.accessKey || '').trim();
  const sourceUrl = groupCallUrl(groupId);
  const groupName = normalizeText(payload.groupName || payload.session?.group_name);
  const names = payload.participants || payload.session?.names;
  const participants = Array.isArray(names) ? names.map(normalizeText).filter(Boolean) : [];
  if (!groupId || !token || win.isDestroyed() || !isExpectedGroupPage(win.webContents.getURL(), groupId)) return null;
  const extraction = await extractCallTranscript(win);
  if (!extraction.opened || !extraction.bubbles.length || isLoginPageText(extraction.pageText)) return null;
  const capturedAt = new Date().toISOString();
  const repoPath = `transcripts/${groupId}/transcript.json`;
  const merged = await saveMergedTranscript(token, repoPath, {
    groupId, groupName, participants, capturedAt, sourceUrl, bubbles: extraction.bubbles,
  });
  return { capturedAt, repoPath, bubbles: extraction.bubbles, merged, groupId, groupName, participants, sourceUrl };
}

function startAutomaticTranscriptCapture(win, payload = {}) {
  const groupId = cleanGroupId(payload.groupId);
  if (!groupId || !String(payload.accessKey || '').trim()) return;
  const priorTimer = transcriptCaptureTimers.get(groupId);
  if (priorTimer) clearTimeout(priorTimer);
  const tick = async () => {
    if (win.isDestroyed() || transcriptWindows.get(groupId) !== win) return;
    let captured = false;
    try {
      captured = Boolean(await captureTranscriptWindow(win, payload));
    } catch (error) {
      console.warn(`Automatic transcript capture for ${groupId} failed: ${error.message}`);
    }
    const timer = setTimeout(tick, captured ? 60000 : 3000);
    transcriptCaptureTimers.set(groupId, timer);
  };
  const timer = setTimeout(tick, 3000);
  transcriptCaptureTimers.set(groupId, timer);
}

function isExpectedGroupPage(url, groupId) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'kindroid.ai' && parsed.pathname.replace(/\/$/, '') === `/v2/call/group/${groupId}`;
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
  await prepareKindroidSession();
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
  const groupId = cleanGroupId(payload.groupId);
  const existing = transcriptWindows.get(groupId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return true;
  }
  const win = new BrowserWindow({ width: 1280, height: 900, title: 'Kindroid call', show: false, backgroundColor: '#000000', webPreferences: { ...kindroidWebPreferences(), backgroundThrottling: false } });
  rememberTranscriptWindow(groupId, win);
  await prepareKindroidSession();
  const reveal = () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  };
  win.once('ready-to-show', reveal);
  const revealTimer = setTimeout(reveal, 3000);
  try {
    await win.loadURL(String(payload.url || 'https://kindroid.ai/'));
  } finally {
    clearTimeout(revealTimer);
    reveal();
  }
  startAutomaticTranscriptCapture(win, payload);
  return true;
});

ipcMain.handle('lifeline:toggle-kindroid-panel', async () => {
  const panel = createKindroidPanel();
  if (panel.isVisible()) panel.hide();
  else {
    panel.show();
    panel.focus();
    await loadKindroidPanel(panel);
  }
  sendKindroidPanelState();
  return kindroidPanelState();
});

ipcMain.handle('lifeline:get-kindroid-panel-state', () => kindroidPanelState());

function journalProgress(stage, detail = '') {
  console.log(`[Journal Sync] ${stage}${detail ? `: ${detail}` : ''}`);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lifeline:journal-sync-progress', { stage, detail });
}

function journalTimeout(promise, milliseconds, stage) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => { const error = new Error(`Timed out after ${Math.round(milliseconds / 1000)} seconds.`); error.stage = stage; reject(error); }, milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

ipcMain.handle('lifeline:journal-sync-scan', async (_event, payload = {}) => {
  if (activeJournalSync) return failure('busy', 'Another journal synchronization is active.');
  activeJournalSync = { cancelled:false };
  let stage = 'scan-requested';
  try {
    journalProgress('Scan requested');
    const panel=createKindroidPanel(); panel.show(); panel.focus(); journalProgress('Journal window opened');
    const adapter=new KindroidJournalAdapter(panel, { progress: (next, detail) => { stage = next; journalProgress(next, detail); }, cancelled: () => Boolean(activeJournalSync?.cancelled) });
    await prepareKindroidSession(); stage = 'opening-journal-route'; journalProgress('AI ID resolved', payload.aiId);
    const result = await journalTimeout((async () => { await adapter.openJournalPage(payload.aiId); journalProgress('Journal route ready'); return adapter.scan(payload.scope); })(), 90000, stage);
    stage = 'complete'; journalProgress('Scan completed'); journalProgress('Returning entries', String(result.entries.length));
    return {ok:true, stage:'complete', ai_id:String(payload.aiId), ...result, diagnostics:{...result.diagnostics,url:panel.webContents.getURL()}};
  } catch(error) {
    const panel = kindroidPanel && !kindroidPanel.isDestroyed() ? kindroidPanel : null;
    let diagnostics = { url: panel?.webContents?.getURL?.() || '' };
    try { if (panel) diagnostics = { ...diagnostics, ...(await new KindroidJournalAdapter(panel).diagnostics()) }; } catch (_) {}
    diagnostics = { ...diagnostics, ...(error.diagnostics || {}) };
    stage = error.stage || stage || 'journal-scan';
    const login=/LOGIN REQUIRED/.test(error.message); if(login)stage='authentication';
    console.error(`[Journal Sync] Failure at ${stage}: ${error.message}\n${error.stack || ''}\nDiagnostics: ${JSON.stringify(diagnostics)}`);
    journalProgress(login?'login_required':'failed',`${stage}: ${error.message}`);
    return { ok:false, stage, error:error.message, message:error.message, diagnostics };
  }
  finally { activeJournalSync=null; }
});

ipcMain.handle('lifeline:journal-sync-mutate', async (_event, payload = {}) => {
  if(activeJournalSync)return failure('busy','Another journal synchronization is active.'); activeJournalSync={cancelled:false};
  try { const panel=createKindroidPanel();panel.show();const adapter=new KindroidJournalAdapter(panel,{progress:journalProgress,cancelled:()=>Boolean(activeJournalSync?.cancelled)});await journalTimeout(adapter.openJournalPage(payload.aiId),30000,'opening-journal-route');await adapter.selectJournalScope(payload.scope);await adapter.waitForJournalList();const journal=payload.journal||{};journalProgress(payload.operation==='delete'?'deleting':payload.operation==='update'?'updating':'creating');
    if(payload.operation==='create'){await adapter.openNewJournalEditor();}else{await adapter.openJournalEntry(payload.remoteHandle);}
    if(payload.operation==='delete')await adapter.deleteJournalEntry();else{await adapter.replaceJournalKeywords(journal.keywords||[]);await adapter.replaceJournalDescription(journal.description||'');await adapter.saveJournalEntry();}
    journalProgress('verifying');const scan=await journalTimeout(adapter.scan(payload.scope),90000,'verifying-mutation');const intendedHash=payload.operation==='delete'?'':JournalSyncEngine.hashJournal(journal,payload.scope);const exact=scan.entries.filter(entry=>JournalSyncEngine.hashJournal(entry,payload.scope)===intendedHash);if(payload.operation!=='delete'&&exact.length!==1)throw new Error('SAVE RESULT UNCERTAIN');if(payload.operation==='delete'&&scan.entries.some(entry=>String(entry.remote_handle?.remote_id||entry.remote_handle?.visible_text||'')===String(payload.remoteHandle?.remote_id||payload.remoteHandle?.visible_text||'')))throw new Error('DELETE RESULT UNCERTAIN');return {ok:true,stage:'complete',scan,verified:true,remoteEntry:exact[0]||null};
  }catch(error){console.error(`[Journal Sync] Mutation failure at ${error.stage||'journal-mutation'}: ${error.message}\n${error.stack||''}`);journalProgress('failed',error.message);return {ok:false,stage:error.stage||'journal-mutation',error:error.message,message:error.message,diagnostics:{url:kindroidPanel?.webContents?.getURL?.()||''}};}finally{activeJournalSync=null;}
});
ipcMain.handle('lifeline:journal-sync-cancel',()=>{if(activeJournalSync)activeJournalSync.cancelled=true;journalProgress('cancelled');return {ok:true};});
ipcMain.handle('lifeline:journal-sync-status',()=>({active:Boolean(activeJournalSync)}));

ipcMain.handle('lifeline:fetch-group-transcript', async (_event, payload = {}) => {
  const groupId = cleanGroupId(payload.groupId);
  const sourceUrl = groupId ? groupCallUrl(groupId) : '';
  if (!/^[A-Za-z0-9_-]{6,}$/.test(groupId)) return failure('validation', 'A valid Kindroid groupId is required.', { groupId, sourceUrl });
  const token = String(payload.accessKey || '').trim();
  if (!token) return failure('validation', 'GitHub access key is required to save the transcript.', { groupId, sourceUrl });
  const groupName = normalizeText(payload.groupName);
  const participants = Array.isArray(payload.participants) ? payload.participants.map(normalizeText).filter(Boolean) : [];
  const capturedAt = normalizeText(payload.capturedAt) || new Date().toISOString();
  const repoPath = `transcripts/${groupId}/transcript.json`;
  try {
    const win = getTranscriptWindow(groupId);
    // Reuse the already-running GROUPMAKER call. Reloading it here tears down
    // the live call and can leave Kindroid's SPA on a blank page. Only navigate
    // when capture was requested before a call window existed.
    if (!isExpectedGroupPage(win.webContents.getURL(), groupId)) {
      await navigateTranscriptWindow(win, sourceUrl, groupId);
    }
    if (isKindroidAuthenticationPage(win.webContents.getURL())) {
      return failure('authentication', 'Kindroid authentication is required before a transcript can be captured.', { groupId, sourceUrl });
    }
    // Let the call controls settle, open Kindroid's Transcript panel through
    // its exact three-dot menu, and extract only transcript entries from the
    // transcript row containers. Page chrome never participates in capture.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const extraction = await extractCallTranscript(win);
    if (isLoginPageText(extraction.pageText)) {
      return failure('authentication', 'Kindroid displayed its login page. Sign in in the Kindroid panel, then retry transcript capture.', { groupId, sourceUrl });
    }
    if (!extraction.opened) return failure('transcript_panel', 'Could not open the Transcript option from the Kindroid call menu.', { groupId, sourceUrl });
    const bubbles = extraction.bubbles;
    if (!bubbles.length) return failure('dom_extraction', 'The Transcript panel opened, but no transcript entries were found inside its transcript boxes.', { groupId, sourceUrl });
    const merged = await saveMergedTranscript(token, repoPath, { groupId, groupName, participants, capturedAt, sourceUrl, bubbles });
    return { ok: true, groupId, groupName, participants, sourceUrl, repoPath, selectorUsed: 'kindroid-call-transcript-rows', scrollAttempts: 0, bubblesFound: bubbles.length, newEntries: merged.newEntryIds.length, totalEntries: merged.doc.transcript.length, capturedAt };
  } catch (error) {
    const stage = error.stage || (/ERR_|navigation/i.test(error.message) ? 'navigation' : 'selection_extraction');
    return failure(stage, error.message, { groupId, sourceUrl });
  }
});

app.on('second-instance', () => {
  showMainWindow();
});

if (hasSingleInstanceLock) app.whenReady().then(() => {
  createTray();
  createMainWindow();
});
app.on('activate', showMainWindow);
app.on('before-quit', (event) => {
  if (allowQuit) return;
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  if (kindroidPanel && !kindroidPanel.isDestroyed()) kindroidPanel.hide();
  showTrayNotice();
});
// Closing every visible window must not stop the background tray application.
app.on('window-all-closed', () => {});
