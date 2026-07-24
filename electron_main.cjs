const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const APP_ROOT = __dirname;

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
  win.loadFile(path.join(APP_ROOT, 'index.html'));
  return win;
}

function transcriptCaptureScript(meta) {
  return `(() => {
    if (window.__lifelineTranscriptCaptureInstalled) return;
    window.__lifelineTranscriptCaptureInstalled = true;
    const meta = ${JSON.stringify(meta)};
    const seen = new Set();
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const plausible = (text) => text.length >= 2 && text.length <= 5000 && !/^https?:\/\//i.test(text);
    const collect = () => {
      const rows = [];
      const selectors = ['[data-testid*=message i]', '[class*=message i]', '[class*=chat i]', 'article', 'p', '[role=listitem]'];
      document.querySelectorAll(selectors.join(',')).forEach((node) => {
        const text = clean(node.innerText || node.textContent || '');
        if (!plausible(text)) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ text, capturedAt: new Date().toISOString(), url: location.href, title: document.title });
      });
      if (rows.length) window.lifelineTranscriptBridge?.save({ ...meta, rows });
    };
    window.lifelineTranscriptBridge = { save: async (payload) => {
      try { await fetch('lifeline://transcript', { method: 'POST', body: JSON.stringify(payload) }); } catch (_error) {}
    }};
    collect();
    const observer = new MutationObserver(() => { clearTimeout(window.__lifelineTranscriptTimer); window.__lifelineTranscriptTimer = setTimeout(collect, 1200); });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    setInterval(collect, 30000);
  })();`;
}

async function saveTranscriptToBridge(token, payload) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!token || !rows.length) return;
  const groupId = String(payload.groupId || 'unknown').replace(/[^A-Za-z0-9_-]+/g, '_');
  const day = new Date().toISOString().slice(0, 10);
  const repoPath = `transcripts/${groupId}/${day}.txt`;
  const url = `https://api.github.com/repos/unclesam45/LIFELINE_BRIDGE/contents/${repoPath}`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  let sha = '', existing = '';
  try {
    const res = await fetch(`${url}?ref=main`, { headers });
    if (res.ok) {
      const file = await res.json();
      sha = file.sha || '';
      existing = Buffer.from(String(file.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
    }
  } catch (_error) {}
  const block = rows.map((row) => `[${row.capturedAt}] ${row.text}`).join('\n') + '\n';
  await fetch(url, {
    method: 'PUT', headers,
    body: JSON.stringify({ message: `Capture Kindroid transcript ${groupId}`, branch: 'main', content: Buffer.from(existing + block, 'utf8').toString('base64'), ...(sha ? { sha } : {}) }),
  });
}

ipcMain.handle('lifeline:open-kindroid-call', async (_event, payload = {}) => {
  const win = new BrowserWindow({ width: 1280, height: 900, title: 'Kindroid call', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const token = String(payload.accessKey || '');
  win.webContents.session.protocol.handle('lifeline', async (request) => {
    if (request.url !== 'lifeline://transcript') return new Response('', { status: 404 });
    const body = await request.text();
    saveTranscriptToBridge(token, JSON.parse(body)).catch(console.error);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  win.webContents.on('did-finish-load', () => win.webContents.executeJavaScript(transcriptCaptureScript(payload)).catch(() => {}));
  await win.loadURL(String(payload.url || 'https://kindroid.ai/'));
  return true;
});

app.whenReady().then(createMainWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
