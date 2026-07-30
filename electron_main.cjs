const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_ROOT = __dirname;
const kindroidCallWindows = new Map();
let mainWindow = null;
let kindroidPanel = null;
let tray = null;
let allowQuit = false;
let trayNoticeShown = false;
const KINDROID_PARTITION = 'persist:lifeline-kindroid';
const KINDROID_HOME_URL = 'https://kindroid.ai/';
const KINDROID_TOOLKIT_SOURCE = fs.readFileSync(path.join(APP_ROOT, 'lifeline-kindroid-call-toolkit.user.js'), 'utf8');
const KINDROID_TRANSCRIPT_SOURCE = fs.readFileSync(path.join(APP_ROOT, 'lifeline-kindroid-transcript.user.js'), 'utf8');
// Keep the small PNG in code so installers and pull requests do not need a
// separate binary image asset. Unlike the former SVG data URL, this decodes to
// a native bitmap reliably on Windows, Linux, and macOS.
const TRAY_ICON_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAiElEQVR42mNgF5T/P5CYYdQBow4YdcCQc4DBp2MD5wCQ5TA88hyAbDk1HUETB5DiOKo7gNQQYiAn7vFZQmo0UdUB2EKJkCMYiDEA3SBSHYDPLAZSNGOzjNiQwmUe0SFAq2ghuy4gJWHSpDIacAdQq3QcdQDFDRJKK6eh7wBKW0mjjdJRBwy4AwCd+c2NtKBJNgAAAABJRU5ErkJggg==';
let kindroidSessionReady = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

function kindroidWebPreferences({ userscripts = false } = {}) {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    partition: KINDROID_PARTITION,
    ...(userscripts ? { preload: path.join(APP_ROOT, 'kindroid_userscripts_preload.cjs') } : {}),
  };
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
  kindroidPanel.webContents.on('did-create-window', (child) => attachKindroidUserscripts(child));
  kindroidPanel.webContents.setWindowOpenHandler((details) => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      parent: kindroidPanel,
      autoHideMenuBar: true,
      webPreferences: kindroidWebPreferences({ userscripts: kindroidUserscriptsFor(details.url).length > 0 }),
    },
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

function rememberKindroidCallWindow(groupId, win) {
  if (!groupId) return;
  kindroidCallWindows.set(groupId, win);
  win.once('closed', () => {
    if (kindroidCallWindows.get(groupId) === win) kindroidCallWindows.delete(groupId);
  });
}

function kindroidUserscriptsFor(urlValue) {
  let url;
  try { url = new URL(String(urlValue || '')); } catch (_error) { return []; }
  if (!['kindroid.ai', 'www.kindroid.ai'].includes(url.hostname)) return [];
  const scripts = [];
  if (/^\/(?:call(?:\/|$)|groupchat\/[^/]+\/call(?:\/|$)|v2\/call(?:\/|$))/.test(url.pathname)) {
    scripts.push(KINDROID_TOOLKIT_SOURCE);
  }
  if (/^\/v2\/call(?:\/|$)/.test(url.pathname)) scripts.push(KINDROID_TRANSCRIPT_SOURCE);
  return scripts;
}

function attachKindroidUserscripts(win) {
  win.webContents.on('did-finish-load', () => {
    for (const source of kindroidUserscriptsFor(win.webContents.getURL())) {
      win.webContents.executeJavaScript(source).catch((error) => {
        console.warn(`Could not load a Kindroid userscript: ${error.message}`);
      });
    }
  });
}

ipcMain.handle('lifeline:userscript-request', async (_event, options = {}) => {
  const url = new URL(String(options.url || ''));
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com') {
    throw new Error('Userscript requests are restricted to https://api.github.com.');
  }
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'PUT'].includes(method)) throw new Error(`Userscript request method ${method} is not allowed.`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Number(options.timeout) || 30000, 30000));
  try {
    const response = await fetch(url, {
      method,
      headers: options.headers && typeof options.headers === 'object' ? options.headers : {},
      body: method === 'GET' ? undefined : String(options.data || ''),
      signal: controller.signal,
    });
    return {
      status: response.status,
      statusText: response.statusText,
      responseText: await response.text(),
      finalUrl: response.url,
    };
  } finally {
    clearTimeout(timeout);
  }
});

ipcMain.handle('lifeline:open-kindroid-call', async (_event, payload = {}) => {
  const groupId = String(payload.groupId || '').trim();
  const existing = kindroidCallWindows.get(groupId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return true;
  }
  const win = new BrowserWindow({ width: 1280, height: 900, title: 'Kindroid call', show: false, backgroundColor: '#000000', webPreferences: { ...kindroidWebPreferences({ userscripts: true }), backgroundThrottling: false } });
  attachKindroidUserscripts(win);
  rememberKindroidCallWindow(groupId, win);
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
