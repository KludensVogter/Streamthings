'use strict';

const fs = require('fs');
const path = require('path');

/** The only profile a clean install ships with: WASD plus mouse. */
function defaultProfile() {
  return {
    id: 'default',
    name: 'Default',
    mode: 'anarchy',
    voteSeconds: 10,
    messageRate: 0.4,
    maxQueue: 20,
    userCooldown: 0,
    targetWindow: '',
    commands: [
      { id: 'forward', aliases: ['w', 'up'], type: 'key', keys: ['w'], duration: 0.4, maxHold: 3, info: 'Walk forward' },
      { id: 'back', aliases: ['s', 'down'], type: 'key', keys: ['s'], duration: 0.4, maxHold: 3, info: 'Walk backwards' },
      { id: 'left', aliases: ['a'], type: 'key', keys: ['a'], duration: 0.3, maxHold: 3, info: 'Strafe left' },
      { id: 'right', aliases: ['d'], type: 'key', keys: ['d'], duration: 0.3, maxHold: 3, info: 'Strafe right' },
      { id: 'sprint', aliases: ['run'], type: 'key', keys: ['shift', 'w'], duration: 1, maxHold: 4, info: 'Sprint forward' },
      { id: 'jump', aliases: ['space'], type: 'key', keys: ['space'], duration: 0.1, info: 'Jump' },
      { id: 'crouch', aliases: ['duck', 'ctrl'], type: 'key', keys: ['ctrl'], duration: 0.5, maxHold: 3, info: 'Crouch' },
      { id: 'use', aliases: ['e', 'interact'], type: 'key', keys: ['e'], duration: 0.1, info: 'Use or pick up' },
      { id: 'reload', aliases: ['r'], type: 'key', keys: ['r'], duration: 0.1, info: 'Reload' },
      { id: 'attack', aliases: ['hit', 'click'], type: 'mouse', button: 'left', duration: 0.05, info: 'Attack or shoot' },
      { id: 'aim', aliases: ['ads'], type: 'mouse', button: 'right', duration: 0.3, maxHold: 3, info: 'Aim down sights' },
      { id: 'lookleft', aliases: ['turnleft'], type: 'move', move: [-250, 0], duration: 0.2, info: 'Turn left' },
      { id: 'lookright', aliases: ['turnright'], type: 'move', move: [250, 0], duration: 0.2, info: 'Turn right' },
      { id: 'lookup', aliases: [], type: 'move', move: [0, -150], duration: 0.2, info: 'Look up' },
      { id: 'lookdown', aliases: [], type: 'move', move: [0, 150], duration: 0.2, info: 'Look down' },
      { id: '1', aliases: [], type: 'key', keys: ['1'], duration: 0.1, info: 'Select slot 1' },
      { id: '2', aliases: [], type: 'key', keys: ['2'], duration: 0.1, info: 'Select slot 2' },
      { id: '3', aliases: [], type: 'key', keys: ['3'], duration: 0.1, info: 'Select slot 3' },
      { id: '4', aliases: [], type: 'key', keys: ['4'], duration: 0.1, info: 'Select slot 4' },
      { id: '5', aliases: [], type: 'key', keys: ['5'], duration: 0.1, info: 'Select slot 5' },
    ],
  };
}

// Letters that are their own character rather than an accented base, so
// Unicode normalisation leaves them behind. Without this, a Danish profile
// name like "Højre" would slug to "h-jre".
const TRANSLITERATE = {
  ø: 'o', æ: 'ae', å: 'a', ß: 'ss', ð: 'd', þ: 'th', ł: 'l', đ: 'd', ı: 'i', œ: 'oe',
};

function slugify(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[øæåßðþłđıœ]/g, (ch) => TRANSLITERATE[ch] || ch)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'profile';
}

