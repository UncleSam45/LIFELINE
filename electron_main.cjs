const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, net } = require('electron');
const path = require('path');

const APP_ROOT = __dirname;
const transcriptWindows = new Map();
let mainWindow = null;
let kindroidPanel = null;
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
const ELECTRON_USERSCRIPT_SHIM = `
  window.GM_getValue = (key, fallback) => {
    const value = localStorage.getItem('lifeline.gm.' + key);
    if (value === null) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
  };
  window.GM_setValue = (key, value) => localStorage.setItem('lifeline.gm.' + key, JSON.stringify(value));
  window.GM_deleteValue = (key) => localStorage.removeItem('lifeline.gm.' + key);
  window.GM_xmlhttpRequest = (options) => {
    const request = { method: options.method, url: options.url, headers: options.headers, data: options.data };
    window.lifelineUserscriptBridge.request(request).then(options.onload, options.onerror);
  };
`;
const KINDROID_USERSCRIPT_SOURCE = ELECTRON_USERSCRIPT_SHIM + [
  'lifeline-kindroid-call-toolkit.user.js',
  'lifeline-kindroid-transcript.user.js',
].map((file) => require('fs').readFileSync(path.join(APP_ROOT, file), 'utf8')).join('\n;\n');
let kindroidSessionReady = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

function kindroidWebPreferences() {
  return {
    preload: path.join(APP_ROOT, 'electron_kindroid_preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    partition: KINDROID_PARTITION,
  };
}

function attachKindroidToolkit(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  const inject = () => {
    if (webContents.isDestroyed() || !/^https:\/\/(?:www\.)?kindroid\.ai\//.test(webContents.getURL())) return;
    webContents.executeJavaScript(KINDROID_USERSCRIPT_SOURCE, true).catch((error) => {
      console.error('[LIFELINE] Could not inject the Kindroid userscripts:', error);
    });
  };
  // A normal document load installs the toolkit once. Its own mount timer then
  // follows Kindroid SPA route changes without repeatedly evaluating the whole
  // userscript or interfering with page startup.
  webContents.on('did-finish-load', inject);
  webContents.on('did-create-window', (childWindow) => attachKindroidToolkit(childWindow.webContents));
}

ipcMain.handle('lifeline:userscript-http-request', async (event, request = {}) => {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!/^https:\/\/(?:www\.)?kindroid\.ai\//.test(senderUrl)) throw new Error('Userscript requests are restricted to Kindroid pages.');
  const target = new URL(String(request.url || ''));
  if (target.protocol !== 'https:' || target.hostname !== 'api.github.com') throw new Error('Userscript requests are restricted to api.github.com.');
  const method = String(request.method || 'GET').toUpperCase();
  if (!['GET', 'PUT'].includes(method)) throw new Error(`Unsupported userscript request method: ${method}`);
  const response = await net.fetch(target.toString(), {
    method,
    headers: request.headers && typeof request.headers === 'object' ? request.headers : {},
    ...(request.data ? { body: String(request.data) } : {}),
  });
  return { status: response.status, responseText: await response.text() };
});

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
  attachKindroidToolkit(kindroidPanel.webContents);
  kindroidPanel.on('show', sendKindroidPanelState);
  kindroidPanel.on('hide', sendKindroidPanelState);
  kindroidPanel.on('closed', () => { kindroidPanel = null; sendKindroidPanelState(); });
  kindroidPanel.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    if (validatedURL === KINDROID_HOME_URL || kindroidPanel?.isDestroyed()) return;
    kindroidPanel.loadURL(KINDROID_HOME_URL).catch(() => {});
  });
  kindroidPanel.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { parent: kindroidPanel, autoHideMenuBar: true, webPreferences: kindroidWebPreferences() },
  }));
  return kindroidPanel;
}

async function loadKindroidPanel(panel) {
  await prepareKindroidSession();
  // Kindroid relies on its service worker and framework caches to interpret SPA
  // navigation responses. Clearing them or forcing no-cache headers can expose
  // the raw framework payload as text instead of rendering the page.
  await panel.loadURL(KINDROID_HOME_URL);
}

function cleanGroupId(value) {
  return String(value || '').trim();
}

function rememberTranscriptWindow(groupId, win) {
  if (!groupId || !win || win.isDestroyed()) return;
  transcriptWindows.set(groupId, win);
  win.once('closed', () => {
    if (transcriptWindows.get(groupId) === win) transcriptWindows.delete(groupId);
  });
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
  attachKindroidToolkit(win.webContents);
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
