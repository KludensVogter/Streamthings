'use strict';

const input = require('./input');
const { SCANCODES, MOUSE_BUTTONS } = require('./scancodes');

const MAX_DURATION = 30;

/**
 * Commands are stored as an ordered array rather than an object keyed by the
 * chat word. Object keys that look like integers ("1", "2") are reordered by
 * JavaScript itself, which silently shuffled the user's command list in an
 * earlier version of this app.
 */

function normaliseCommand(raw, index) {
  const id = String(raw.id ?? raw.name ?? `command${index + 1}`).trim().toLowerCase();
  const type = raw.type || (raw.move ? 'move' : raw.button || raw.mouse ? 'mouse' : 'key');

  let keys = [];
  if (Array.isArray(raw.keys)) keys = raw.keys;
  else if (raw.key) keys = [raw.key];
  keys = keys.map((k) => String(k).trim().toLowerCase()).filter(Boolean);

  const duration = Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : 0.15;
  const maxHold = Number.isFinite(Number(raw.maxHold)) ? Number(raw.maxHold) : 0;

  return {
    id,
    aliases: (raw.aliases || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean),
    type,
    keys,
    button: raw.button || raw.mouse || 'left',
    move: Array.isArray(raw.move) ? [Number(raw.move[0]) || 0, Number(raw.move[1]) || 0] : [0, 0],
    duration: Math.max(0, Math.min(duration, MAX_DURATION)),
    maxHold: Math.max(0, Math.min(maxHold, MAX_DURATION)),
    info: String(raw.info || '').trim(),
    modOnly: Boolean(raw.modOnly),
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

  /**
   * Turns a chat line into a command plus an optional hold time.
   * "forward" -> tap. "forward 2" -> hold for two seconds, capped by maxHold.
   */
  parse(text) {
    const trimmed = String(text || '').trim().toLowerCase();
    if (!trimmed) return null;

    const exact = this.lookup.get(trimmed);
    if (exact) return { command: exact, seconds: null };

    const parts = trimmed.split(/\s+/);
    const command = this.lookup.get(parts[0]);
    if (!command) return null;

    if (parts.length >= 2 && command.maxHold > 0) {
      const seconds = Number(parts[1].replace(',', '.'));
      if (Number.isFinite(seconds) && seconds > 0) {
        return { command, seconds: Math.min(seconds, command.maxHold) };
      }
    }
    return { command, seconds: null };
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

  /** What the overlay shows viewers. */
  describe() {
    return this.commands.map((c) => ({
      id: c.id,
      aliases: c.aliases,
      info: c.info,
      modOnly: c.modOnly,
      holdable: c.maxHold > 0,
    }));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a command as real keyboard or mouse input. */
async function execute(command, seconds) {
  let duration = seconds === null || seconds === undefined ? command.duration : seconds;
  if (command.maxHold > 0) duration = Math.min(duration, command.maxHold);
  duration = Math.max(0, Math.min(duration, MAX_DURATION));

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

  for (const key of command.keys) input.keyDown(key);
  await sleep(duration * 1000);
  for (const key of [...command.keys].reverse()) input.keyUp(key);
}

module.exports = { CommandSet, normaliseCommand, validateCommand, execute, MAX_DURATION };
