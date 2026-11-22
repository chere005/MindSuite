'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('suite', Object.freeze({
  state: () => ipcRenderer.invoke('suite:state'),
  select: (key, side) => ipcRenderer.invoke('suite:select', key, side),
  split: () => ipcRenderer.invoke('suite:split'),
  resize: ratio => ipcRenderer.invoke('suite:resize', ratio),
  retry: key => ipcRenderer.invoke('suite:retry', key),
  external: () => ipcRenderer.invoke('suite:external'),
  subscribe: callback => ipcRenderer.on('suite:state', (_event, value) => callback(value)),
}));
