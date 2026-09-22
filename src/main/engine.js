'use strict';

const { EventEmitter } = require('events');
const input = require('./input');
const { CommandSet, execute } = require('./commands');

const FEED_LENGTH = 14;
const MAX_CONCURRENT = 40;

/**
 * Decides what chat is allowed to do and when.
 *
 * Anarchy drains a queue at a fixed rate, so a busy chat cannot outrun the
 * game. Democracy collects votes for a while and runs the winner.
 */
class Engine extends EventEmitter {
  constructor(profile) {
    super();
    this.apply(profile);
    this.queue = [];
    this.votes = new Map();
    this.voters = new Set();
    this.lastSeen = new Map();
    this.feed = [];
    this.total = 0;
    this.running = false;
    this.paused = false;
    this.inFlight = 0;
    this.roundEndsAt = 0;
    this.lastWinner = null;
    this.timer = null;
  }

  apply(profile) {
    this.profile = profile;
    this.commands = new CommandSet(profile.commands || []);
    this.mode = profile.mode === 'democracy' ? 'democracy' : 'anarchy';
    this.messageRate = Math.max(0.05, Number(profile.messageRate) || 0.4);
    this.maxQueue = Math.max(1, Number(profile.maxQueue) || 20);
    this.userCooldown = Math.max(0, Number(profile.userCooldown) || 0);
    this.voteSeconds = Math.max(2, Number(profile.voteSeconds) || 10);
    this.targetWindow = String(profile.targetWindow || '').trim().toLowerCase();
    // Worked out once per profile so an overriding command does not have to
    // rebuild the list every time it fires.
    this.overrideKeys = this.commands.allKeys();
    this.overrideButtons = this.commands.allButtons();
  }

  /** Swap settings without dropping the chat connection or the queue. */
  reconfigure(profile) {
    const previousMode = this.mode;
    this.apply(profile);
    if (this.mode !== previousMode) {
      this.votes.clear();
      this.voters.clear();
      this.queue.length = 0;
      if (this.running) this.restartLoop();
    }
    this.emitState();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.total = 0;
    this.feed = [];
    this.restartLoop();
  }

  restartLoop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return;
    if (this.mode === 'democracy') this.startRound();
    else this.drain();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.votes.clear();
    this.voters.clear();
    input.releaseAll();
    this.emitState();
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (this.paused) {
      input.releaseAll();
      this.queue.length = 0;
    }
    this.emitState();
  }

  windowIsRight() {
    if (!this.targetWindow) return true;
    return input.foregroundTitle().toLowerCase().includes(this.targetWindow);
  }

  /** Entry point for every chat message from every platform. */
  handleMessage(message) {
    if (!this.running || this.paused) return;
    const parsed = this.commands.parse(message.text);
    if (!parsed) return;
    const { command, seconds } = parsed;

    if (command.modOnly && !message.isMod) {
      this.note(message, command.id, 'blocked');
      return;
    }

    if (this.userCooldown > 0) {
      const key = `${message.platform}:${message.login || message.user}`;
      const now = Date.now();
      const last = this.lastSeen.get(key) || 0;
      if (now - last < this.userCooldown * 1000) return;
      this.lastSeen.set(key, now);
    }

    if (this.mode === 'democracy') {
      const voterKey = `${message.platform}:${message.login || message.user}`;
      if (this.voters.has(voterKey)) return;
      this.voters.add(voterKey);
      this.votes.set(command.id, (this.votes.get(command.id) || 0) + 1);
      this.note(message, command.id, 'vote');
      return;
    }

    if (this.queue.length >= this.maxQueue) return;
    this.queue.push({ message, command, seconds });
  }

  note(message, commandId, kind) {
    this.feed.unshift({
      user: message.user,
      platform: message.platform,
      command: commandId,
      kind,
      at: Date.now(),
    });
    if (this.feed.length > FEED_LENGTH) this.feed.length = FEED_LENGTH;
    if (kind !== 'blocked') this.total += 1;
    this.emitState();
  }

  fire(command, seconds) {
    if (!this.windowIsRight()) return;
    if (this.inFlight >= MAX_CONCURRENT) return;
    this.inFlight += 1;
    execute(command, seconds, {
      overrideKeys: this.overrideKeys,
      overrideButtons: this.overrideButtons,
    })
      .catch(() => {})
      .finally(() => { this.inFlight -= 1; });
  }

  // ---- anarchy ------------------------------------------------------
  drain() {
    if (!this.running || this.mode !== 'anarchy') return;
    this.timer = setTimeout(() => {
      if (!this.paused && this.queue.length > 0) {
        const next = this.queue.shift();
        this.note(next.message, next.seconds
          ? `${next.command.id} ${next.seconds}s`
          : next.command.id, 'run');
        this.fire(next.command, next.seconds);
      }
      this.drain();
    }, this.messageRate * 1000);
  }

  // ---- democracy ----------------------------------------------------
  startRound() {
    if (!this.running || this.mode !== 'democracy') return;
    this.votes.clear();
    this.voters.clear();
    this.roundEndsAt = Date.now() + this.voteSeconds * 1000;
    this.emitState();

    this.timer = setTimeout(() => {
      if (!this.paused) this.endRound();
      this.startRound();
    }, this.voteSeconds * 1000);
  }

  endRound() {
    if (this.votes.size === 0) {
      this.lastWinner = null;
      return;
    }
    const top = Math.max(...this.votes.values());
    const tied = [...this.votes.entries()].filter(([, n]) => n === top).map(([id]) => id);
    const winnerId = tied[Math.floor(Math.random() * tied.length)];
    const command = this.commands.byId(winnerId);
    this.lastWinner = { id: winnerId, votes: top };
    if (command) this.fire(command, null);
    this.emitState();
  }

  voteTally() {
    return [...this.votes.entries()]
      .map(([id, n]) => ({ id, votes: n }))
      .sort((a, b) => b.votes - a.votes)
      .slice(0, 8);
  }

  state() {
    return {
      running: this.running,
      paused: this.paused,
      mode: this.mode,
      total: this.total,
      queued: this.queue.length,
      feed: this.feed,
      votes: this.voteTally(),
      voteSeconds: this.voteSeconds,
      remainingMs: this.mode === 'democracy' ? Math.max(0, this.roundEndsAt - Date.now()) : 0,
      lastWinner: this.lastWinner,
      commands: this.commands.describe(),
      windowOk: this.windowIsRight(),
      targetWindow: this.profile.targetWindow || '',
    };
  }

  emitState() {
    this.emit('state', this.state());
  }
}

module.exports = { Engine };
