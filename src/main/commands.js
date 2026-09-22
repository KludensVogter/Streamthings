'use strict';

const input = require('./input');
const { SCANCODES, MOUSE_BUTTONS } = require('./scancodes');

const MAX_DURATION = 30;
const DEFAULT_MAX_HOLD = 3;
const DEFAULT_REPEAT_COUNT = 5;
const DEFAULT_REPEAT_INTERVAL = 0.25;
const MAX_REPEAT_COUNT = 50;

/**
 * Commands are stored as an ordered array rather than an object keyed by the
 * chat word. Object keys that look like integers ("1", "2") are reordered by
 * JavaScript itself, which silently shuffled the user's command list in an
 * earlier version of this app.
 */

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function normaliseCommand(raw, index) {
  const id = String(raw.id ?? raw.name ?? `command${index + 1}`).trim().toLowerCase();
  const type = raw.type || (raw.move ? 'move' : raw.button || raw.mouse ? 'mouse' : 'key');

  let keys = [];
  if (Array.isArray(raw.keys)) keys = raw.keys;
  else if (raw.key) keys = [raw.key];
  keys = keys.map((k) => String(k).trim().toLowerCase()).filter(Boolean);

  const duration = Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : 0.15;
  const rawMaxHold = Number(raw.maxHold);

  // Profiles written before the hold switch existed simply had a maxHold,
  // and that is exactly what the switch being on used to mean.
  let allowHold = raw.allowHold !== undefined
    ? Boolean(raw.allowHold)
    : Number.isFinite(rawMaxHold) && rawMaxHold > 0;

  let maxHold = Number.isFinite(rawMaxHold) ? rawMaxHold : 0;
  if (allowHold && maxHold <= 0) maxHold = DEFAULT_MAX_HOLD;

  // Holding and repeating are two answers to the same question, so a command
  // does one or the other. Repeat wins if a file somehow asks for both.
  const allowRepeat = Boolean(raw.allowRepeat);
  if (allowRepeat) allowHold = false;
  if (!allowHold) maxHold = 0;

  const repeatCount = allowRepeat
    ? Math.round(clampNumber(raw.repeatCount, 2, MAX_REPEAT_COUNT, DEFAULT_REPEAT_COUNT))
    : 0;
  const repeatInterval = allowRepeat
    ? clampNumber(raw.repeatInterval, 0.05, 5, DEFAULT_REPEAT_INTERVAL)
    : 0;

  return {
    id,
    aliases: (raw.aliases || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean),
    type,
    keys,
    button: raw.button || raw.mouse || 'left',
    move: Array.isArray(raw.move) ? [Number(raw.move[0]) || 0, Number(raw.move[1]) || 0] : [0, 0],
    duration: Math.max(0, Math.min(duration, MAX_DURATION)),
    allowHold,
    maxHold: Math.max(0, Math.min(maxHold, MAX_DURATION)),
    allowRepeat,
    repeatCount,
    repeatInterval,
    info: String(raw.info || '').trim(),
    modOnly: Boolean(raw.modOnly),
    // Still runs, just not listed on the overlay.
    hidden: Boolean(raw.hidden),
    // Lets go of whatever the streamer is holding before taking over.
    override: Boolean(raw.override),
  };
}

/** Problems worth showing the user, rather than failing silently at stream time. */
function validateCommand(command) {
  const problems = [];
  if (!command.id) problems.push('missingName');
  if (command.type === 'key') {
    if (command.keys.length === 0) problems.push('noKey');
    for (const key of command.keys) {
      if (SCANCODES[key] === undefined) problems.push(`unknownKey:${key}`);
    }
  }
  if (command.type === 'mouse' && !MOUSE_BUTTONS[command.button]) problems.push('unknownButton');
  if (command.type === 'move' && command.move[0] === 0 && command.move[1] === 0) {
    problems.push('noMovement');
  }
  if (command.allowHold && command.maxHold <= 0) problems.push('holdWithoutLimit');
  if (command.allowRepeat && command.repeatCount < 2) problems.push('repeatTooFew');
  return problems;
}

class CommandSet {
  constructor(rawCommands = []) {
    this.commands = rawCommands.map(normaliseCommand);
    this.lookup = new Map();
    for (const command of this.commands) {
      if (!this.lookup.has(command.id)) this.lookup.set(command.id, command);
      for (const alias of command.aliases) {
        if (!this.lookup.has(alias)) this.lookup.set(alias, command);
      }
    }
  }

  get size() {
    return this.commands.length;
  }

  byId(id) {
    return this.commands.find((c) => c.id === id) || null;
  }

  /** Every key this profile can press, for the override to let go of. */
  allKeys() {
    const keys = new Set();
    for (const command of this.commands) {
      if (command.type === 'key') for (const key of command.keys) keys.add(key);
    }
    return [...keys];
  }

  allButtons() {
    const buttons = new Set();
    for (const command of this.commands) {
      if (command.type === 'mouse') buttons.add(command.button);
    }
    return [...buttons];
  }

