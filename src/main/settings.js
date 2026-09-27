'use strict';

const fs = require('fs');
const path = require('path');

/** How both overlays look. Sent to the pages and applied as CSS variables. */
const DEFAULT_THEME = {
  accent: '#b98bff',
  background: '#0d0a18',
  opacity: 0.86,
  text: '#f4f1ff',
  radius: 16,
  width: 352,
  scale: 1,
  border: true,
  showTitle: true,
  showAliases: true,
  showHoldHint: true,
};

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
  overlayTheme: { ...DEFAULT_THEME },
};

const PLATFORMS = ['twitch', 'youtube', 'both'];

function hexColour(value, fallback) {
  const text = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback;
}

function number(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function cleanTheme(raw) {
  const theme = { ...DEFAULT_THEME, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    accent: hexColour(theme.accent, DEFAULT_THEME.accent),
    background: hexColour(theme.background, DEFAULT_THEME.background),
    text: hexColour(theme.text, DEFAULT_THEME.text),
    // Fully transparent would make the sign invisible with no way to tell
    // why, so the floor keeps it faint rather than gone.
    opacity: number(theme.opacity, 0.15, 1, DEFAULT_THEME.opacity),
    radius: Math.round(number(theme.radius, 0, 32, DEFAULT_THEME.radius)),
    width: Math.round(number(theme.width, 240, 640, DEFAULT_THEME.width)),
    scale: number(theme.scale, 0.75, 1.5, DEFAULT_THEME.scale),
    border: theme.border !== false,
    showTitle: theme.showTitle !== false,
    showAliases: theme.showAliases !== false,
    showHoldHint: theme.showHoldHint !== false,
  };
}

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
  settings.overlayTheme = cleanTheme(settings.overlayTheme);
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

module.exports = { Settings, DEFAULTS, PLATFORMS, DEFAULT_THEME, clean, cleanTheme };
