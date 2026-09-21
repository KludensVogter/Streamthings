'use strict';

const { EventEmitter } = require('events');
const input = require('./input');
const { Engine } = require('./engine');
const { CommandSet } = require('./commands');
const { TwitchChat } = require('./chat/twitch');
const { YouTubeChat } = require('./chat/youtube');
const { OverlayServer } = require('./overlay-server');
const { ProfileStore } = require('./profiles');
const { Settings } = require('./settings');
const i18n = require('../shared/i18n');

/**
 * Owns everything that has to stay alive while chat is playing: the engine,
 * one connector per platform, and the overlay server.
 */
class Runner extends EventEmitter {
  constructor(userDataDir) {
    super();
    this.settings = new Settings(userDataDir);
    this.profiles = new ProfileStore(`${userDataDir}/profiles`);
    this.profile = this.profiles.load(this.settings.get().activeProfileId);
    this.engine = new Engine(this.profile);
    this.overlay = new OverlayServer();
    this.connections = [];
    this.connected = new Map();
    this.error = null;
    this.overlayError = null;

    this.engine.on('state', () => this.emit('update'));
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

  start() {
    this.stopConnections();
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

    const { platform, twitchChannel, youtubeChannel } = this.settings.get();
    const wantTwitch = platform === 'twitch' || platform === 'both';
    const wantYouTube = platform === 'youtube' || platform === 'both';

    if (wantTwitch && twitchChannel) this.addConnection(new TwitchChat(twitchChannel), 'twitch');
    if (wantYouTube && youtubeChannel) this.addConnection(new YouTubeChat(youtubeChannel), 'youtube');

    if (this.connections.length === 0) {
      this.error = { key: 'error.noChannel' };
      this.emit('update');
      return false;
    }

    this.engine.start();
    for (const { chat } of this.connections) chat.start();
    this.emit('update');
    return true;
  }

  addConnection(chat, platform) {
    this.connected.set(platform, false);
    chat.on('message', (message) => this.engine.handleMessage(message));
    chat.on('status', (status) => {
      this.connected.set(platform, Boolean(status.connected));
      if (status.error) this.error = { key: `error.${status.error}`, platform };
      else if (status.connected) this.error = null;
      this.emit('update');
    });
    this.connections.push({ chat, platform });
  }

  stopConnections() {
    for (const { chat } of this.connections) chat.stop();
    this.connections = [];
    this.connected.clear();
  }

  stop() {
    this.stopConnections();
    this.engine.stop();
    input.releaseAll();
    this.emit('update');
  }

  togglePause() {
    this.engine.setPaused(!this.engine.paused);
    return this.engine.paused;
  }

  get running() {
    return this.connections.length > 0;
  }

  // ---- configuration ------------------------------------------------
  /** Applies profile edits live; the chat connection is never interrupted. */
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
    if (channelChanged && this.running) this.start();

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

  // ---- state ---------------------------------------------------------
  language() {
    return i18n.resolve(this.settings.get().language, this.systemLocale || 'en-US');
  }

  state() {
    const settings = this.settings.get();
    const engineState = this.engine.state();
    const connectedList = [...this.connected.entries()]
      .map(([platform, ok]) => ({ platform, connected: ok }));

    return {
      settings,
      profile: this.profile,
      profiles: this.profiles.list(),
      engine: engineState,
      running: this.running,
      connections: connectedList,
      anyConnected: connectedList.some((c) => c.connected),
      error: this.error,
      overlayError: this.overlayError,
      overlayUrl: this.overlay.url(),
      language: this.language(),
      problems: new CommandSet(this.profile.commands).problems(),
    };
  }

  /** The slimmer payload the OBS overlay polls. */
  overlayState() {
    const dict = i18n.dictionary(this.language());
    const set = new CommandSet(this.profile.commands);
    const holdable = set.commands.find((c) => c.maxHold > 0);

    const strings = {};
    for (const [key, value] of Object.entries(dict)) {
      if (key.startsWith('overlay.')) strings[key] = value;
    }

    return {
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
    this.stop();
    await this.overlay.stop();
  }
}

module.exports = { Runner };
