const { ipcRenderer, webFrame } = require('electron');

// Tampermonkey injects @grant none scripts into the website's main JavaScript
// world. Reproduce that behavior instead of evaluating the script once after a
// full page load: Kindroid is an SPA, so entering a call often performs only an
// in-page route change and never emits did-finish-load.
async function installKindroidToolkit() {
  try {
    const source = await ipcRenderer.invoke('lifeline:get-kindroid-toolkit-source');
    if (typeof source !== 'string' || !source.trim()) throw new Error('The toolkit source is empty.');
    await webFrame.executeJavaScript(`${source}\n//# sourceURL=lifeline-kindroid-call-toolkit.user.js`, true);
  } catch (error) {
    // Keep failures visible in Electron DevTools instead of silently swallowing
    // them as the old did-finish-load injection did.
    console.error('[LIFELINE] Could not inject the Kindroid userscript:', error);
  }
}

installKindroidToolkit();