/** Accepts anything and returns something the engine can safely run. */
function sanitise(raw, fallbackId) {
  const profile = raw && typeof raw === 'object' ? raw : {};
  const commands = Array.isArray(profile.commands) ? profile.commands : [];
  return {
    id: slugify(profile.id || fallbackId || profile.name),
    name: String(profile.name || fallbackId || 'Profile').slice(0, 60),
    mode: profile.mode === 'democracy' ? 'democracy' : 'anarchy',
    voteSeconds: clamp(profile.voteSeconds, 2, 120, 10),
    messageRate: clamp(profile.messageRate, 0.05, 10, 0.4),
    maxQueue: Math.round(clamp(profile.maxQueue, 1, 200, 20)),
    userCooldown: clamp(profile.userCooldown, 0, 300, 0),
    targetWindow: String(profile.targetWindow || '').slice(0, 200),
    commands,
  };
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

class ProfileStore {
  constructor(directory) {
    this.dir = directory;
    fs.mkdirSync(this.dir, { recursive: true });
    if (this.list().length === 0) this.write(defaultProfile());
  }

  pathFor(id) {
    return path.join(this.dir, `${slugify(id)}.json`);
  }

  list() {
    let files;
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.json'));
    } catch {
      return [];
    }
    const profiles = [];
    for (const file of files) {
      const profile = this.read(path.basename(file, '.json'));
      if (profile) profiles.push({ id: profile.id, name: profile.name, commands: profile.commands.length });
    }
    return profiles.sort((a, b) => {
      if (a.id === 'default') return -1;
      if (b.id === 'default') return 1;
      return a.name.localeCompare(b.name);
    });
  }

  read(id) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.pathFor(id), 'utf8'));
      return sanitise(raw, id);
    } catch {
      return null;
    }
  }

  /** Falls back to a fresh default if the requested profile is gone. */
  load(id) {
    return this.read(id) || this.read('default') || this.write(defaultProfile());
  }

  write(profile) {
    const clean = sanitise(profile, profile.id);
    fs.writeFileSync(this.pathFor(clean.id), JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  }

  create(name) {
    const base = slugify(name);
    let id = base;
    let n = 2;
    while (fs.existsSync(this.pathFor(id))) id = `${base}-${n++}`;
    return this.write({ ...defaultProfile(), id, name: name || 'New profile' });
  }

  duplicate(id, newName) {
    const source = this.read(id);
    if (!source) return null;
    const name = newName || `${source.name} copy`;
    const base = slugify(name);
    let newId = base;
    let n = 2;
    while (fs.existsSync(this.pathFor(newId))) newId = `${base}-${n++}`;
    return this.write({ ...source, id: newId, name });
  }

  rename(id, newName) {
    const profile = this.read(id);
    if (!profile) return null;
    profile.name = String(newName || profile.name).slice(0, 60);
    return this.write(profile);
  }

  /** Deleting the last profile would leave nothing to run, so refuse it. */
  remove(id) {
    if (this.list().length <= 1) return { ok: false, reason: 'lastProfile' };
    try {
      fs.unlinkSync(this.pathFor(id));
      return { ok: true };
    } catch {
      return { ok: false, reason: 'notFound' };
    }
  }

  importFrom(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const fallbackName = path.basename(filePath, '.json');
    const incoming = sanitise(raw, fallbackName);
    if (!Array.isArray(incoming.commands) || incoming.commands.length === 0) {
      return { ok: false, reason: 'noCommands' };
    }
    const base = slugify(incoming.name || fallbackName);
    let id = base;
    let n = 2;
    while (fs.existsSync(this.pathFor(id))) id = `${base}-${n++}`;
    const saved = this.write({ ...incoming, id, name: incoming.name || fallbackName });
    return { ok: true, profile: saved };
  }

  exportTo(id, filePath) {
    const profile = this.read(id);
    if (!profile) return { ok: false, reason: 'notFound' };
    const { id: _omit, ...portable } = profile;
    fs.writeFileSync(filePath, JSON.stringify(portable, null, 2), 'utf8');
    return { ok: true };
  }
}

module.exports = { ProfileStore, defaultProfile, sanitise, slugify };
