const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('hoMixNative', {
  postMessage(message) {
    ipcRenderer.send('homix-native-command', String(message || ''));
  },
  onMessage(listener) {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('homix-native-message', handler);
    return () => ipcRenderer.removeListener('homix-native-message', handler);
  },
  getPathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
});
