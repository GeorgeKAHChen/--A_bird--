const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  setIgnore: (v) => ipcRenderer.send('set-ignore', v),
  showMenu: () => ipcRenderer.send('show-menu'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  onCommand: (cb) => ipcRenderer.on('command', (_e, cmd, data) => cb(cmd, data)),
});
