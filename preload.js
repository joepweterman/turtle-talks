const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  chunk: (buf) => ipcRenderer.send('rec:chunk', new Uint8Array(buf)),
  done: () => ipcRenderer.send('rec:done'),
  error: (msg) => ipcRenderer.send('rec:error', String(msg)),
  log: (msg) => ipcRenderer.send('rec:log', String(msg)),
  dictChunk: (buf) => ipcRenderer.send('dict:chunk', new Uint8Array(buf)),
  dictDone: () => ipcRenderer.send('dict:done'),
  dictError: (msg) => ipcRenderer.send('dict:error', String(msg)),
  nudgeAction: (action, arg) => ipcRenderer.send('nudge:action', action, arg),
});
