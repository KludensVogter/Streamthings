'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell } = require('electron');
const { Runner } = require('./runner');
const { KEY_NAMES } = require('./scancodes');
const input = require('./input');
const i18n = require('../shared/i18n');

const isDev = process.argv.includes('--dev') || !app.isPackaged;

let mainWindow = null;
let runner = null;
let updateStatus = { state: 'idle' };

// A second copy would fight the first one over the overlay port and the
// panic key, so hand focus back to the window that is already open.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  start();
}

function start() {
  app.whenReady().then(async () => {
    runner = new Runner(app.getPath('userData'));
    runner.systemLocale = app.getLocale();
    await runner.begin();

    runner.on('update', pushState);

    createWindow();
    registerPanicKey();
    registerIpc();
    if (!isDev) setupUpdater();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('will-quit', async (event) => {
    globalShortcut.unregisterAll();
    input.enableOverrideHooks(false);
    if (runner) {
      event.preventDefault();
      const closing = runner;
      runner = null;
      await closing.shutdown();
      app.quit();
    }
  });
}

function createWindow() {
  const saved = runner.settings.get().windowBounds;
  mainWindow = new BrowserWindow({
    width: saved?.width || 1180,
    height: saved?.height || 820,
    x: saved?.x,
    y: saved?.y,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0c0a14',
    autoHideMenuBar: true,
    title: 'Streamthings',
    icon: path.join(__dirname, '..', '..', 'resources', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getNormalBounds();
    runner?.settings.update({ windowBounds: bounds });
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Keep the app inside the app: links open in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// A busy chat fires an update per message. Coalescing them keeps the IPC
// channel and the renderer calm without the UI feeling laggy.
let pushTimer = null;

function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (runner && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state:changed', runner.state());
    }
  }, 150);
}

function registerPanicKey() {
  globalShortcut.unregisterAll();
  const key = runner.settings.get().panicKey || 'F8';
  // The override hooks must never swallow this one.
  input.setPanicKeyName(key.toLowerCase());
  try {
    globalShortcut.register(key, () => {
      if (!runner) return;
      // Hand the keyboard straight back before anything else.
      input.releaseOverride();
      runner.togglePause();
      pushState();
    });
  } catch {
    // An accelerator another app already owns simply stays unavailable;
    // the in-app pause button still works.
  }
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_event, ...args) => fn(...args));

  handle('state:get', () => runner.state());
  handle('app:info', () => ({
    version: app.getVersion(),
    languages: i18n.available().map((code) => ({ code, name: i18n.LANGUAGE_NAMES[code] || code })),
    keys: KEY_NAMES,
    isDev,
  }));
  handle('i18n:get', (code) => i18n.dictionary(code || runner.language()));

  handle('run:start', () => { runner.start(); return runner.state(); });
  handle('run:stop', () => { runner.stop(); return runner.state(); });
  handle('run:pause', () => { runner.togglePause(); return runner.state(); });

  handle('settings:save', async (patch) => {
    const before = runner.settings.get().panicKey;
    const after = await runner.saveSettings(patch);
    if (after.panicKey !== before) registerPanicKey();
    return runner.state();
  });

  handle('profile:save', (patch) => { runner.saveProfile(patch); return runner.state(); });
  handle('profile:switch', (id) => { runner.switchProfile(id); return runner.state(); });
  handle('profile:create', (name) => {
    const created = runner.profiles.create(name);
    runner.switchProfile(created.id);
    return runner.state();
  });
  handle('profile:duplicate', (id, name) => {
    const copy = runner.profiles.duplicate(id, name);
    if (copy) runner.switchProfile(copy.id);
    return runner.state();
  });
  handle('profile:rename', (id, name) => {
    runner.profiles.rename(id, name);
    if (runner.profile.id === id) runner.switchProfile(id);
    runner.emit('update');
    return runner.state();
  });
  handle('profile:delete', (id) => {
    const result = runner.profiles.remove(id);
    if (result.ok && runner.profile.id === id) {
      runner.switchProfile(runner.profiles.list()[0].id);
    }
    runner.emit('update');
    return { result, state: runner.state() };
  });

  handle('profile:import', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Import profile',
      filters: [{ name: 'Streamthings profile', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true, state: runner.state() };
    try {
      const result = runner.profiles.importFrom(picked.filePaths[0]);
      if (result.ok) runner.switchProfile(result.profile.id);
      return { result, state: runner.state() };
    } catch {
      return { result: { ok: false, reason: 'unreadable' }, state: runner.state() };
    }
  });

  handle('profile:export', async (id) => {
    const profile = runner.profiles.read(id);
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Export profile',
      defaultPath: `${profile ? profile.name : 'profile'}.json`,
      filters: [{ name: 'Streamthings profile', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePath) return { cancelled: true };
    return runner.profiles.exportTo(id, picked.filePath);
  });

  handle('poll:start', (config) => ({ result: runner.startPoll(config), state: runner.state() }));
  handle('poll:stop', () => { runner.stopPoll(); return runner.state(); });
  handle('poll:close', () => { runner.closePoll(); return runner.state(); });

  handle('command:test', (id) => runner.testCommand(id));
  handle('windows:list', () => input.listWindows());
  handle('override:status', () => input.overrideStatus());
  handle('overlay:open', () => {
    const url = runner.overlay.url();
    if (url) shell.openExternal(url);
    return Boolean(url);
  });

  handle('update:status', () => updateStatus);
  handle('update:check', () => {
    if (isDev) return { state: 'dev' };
    checkForUpdates(true);
    return updateStatus;
  });
  handle('update:install', () => {
    if (updateStatus.state === 'ready') {
      require('electron-updater').autoUpdater.quitAndInstall();
    }
    return true;
  });
}

// ---- auto update -----------------------------------------------------

function setUpdateStatus(next) {
  updateStatus = next;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:changed', updateStatus);
  }
}

function setupUpdater() {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setUpdateStatus({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdateStatus({ state: 'none' }));
  autoUpdater.on('update-available', (info) => setUpdateStatus({ state: 'downloading', version: info.version }));
  autoUpdater.on('download-progress', (p) => setUpdateStatus({
    state: 'downloading', percent: Math.round(p.percent), version: updateStatus.version,
  }));
  autoUpdater.on('update-downloaded', (info) => setUpdateStatus({ state: 'ready', version: info.version }));
  autoUpdater.on('error', () => setUpdateStatus({ state: 'failed' }));

  if (runner.settings.get().autoUpdate) {
    setTimeout(() => checkForUpdates(false), 4000);
    setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
  }
}

function checkForUpdates(manual) {
  if (isDev) return;
  if (!manual && !runner.settings.get().autoUpdate) return;
  try {
    require('electron-updater').autoUpdater.checkForUpdates();
  } catch {
    setUpdateStatus({ state: 'failed' });
  }
}
