const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cmf', {
  // window chrome
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  version: () => ipcRenderer.invoke('app:version'),

  // serial diagnostics
  onPortList: (cb) => ipcRenderer.on('serial:portlist', (_e, data) => cb(data)),
  onPortAdded: (cb) => ipcRenderer.on('serial:added', (_e, name) => cb(name)),

  // Smart Tuning — system media detection
  mediaStart: () => ipcRenderer.invoke('media:start'),
  mediaStop: () => ipcRenderer.invoke('media:stop'),
  onMediaUpdate: (cb) => ipcRenderer.on('media:update', (_e, data) => cb(data)),
  onMediaError: (cb) => ipcRenderer.on('media:error', (_e, msg) => cb(msg)),

  // Spotify connect (optional enrichment)
  spotifyStatus: () => ipcRenderer.invoke('spotify:status'),
  spotifySetClientId: (id) => ipcRenderer.invoke('spotify:setClientId', id),
  spotifyConnect: () => ipcRenderer.invoke('spotify:connect'),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify:disconnect'),
  onSpotifyStatus: (cb) => ipcRenderer.on('spotify:status', (_e, data) => cb(data))
});
