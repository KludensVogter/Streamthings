'use strict';

const { EventEmitter } = require('events');

const MAX_OPTIONS = 8;
const MAX_QUESTION = 160;
const MAX_LABEL = 60;
const MAX_KEY = 20;
/** How long the result stays up after voting closes, before the overlay
 *  goes back to the command list on its own. */
const RESULT_LINGER_MS = 20000;

/**
 * A question the streamer puts to chat, answered by typing.
 *
 * Separate from the engine's democracy mode: that one picks which key to
 * press, this one asks chat something and shows the answer.
 */
class Poll extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle'; // idle | open | closed
    this.question = '';
    this.options = [];
    this.votes = new Map(); // voter -> option index
    this.endsAt = 0;
    this.closedAt = 0;
    this.durationSeconds = 0;
    this.timer = null;
    this.lingerTimer = null;
  }

  /** options: [{ key, label }]. Blank keys are numbered automatically. */
  start({ question, options, durationSeconds }) {
    this.clearTimers();

    const cleaned = [];
    for (const raw of options || []) {
      const label = String(raw.label || '').trim().slice(0, MAX_LABEL);
      if (!label) continue;
      const key = String(raw.key || '').trim().toLowerCase().slice(0, MAX_KEY)
        || String(cleaned.length + 1);
      if (cleaned.some((o) => o.key === key)) continue;
      cleaned.push({ key, label });
      if (cleaned.length >= MAX_OPTIONS) break;
    }

    if (cleaned.length < 2) return { ok: false, reason: 'needTwoOptions' };

    this.question = String(question || '').trim().slice(0, MAX_QUESTION);
    this.options = cleaned;
    this.votes = new Map();
    this.durationSeconds = Math.max(0, Math.min(Number(durationSeconds) || 0, 3600));
    this.status = 'open';
    this.closedAt = 0;
    this.endsAt = this.durationSeconds > 0 ? Date.now() + this.durationSeconds * 1000 : 0;

    if (this.durationSeconds > 0) {
      this.timer = setTimeout(() => this.stop(), this.durationSeconds * 1000);
    }
    this.emit('change');
    return { ok: true };
  }

  /**
   * Offers a chat message to the poll.
   * Returns true when it was a vote, so the caller knows not to also treat
   * it as a game command.
   */
  offer(voterKey, text) {
    if (this.status !== 'open') return false;
    const word = String(text || '').trim().toLowerCase();
    if (!word) return false;

    const index = this.options.findIndex((option) => option.key === word);
    if (index === -1) return false;

    // Voting again replaces the previous choice rather than adding to it.
    const previous = this.votes.get(voterKey);
    this.votes.set(voterKey, index);
    if (previous !== index) this.emit('change');
    return true;
  }

  /** Closes voting but leaves the result on screen. */
  stop() {
    if (this.status !== 'open') return;
    this.clearTimers();
    this.status = 'closed';
    this.closedAt = Date.now();
    this.lingerTimer = setTimeout(() => this.close(), RESULT_LINGER_MS);
    this.emit('change');
  }

  /** Clears the poll entirely; the overlay goes back to the commands. */
  close() {
    this.clearTimers();
    this.status = 'idle';
    this.question = '';
    this.options = [];
    this.votes = new Map();
    this.endsAt = 0;
    this.closedAt = 0;
    this.emit('change');
  }

  clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.timer = null;
    this.lingerTimer = null;
  }

  get active() {
    return this.status !== 'idle';
  }

  results() {
    const counts = new Array(this.options.length).fill(0);
    for (const index of this.votes.values()) {
      if (counts[index] !== undefined) counts[index] += 1;
    }
    const total = counts.reduce((sum, n) => sum + n, 0);
    const top = counts.length ? Math.max(...counts) : 0;

    return this.options.map((option, index) => ({
      key: option.key,
      label: option.label,
      votes: counts[index],
      percent: total > 0 ? Math.round((counts[index] / total) * 100) : 0,
      // With no votes at all nothing is winning, so nothing is highlighted.
      leading: total > 0 && counts[index] === top,
    }));
  }

  state() {
    return {
      status: this.status,
      question: this.question,
      options: this.results(),
      totalVotes: this.votes.size,
      remainingMs: this.status === 'open' && this.endsAt
        ? Math.max(0, this.endsAt - Date.now())
        : 0,
      durationSeconds: this.durationSeconds,
    };
  }
}

module.exports = { Poll, MAX_OPTIONS, RESULT_LINGER_MS };
