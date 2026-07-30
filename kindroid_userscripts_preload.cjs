const { contextBridge, ipcRenderer, webFrame } = require('electron');

const STORAGE_PREFIX = 'lifeline.tampermonkey.';

function getValue(key, fallback) {
  const value = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  if (value === null) return fallback;
  try { return JSON.parse(value); } catch (_error) { return fallback; }
}

function setValue(key, value) {
  localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
}

function deleteValue(key) {
  localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
}

function xmlhttpRequest(options = {}) {
  ipcRenderer.invoke('lifeline:userscript-request', {
    method: options.method,
    url: options.url,
    headers: options.headers,
    data: options.data,
    timeout: options.timeout,
  }).then((response) => {
    if (typeof options.onload === 'function') options.onload(response);
  }).catch((error) => {
    if (error?.name === 'AbortError' && typeof options.ontimeout === 'function') options.ontimeout();
    else if (typeof options.onerror === 'function') options.onerror(error);
  });
}

// Only the APIs declared in the userscript metadata cross into the page. Node,
// Electron, IPC, and the source loader remain in the sandboxed isolated world.
contextBridge.exposeInMainWorld('GM_getValue', getValue);
contextBridge.exposeInMainWorld('GM_setValue', setValue);
contextBridge.exposeInMainWorld('GM_deleteValue', deleteValue);
contextBridge.exposeInMainWorld('GM_xmlhttpRequest', xmlhttpRequest);

async function runMatchedUserscripts() {
  const sources = await ipcRenderer.invoke('lifeline:get-kindroid-userscripts');
  for (const source of sources) await webFrame.executeJavaScript(source);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(runMatchedUserscripts, 0), { once: true });
} else {
  setTimeout(runMatchedUserscripts, 0);
}
