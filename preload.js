const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('api', {
  chunk: (buf) => ipcRenderer.send('rec:chunk', new Uint8Array(buf)),
  done: () => ipcRenderer.send('rec:done'),
  error: (msg) => ipcRenderer.send('rec:error', String(msg)),
  log: (msg) => ipcRenderer.send('rec:log', String(msg)),
  dictChunk: (buf) => ipcRenderer.send('dict:chunk', new Uint8Array(buf)),
  dictDone: () => ipcRenderer.send('dict:done'),
  dictError: (msg) => ipcRenderer.send('dict:error', String(msg)),
  nudgeAction: (action, arg) => ipcRenderer.send('nudge:action', action, arg),
  // main window
  getState: () => ipcRenderer.invoke('ui:get-state'),
  listNotes: () => ipcRenderer.invoke('ui:list-notes'),
  readNote: (file) => ipcRenderer.invoke('ui:read-note', file),
  saveNote: (file, content) => ipcRenderer.invoke('ui:save-note', { file, content }),
  start: (lang) => ipcRenderer.send('ui:start', lang),
  stop: () => ipcRenderer.send('ui:stop'),
  openFolder: () => ipcRenderer.send('ui:open-folder'),
  openRel: (rel) => ipcRenderer.send('ui:open-rel', rel),
  onState: (cb) => ipcRenderer.on('ui:state', (e, s) => cb(s)),
  onProgress: (cb) => ipcRenderer.on('ui:progress', (e, t) => cb(t)),
  onNotesChanged: (cb) => ipcRenderer.on('ui:notes-changed', (e, f) => cb(f)),
  onSelectNote: (cb) => ipcRenderer.on('ui:select-note', (e, f) => cb(f)),
  onDict: (cb) => ipcRenderer.on('ui:dict', (e, h) => cb(h)),
  copyText: (t) => clipboard.writeText(String(t)),
});
