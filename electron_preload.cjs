const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lifelineElectron', {
  openKindroidCall: (payload) => ipcRenderer.invoke('lifeline:open-kindroid-call', payload),
});
