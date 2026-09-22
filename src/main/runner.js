'use strict';

const { EventEmitter } = require('events');
const input = require('./input');
const { Engine } = require('./engine');
const { CommandSet } = require('./commands');
const { TwitchChat } = require('./chat/twitch');
const { YouTubeChat } = require('./chat/youtube');
const { OverlayServer } = require('./overlay-server');
const { Poll } = require('./poll');
const { ProfileStore } = require('./profiles');
const { Settings } = require('./settings');
const i18n = require('../shared/i18n');

/**
 * Owns everything that has to stay alive while the app is doing something
 * with chat.
 *
 * Two independent features sit on top of one chat connection: the engine,
 * which turns messages into game input, and polls, which ask chat a question.
 * Either can run without the other, and neither consumes messages the other
 * might want — a poll never stops chat playing, and playing never blocks a
 * vote. The connection stays up as long as at least one of them needs it.
 */
class Runner extends EventEmitter {
  constructor(userDataDir) {
    super();
    this.settings = new Settings(userDataDir);
    this.profiles = new ProfileStore(`${userDataDir}/profiles`);
    this.profile = this.profiles.load(this.settings.get().activeProfileId);
    this.engine = new Engine(this.profile);
    this.poll = new Poll();
    this.overlay = new OverlayServer();

    this.connections = [];
    this.connected = new Map();
    this.enginePlaying = false;
    this.error = null;
    this.pollError = null;
    this.overlayError = null;

    this.engine.on('state', () => this.emit('update'));
    this.poll.on('change', () => {
      this.releaseConnection();
      this.emit('update');
    });
  }

  // ---- lifecycle ----------------------------------------------------
  async begin() {
    await this.startOverlay();
  }

  async startOverlay() {
    const port = this.settings.get().overlayPort;
    const actual = await this.overlay.start(port, () => this.overlayState());
    this.overlayError = actual === null ? { key: 'error.portInUse', vars: { port } } : null;
    this.emit('update');
  }

  // ---- the chat connection, shared by both features ------------------
  /** True when something still needs chat messages. */
  needsConnection() {
    return this.enginePlaying || this.poll.status === 'open';
  }

  openConnection() {
    if (this.connections.length > 0) return true;

    const { platform, twitchChannel, youtubeChannel } = this.settings.get();
    const wantTwitch = platform === 'twitch' || platform === 'both';
    const wantYouTube = platform === 'youtube' || platform === 'both';

    if (wantTwitch && twitchChannel) this.addConnection(new TwitchChat(twitchChannel), 'twitch');
    if (wantYouTube && youtubeChannel) this.addConnection(new YouTubeChat(youtubeChannel), 'youtube');

    if (this.connections.length === 0) return false;
    for (const { chat } of this.connections) chat.start();
    return true;
  }

  /** Drops the connection once neither feature wants it any more. */
  releaseConnection() {
    if (this.needsConnection()) return;
    this.closeConnection();
  }

  closeConnection() {
    for (const { chat } of this.connections) chat.stop();
    this.connections = [];
    this.connected.clear();
  }

  addConnection(chat, platform) {
    this.connected.set(platform, false);

    chat.on('message', (message) => {
      const voter = `${message.platform}:${message.login || message.user}`;
      // Both features see every message. The poll only watches — it never
      // swallows one — so a poll and a game can run at the same time.
      this.poll.offer(voter, message.text);
      if (this.enginePlaying) this.engine.handleMessage(message);
    });

    chat.on('status', (status) => {
      this.connected.set(platform, Boolean(status.connected));
      if (status.error) this.error = { key: `error.${status.error}`, platform };
      else if (status.connected) this.error = null;
      this.emit('update');
    });

    this.connections.push({ chat, platform });
  }

  // ---- chat plays the game -------------------------------------------
  start() {
    this.error = null;

    if (!this.settings.hasChannel()) {
      this.error = { key: 'error.noChannel' };
      this.emit('update');
      return false;
    }
    if (new CommandSet(this.profile.commands).size === 0) {
      this.error = { key: 'error.noCommands' };
      this.emit('update');
      return false;
    }

    this.enginePlaying = true;
    if (!this.openConnection()) {
      this.enginePlaying = false;
      this.error = { key: 'error.noChannel' };
      this.emit('update');
      return false;
    }

    this.engine.start();
    this.emit('update');
    return true;
  }

  stop() {
    this.enginePlaying = false;
    this.engine.stop();
    input.releaseAll();
    this.releaseConnection();
    this.emit('update');
  }

