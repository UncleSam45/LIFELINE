const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lifelineElectron', {
  openKindroidCall: (payload) => ipcRenderer.invoke('lifeline:open-kindroid-call', payload),
  fetchGroupTranscript: (payload) => ipcRenderer.invoke('lifeline:fetch-group-transcript', payload),
  toggleKindroidPanel: (payload) => ipcRenderer.invoke('lifeline:toggle-kindroid-panel', payload),
  getKindroidPanelState: () => ipcRenderer.invoke('lifeline:get-kindroid-panel-state'),
  onKindroidPanelState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('lifeline:kindroid-panel-state', listener);
    return () => ipcRenderer.removeListener('lifeline:kindroid-panel-state', listener);
  },
});
