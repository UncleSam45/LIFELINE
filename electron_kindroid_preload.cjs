const { contextBridge, ipcRenderer } = require('electron');

// Only transport privileged cross-origin requests. The actual userscripts are
// injected after the Kindroid document loads and run in the page world.
contextBridge.exposeInMainWorld('lifelineUserscriptBridge', {
  request: (request) => ipcRenderer.invoke('lifeline:userscript-http-request', request),
});