  /**
   * Turns a chat line into a command plus an optional amount.
   *
   * The number after a command means seconds when it holds and times when it
   * repeats. Since a command only ever does one of the two, there is nothing
   * ambiguous about it.
   */
  parse(text) {
    const trimmed = String(text || '').trim().toLowerCase();
    if (!trimmed) return null;

    const exact = this.lookup.get(trimmed);
    if (exact) return { command: exact, amount: null };

    const parts = trimmed.split(/\s+/);
    const command = this.lookup.get(parts[0]);
    if (!command) return null;

    const limit = command.allowHold ? command.maxHold
      : (command.allowRepeat ? command.repeatCount : 0);

    if (parts.length >= 2 && limit > 0) {
      const asked = Number(parts[1].replace(',', '.'));
      if (Number.isFinite(asked) && asked > 0) {
        const amount = Math.min(asked, limit);
        return { command, amount: command.allowRepeat ? Math.round(amount) : amount };
      }
    }
    return { command, amount: null };
  }

  problems() {
    const found = [];
    const seen = new Set();
    for (const command of this.commands) {
      for (const problem of validateCommand(command)) {
        found.push({ id: command.id, problem });
      }
      for (const word of [command.id, ...command.aliases]) {
        if (seen.has(word)) found.push({ id: command.id, problem: `duplicate:${word}` });
        seen.add(word);
      }
    }
    return found;
  }

  /** What the overlay shows viewers. Hidden commands are left out. */
  describe() {
    return this.commands
      .filter((command) => !command.hidden)
      .map((command) => ({
        id: command.id,
        aliases: command.aliases,
        info: command.info,
        modOnly: command.modOnly,
        holdable: command.allowHold && command.maxHold > 0,
        repeatable: command.allowRepeat && command.repeatCount > 1,
        repeatCount: command.repeatCount,
      }));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One press of whatever this command is: a key, a click or a sweep. */
async function pressOnce(command, duration) {
  if (command.type === 'move') {
    // Spread the movement over several small steps so games that sample the
    // mouse each frame see a smooth sweep instead of one impossible jump.
    const steps = duration > 0.05 ? Math.max(1, Math.round(duration / 0.016)) : 1;
    const dx = command.move[0] / steps;
    const dy = command.move[1] / steps;
    for (let i = 0; i < steps; i += 1) {
      input.mouseMove(dx, dy);
      if (steps > 1) await sleep(16);
    }
    return;
  }

  if (command.type === 'mouse') {
    input.mouseDown(command.button);
    await sleep(duration * 1000);
    input.mouseUp(command.button);
    return;
  }

  // Modifiers are listed first and released last, so shift+w behaves the way
  // a pair of hands would do it.
  for (const key of command.keys) input.keyDown(key);
  await sleep(duration * 1000);
  for (const key of [...command.keys].reverse()) input.keyUp(key);
}

/**
 * Runs a command as real keyboard or mouse input.
 *
 * `amount` is whatever chat asked for: seconds for a holding command, times
 * for a repeating one, and nothing at all for a plain tap.
 *
 * `context.overrideKeys` and `context.overrideButtons` list everything the
 * profile can press; an overriding command releases all of it and then keeps
 * the streamer off those keys while it runs.
 */
async function execute(command, amount, context = {}) {
  const repeating = command.allowRepeat && command.repeatCount > 1;

  let times = 1;
  let duration = command.duration;

  if (repeating) {
    times = Math.round(amount === null || amount === undefined ? command.repeatCount : amount);
    times = Math.max(1, Math.min(times, command.repeatCount));
    // However many presses were asked for, the whole thing stays inside the
    // same ceiling a single command has always had.
    const each = command.duration + command.repeatInterval;
    times = Math.max(1, Math.min(times, Math.floor(MAX_DURATION / Math.max(each, 0.01))));
  } else if (amount !== null && amount !== undefined) {
    duration = amount;
  }

  if (command.allowHold && command.maxHold > 0) duration = Math.min(duration, command.maxHold);
  duration = Math.max(0, Math.min(duration, MAX_DURATION));

  if (command.override) {
    const span = repeating
      ? (times * duration) + ((times - 1) * command.repeatInterval)
      : duration;
    // Let go of what she is holding, then keep her off those keys for as
    // long as the command lasts, so chat actually wins rather than being
    // out-mashed.
    input.releaseIfDown(context.overrideKeys || [], context.overrideButtons || []);
    input.beginOverride(context.overrideKeys || [], context.overrideButtons || [], span * 1000);
  }

  for (let i = 0; i < times; i += 1) {
    await pressOnce(command, duration);
    if (i < times - 1) await sleep(command.repeatInterval * 1000);
  }
}

module.exports = {
  CommandSet, normaliseCommand, validateCommand, execute,
  MAX_DURATION, DEFAULT_MAX_HOLD, DEFAULT_REPEAT_COUNT, DEFAULT_REPEAT_INTERVAL,
  MAX_REPEAT_COUNT,
};
