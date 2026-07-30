const { ipcRenderer } = require('electron');
const path = require('path');

const STORAGE_PREFIX = 'lifeline.tampermonkey.';

// Reproduce the small subset of Tampermonkey's API used by the standalone
// transcript userscript. The implementation lives in the isolated preload
// world, so Kindroid page code cannot read the privileged request bridge.
globalThis.GM_getValue = (key, fallback) => {
  const value = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  if (value === null) return fallback;
  try { return JSON.parse(value); } catch (_error) { return fallback; }
};
globalThis.GM_setValue = (key, value) => {
  localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
};
globalThis.GM_deleteValue = (key) => {
  localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
};
globalThis.GM_xmlhttpRequest = (options = {}) => {
  let aborted = false;
  ipcRenderer.invoke('lifeline:userscript-request', {
    method: options.method,
    url: options.url,
    headers: options.headers,
    data: options.data,
    timeout: options.timeout,
  }).then((response) => {
    if (!aborted) options.onload?.(response);
  }).catch((error) => {
    if (aborted) return;
    if (error?.name === 'AbortError') options.ontimeout?.();
    else options.onerror?.(error);
  });
  return { abort: () => { aborted = true; } };
};

function runMatchedUserscripts() {
  if (!['kindroid.ai', 'www.kindroid.ai'].includes(location.hostname)) return;
  const pathname = location.pathname;
  if (/^\/(?:call(?:\/|$)|groupchat\/[^/]+\/call(?:\/|$)|v2\/call(?:\/|$))/.test(pathname)) {
    require(path.join(__dirname, 'lifeline-kindroid-call-toolkit.user.js'));
  }
  if (/^\/v2\/call(?:\/|$)/.test(pathname)) {
    require(path.join(__dirname, 'lifeline-kindroid-transcript.user.js'));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(runMatchedUserscripts, 0), { once: true });
} else {
  setTimeout(runMatchedUserscripts, 0);
}
