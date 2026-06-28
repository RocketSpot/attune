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

  // music providers (genre/art enrichment)
  providersGet: () => ipcRenderer.invoke('providers:get'),
  providersSet: (patch) => ipcRenderer.invoke('providers:set', patch),
  lastfmSetKey: (key) => ipcRenderer.invoke('lastfm:setKey', key),

  // Spotify connect
  spotifyStatus: () => ipcRenderer.invoke('spotify:status'),
  spotifySetClientId: (id) => ipcRenderer.invoke('spotify:setClientId', id),
  spotifyConnect: () => ipcRenderer.invoke('spotify:connect'),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify:disconnect'),
  onSpotifyStatus: (cb) => ipcRenderer.on('spotify:status', (_e, data) => cb(data)),

  // app settings (close-to-tray, github repo, start-at-login)
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  // tray battery tooltip
  setTrayBattery: (data) => ipcRenderer.send('tray:battery', data),

  // feedback
  feedbackSave: (entry) => ipcRenderer.invoke('feedback:save', entry),
  feedbackOpen: () => ipcRenderer.invoke('feedback:open')
});
