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

/**
 * Lights that follow the OBS scene. Kept here rather than in a profile:
 * the lights belong to the stream, not to whichever game is being played.
 */
const DEFAULT_LIGHTS = {
  enabled: false,
  obsHost: '127.0.0.1',
  obsPort: 4455,
  obsPassword: '',
  nanoleafHost: '',
  nanoleafToken: '',
  nanoleafName: '',
  // [{ scene, effect, color, brightness, off }]; a scene not listed is left alone.
  scenes: [],
};

const MAX_SCENES = 200;

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
  lights: { ...DEFAULT_LIGHTS },
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

/**
 * One scene's wish for the lights, or null when it asks for nothing, so a
 * scene with every field left blank is the same as no entry at all.
 */
function cleanScene(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const scene = String(raw.scene || '').trim().slice(0, 200);
  if (!scene) return null;

  const off = raw.off === true;
  // A single colour and an effect both decide what the panels show, so a
  // colour replaces the effect rather than the two fighting over the light.
  const color = off ? '' : hexColour(raw.color, '');
  const effect = off || color ? '' : String(raw.effect || '').trim().slice(0, 100);
  const blank = raw.brightness === null || raw.brightness === undefined || raw.brightness === '';
  const brightness = off || blank ? null : Math.round(number(raw.brightness, 0, 100, NaN));

  const entry = { scene, effect, color, brightness: Number.isNaN(brightness) ? null : brightness, off };
  if (!entry.off && !entry.effect && !entry.color && entry.brightness === null) return null;
  return entry;
}

function cleanLights(raw) {
  const lights = { ...DEFAULT_LIGHTS, ...(raw && typeof raw === 'object' ? raw : {}) };

  // What OBS shows under Show Connect Info is often pasted whole, as
  // ws://host:port, so the scheme is dropped and a port moves to its field.
  let obsHost = String(lights.obsHost || '').trim().replace(/^wss?:\/\//i, '').split('/')[0];
  let port = Number(lights.obsPort);
  const withPort = obsHost.match(/^([^:]+):(\d+)$/);
  if (withPort) {
    obsHost = withPort[1];
    port = Number(withPort[2]);
  }
  const token = String(lights.nanoleafToken || '');

  const scenes = [];
  for (const entry of Array.isArray(lights.scenes) ? lights.scenes : []) {
    const cleaned = cleanScene(entry);
    if (!cleaned || scenes.some((s) => s.scene === cleaned.scene)) continue;
    scenes.push(cleaned);
    if (scenes.length >= MAX_SCENES) break;
  }

  return {
    enabled: lights.enabled === true,
    obsHost: obsHost.slice(0, 100) || DEFAULT_LIGHTS.obsHost,
    obsPort: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_LIGHTS.obsPort,
    obsPassword: String(lights.obsPassword || '').slice(0, 200),
    nanoleafHost: String(lights.nanoleafHost || '').trim().slice(0, 100),
    // The token becomes part of a URL path, so only the shape Nanoleaf
    // actually hands out is accepted.
    nanoleafToken: /^[A-Za-z0-9]{1,64}$/.test(token) ? token : '',
    nanoleafName: String(lights.nanoleafName || '').trim().slice(0, 60),
    scenes,
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
  settings.lights = cleanLights(settings.lights);
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

module.exports = {
  Settings, DEFAULTS, PLATFORMS, DEFAULT_THEME, DEFAULT_LIGHTS, clean, cleanTheme, cleanLights, cleanScene,
};
