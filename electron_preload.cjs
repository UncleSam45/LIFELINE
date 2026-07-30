const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lifelineElectron', {
  openKindroidCall: (payload) => ipcRenderer.invoke('lifeline:open-kindroid-call', payload),
  toggleKindroidPanel: () => ipcRenderer.invoke('lifeline:toggle-kindroid-panel'),
  getKindroidPanelState: () => ipcRenderer.invoke('lifeline:get-kindroid-panel-state'),
  onKindroidPanelState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('lifeline:kindroid-panel-state', listener);
    return () => ipcRenderer.removeListener('lifeline:kindroid-panel-state', listener);
  },
});
