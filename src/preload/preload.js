'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the page and the rest of the app.
 *
 * The renderer has no Node access, so every capability it has is one of the
 * named calls below.
 */
contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getDictionary: (code) => ipcRenderer.invoke('i18n:get', code),

  start: () => ipcRenderer.invoke('run:start'),
  stop: () => ipcRenderer.invoke('run:stop'),
  togglePause: () => ipcRenderer.invoke('run:pause'),

  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  saveProfile: (patch) => ipcRenderer.invoke('profile:save', patch),

  switchProfile: (id) => ipcRenderer.invoke('profile:switch', id),
  createProfile: (name) => ipcRenderer.invoke('profile:create', name),
  duplicateProfile: (id, name) => ipcRenderer.invoke('profile:duplicate', id, name),
  renameProfile: (id, name) => ipcRenderer.invoke('profile:rename', id, name),
  deleteProfile: (id) => ipcRenderer.invoke('profile:delete', id),
  importProfile: () => ipcRenderer.invoke('profile:import'),
  exportProfile: (id) => ipcRenderer.invoke('profile:export', id),

  testCommand: (id) => ipcRenderer.invoke('command:test', id),
  listWindows: () => ipcRenderer.invoke('windows:list'),
  openOverlay: () => ipcRenderer.invoke('overlay:open'),

  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
  onUpdateChanged: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('update:changed', listener);
    return () => ipcRenderer.removeListener('update:changed', listener);
  },
});
