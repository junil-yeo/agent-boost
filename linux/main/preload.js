// Exposes window.api to the renderer: call a main-process function, listen to pushed events.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('api', {
  call: (method, ...args) => ipcRenderer.invoke('call', method, args),
  on: (channel, cb) => { const f = (_e, p) => cb(p); ipcRenderer.on(channel, f); return () => ipcRenderer.removeListener(channel, f); },
  /** Absolute path of a File dropped or picked in the page. */
  pathOf: (file) => webUtils.getPathForFile(file),
});
