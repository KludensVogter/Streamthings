'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  language: 'auto',
  platform: 'twitch',
  twitchChannel: '',
  youtubeChannel: '',
  overlayPort: 8777,
  activeProfileId: 'default',
  panicKey: 'F8',
  autoUpdate: true,
  windowBounds: null,
};

const PLATFORMS = ['twitch', 'youtube', 'both'];

function clean(raw) {
  const settings = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!PLATFORMS.includes(settings.platform)) settings.platform = 'twitch';

  settings.twitchChannel = String(settings.twitchChannel || '')
    .trim()
    .replace(/^.*twitch\.tv\//i, '')
    .replace(/^[#@]/, '')
    .split(/[/?#]/)[0]
    .slice(0, 40);

  settings.youtubeChannel = String(settings.youtubeChannel || '').trim().slice(0, 200);

  const port = Number(settings.overlayPort);
  settings.overlayPort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 8777;

  settings.autoUpdate = settings.autoUpdate !== false;
  settings.panicKey = String(settings.panicKey || 'F8').slice(0, 20);
  settings.activeProfileId = String(settings.activeProfileId || 'default').slice(0, 60);
  settings.language = String(settings.language || 'auto').slice(0, 10);
  return settings;
}

class Settings {
  constructor(directory) {
    this.file = path.join(directory, 'settings.json');
    this.values = this.read();
  }

  read() {
    try {
      return clean(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return clean({});
    }
  }

  get() {
    return { ...this.values };
  }

  /** Merges a partial update and writes it out; returns the full settings. */
  update(patch) {
    this.values = clean({ ...this.values, ...(patch || {}) });
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2), 'utf8');
    } catch {
      // A failed write should not take the app down; the user just loses
      // this change and will be told by the UI staying on the old value.
    }
    return this.get();
  }

  /** The channel the chosen platform actually needs, for validation. */
  hasChannel() {
    const { platform, twitchChannel, youtubeChannel } = this.values;
    if (platform === 'twitch') return Boolean(twitchChannel);
    if (platform === 'youtube') return Boolean(youtubeChannel);
    return Boolean(twitchChannel || youtubeChannel);
  }
}

module.exports = { Settings, DEFAULTS, PLATFORMS, clean };
