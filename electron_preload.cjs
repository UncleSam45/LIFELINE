const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lifelineElectron', {
  openKindroidCall: (payload) => ipcRenderer.invoke('lifeline:open-kindroid-call', payload),
});

contextBridge.exposeInMainWorld('lifelineKindroidCapture', {
  saveTranscript: (payload) => ipcRenderer.invoke('lifeline:save-transcript', payload),
});
