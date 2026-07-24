const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lifelineElectron', {
  openKindroidCall: (payload) => ipcRenderer.invoke('lifeline:open-kindroid-call', payload),
  openKindroidPanel: () => ipcRenderer.invoke('lifeline:open-kindroid-panel'),
  fetchGroupTranscript: (payload) => ipcRenderer.invoke('lifeline:fetch-group-transcript', payload),
});
