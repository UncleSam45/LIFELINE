const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lifelineElectron', {
  openKindroidCall: (payload) => ipcRenderer.invoke('lifeline:open-kindroid-call', payload),
  fetchGroupTranscript: (payload) => ipcRenderer.invoke('lifeline:fetch-group-transcript', payload),
  toggleKindroidPanel: () => ipcRenderer.invoke('lifeline:toggle-kindroid-panel'),
  getKindroidPanelState: () => ipcRenderer.invoke('lifeline:get-kindroid-panel-state'),
  onKindroidPanelState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('lifeline:kindroid-panel-state', listener);
    return () => ipcRenderer.removeListener('lifeline:kindroid-panel-state', listener);
  },
  journalSync: {
    scan: (payload) => ipcRenderer.invoke('lifeline:journal-sync-scan', payload),
    apply: (payload) => ipcRenderer.invoke('lifeline:journal-sync-mutate', payload),
    cancel: () => ipcRenderer.invoke('lifeline:journal-sync-cancel'),
    getStatus: () => ipcRenderer.invoke('lifeline:journal-sync-status'),
    showKindroidWindow: () => ipcRenderer.invoke('lifeline:toggle-kindroid-panel'),
    onProgress: (callback) => { const listener=(_event,value)=>callback(value);ipcRenderer.on('lifeline:journal-sync-progress',listener);return()=>ipcRenderer.removeListener('lifeline:journal-sync-progress',listener); },
  },
});