  togglePause() {
    this.engine.setPaused(!this.engine.paused);
    return this.engine.paused;
  }

  get running() {
    return this.enginePlaying;
  }

  // ---- polls, independent of the above --------------------------------
  startPoll(config) {
    this.pollError = null;

    if (!this.settings.hasChannel()) {
      this.pollError = { key: 'error.noChannel' };
      this.emit('update');
      return { ok: false, reason: 'noChannel' };
    }

    const result = this.poll.start(config);
    if (!result.ok) {
      this.pollError = { key: `error.${result.reason}` };
      this.emit('update');
      return result;
    }

    if (!this.openConnection()) {
      this.poll.close();
      this.pollError = { key: 'error.noChannel' };
      this.emit('update');
      return { ok: false, reason: 'noChannel' };
    }

    this.emit('update');
    return result;
  }

  stopPoll() {
    this.poll.stop();
    this.releaseConnection();
    this.emit('update');
  }

  closePoll() {
    this.poll.close();
    this.releaseConnection();
    this.emit('update');
  }

  /**
   * Poll keys that would also fire a game command. Nothing breaks when they
   * overlap — both simply happen — but it is worth warning about.
   */
  pollClashes(options) {
    const set = new CommandSet(this.profile.commands);
    const clashing = [];
    for (const option of options || []) {
      const key = String(option.key || '').trim().toLowerCase();
      if (key && set.parse(key)) clashing.push(key);
    }
    return clashing;
  }

  // ---- misc -----------------------------------------------------------
  saveProfile(patch) {
    const merged = { ...this.profile, ...patch, id: this.profile.id };
    this.profile = this.profiles.write(merged);
    this.engine.reconfigure(this.profile);
    this.emit('update');
    return this.profile;
  }

  switchProfile(id) {
    this.profile = this.profiles.load(id);
    this.settings.update({ activeProfileId: this.profile.id });
    this.engine.reconfigure(this.profile);
    this.emit('update');
    return this.profile;
  }

  async saveSettings(patch) {
    const before = this.settings.get();
    const after = this.settings.update(patch);

    if (after.overlayPort !== before.overlayPort) await this.startOverlay();

    const channelChanged = after.twitchChannel !== before.twitchChannel
      || after.youtubeChannel !== before.youtubeChannel
      || after.platform !== before.platform;
    if (channelChanged && this.connections.length > 0) {
      this.closeConnection();
      this.openConnection();
    }

    this.emit('update');
    return after;
  }

  testCommand(id) {
    const set = new CommandSet(this.profile.commands);
    const command = set.byId(id);
    if (!command) return false;
    this.engine.fire(command, null);
    return true;
  }

  // ---- state -----------------------------------------------------------
  language() {
    return i18n.resolve(this.settings.get().language, this.systemLocale || 'en-US');
  }

  state() {
    const connectedList = [...this.connected.entries()]
      .map(([platform, ok]) => ({ platform, connected: ok }));

    return {
      settings: this.settings.get(),
      profile: this.profile,
      profiles: this.profiles.list(),
      engine: this.engine.state(),
      running: this.running,
      connections: connectedList,
      anyConnected: connectedList.some((c) => c.connected),
      error: this.error,
      pollError: this.pollError,
      overlayError: this.overlayError,
      overlayUrl: this.overlay.url(),
      language: this.language(),
      problems: new CommandSet(this.profile.commands).problems(),
      poll: this.poll.state(),
    };
  }

  /** The payload both OBS overlays poll. Each page uses the part it needs. */
  overlayState() {
    const dict = i18n.dictionary(this.language());
    const set = new CommandSet(this.profile.commands);
    const holdable = set.commands.find((c) => c.maxHold > 0);

    // Both overlay pages render their own text, so they get the strings
    // they need rather than the whole dictionary.
    const strings = {};
    for (const [key, value] of Object.entries(dict)) {
      if (key.startsWith('overlay.') || key.startsWith('poll.')) strings[key] = value;
    }

    return {
      theme: this.settings.get().overlayTheme,
      poll: this.poll.active ? this.poll.state() : null,
      mode: this.engine.mode,
      paused: this.engine.paused,
      running: this.running,
      voteSeconds: this.engine.voteSeconds,
      commands: set.describe(),
      holdExample: holdable ? `${holdable.id} 2` : '',
      strings,
    };
  }

  async shutdown() {
    this.poll.close();
    this.stop();
    this.closeConnection();
    await this.overlay.stop();
  }
}

module.exports = { Runner };
