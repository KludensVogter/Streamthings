'use strict';

const { EventEmitter } = require('events');
const { ObsClient } = require('./obs');
const { Nanoleaf, pair, parseAddress } = require('./nanoleaf');
const mdns = require('./mdns');
const { cleanLights, cleanScene } = require('../settings');

const PAIR_WINDOW_MS = 30000;

/**
 * Lights that follow the scene on air in OBS.
 *
 * Entirely on the side of everything else: nothing here is awaited by chat,
 * the engine or the interface, every call into the network has a short
 * timeout, and every failure ends up as a status for the Lights page rather
 * than an exception.
 */
class Lights extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.config = cleanLights({});
    this.mapping = new Map();

    this.obs = null;
    this.obsKey = '';

    this.nanoleaf = null;
    this.nanoleafKey = '';
    this.nanoleafStatus = 'unpaired'; // unpaired | checking | ok | offline | timeout | unauthorized
    this.effects = [];

    this.pairing = null; // { host, endsAt, controller }
    this.lastApplied = null; // { scene, ok, error, at }

    this.waiting = null;
    this.busy = false;
  }

  /** Takes cleaned settings.lights and reconnects only what changed. */
  configure(raw) {
    const config = cleanLights(raw);
    this.config = config;
    this.mapping = new Map(config.scenes.map((entry) => [entry.scene, entry]));

    const obsKey = JSON.stringify([config.enabled, config.obsHost, config.obsPort, config.obsPassword]);
    if (obsKey !== this.obsKey) {
      this.obsKey = obsKey;
      this.stopObs();
      if (config.enabled) this.startObs();
    }

    const nanoleafKey = JSON.stringify([config.nanoleafHost, config.nanoleafToken]);
    if (nanoleafKey !== this.nanoleafKey) {
      this.nanoleafKey = nanoleafKey;
      this.effects = [];
      const address = parseAddress(config.nanoleafHost);
      if (address && config.nanoleafToken) {
        this.nanoleaf = new Nanoleaf({ address, token: config.nanoleafToken }, this.options.nanoleaf);
        this.refreshNanoleaf();
      } else {
        this.nanoleaf = null;
        this.nanoleafStatus = 'unpaired';
      }
    }

    this.emit('change');
  }

  // ---- OBS -------------------------------------------------------------
  startObs() {
    const { obsHost, obsPort, obsPassword } = this.config;
    const obs = new ObsClient({ host: obsHost, port: obsPort, password: obsPassword }, this.options.obs);
    obs.on('change', () => this.emit('change'));
    obs.on('scene', (name) => this.onScene(name));
    this.obs = obs;
    obs.start();
  }

  stopObs() {
    if (!this.obs) return;
    this.obs.removeAllListeners();
    this.obs.stop();
    this.obs = null;
  }

  retryObs() {
    if (this.obs) this.obs.retryNow();
  }

  /** A scene nobody set up leaves the lights exactly as they are. */
  onScene(name) {
    const entry = this.mapping.get(name);
    if (!entry || !this.nanoleaf) return;
    this.enqueue(entry).then((result) => {
      if (result.error === 'superseded') return;
      this.lastApplied = { scene: name, ok: result.ok, error: result.error || null, at: Date.now() };
      this.emit('change');
    });
  }

  // ---- Nanoleaf --------------------------------------------------------
  /** Checks the light answers and fetches its effects. Never rejects. */
  async refreshNanoleaf() {
    const light = this.nanoleaf;
    if (!light) return;
    this.nanoleafStatus = 'checking';
    this.emit('change');
    try {
      const info = await light.info();
      const effects = await light.effects();
      if (light !== this.nanoleaf) return;
      if (info.name && !this.config.nanoleafName) this.config.nanoleafName = String(info.name).slice(0, 60);
      this.effects = effects;
      this.nanoleafStatus = 'ok';
    } catch (err) {
      if (light !== this.nanoleaf) return;
      this.nanoleafStatus = err.code || 'offline';
    }
    this.emit('change');
  }

  /**
   * Applies one scene's settings now, for the Test button. Resolves to
   * { ok, error }.
   */
  test(raw) {
    const entry = cleanScene({ scene: 'test', ...(raw || {}) });
    if (!entry) return Promise.resolve({ ok: false, error: 'nothingToDo' });
    if (!this.nanoleaf) return Promise.resolve({ ok: false, error: 'unpaired' });
    return this.enqueue(entry);
  }

  /**
   * Only the newest request matters. Flicking through three scenes quickly
   * sends the light to the last one, not through all three in turn, and one
   * request never overlaps another.
   */
  enqueue(entry) {
    return new Promise((resolve) => {
      if (this.waiting) this.waiting.resolve({ ok: false, error: 'superseded' });
      this.waiting = { entry, resolve };
      this.drain();
    });
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    while (this.waiting) {
      const { entry, resolve } = this.waiting;
      this.waiting = null;
      resolve(await this.send(entry));
    }
    this.busy = false;
  }

  async send(entry) {
    const light = this.nanoleaf;
    if (!light) return { ok: false, error: 'unpaired' };
    try {
      await light.apply(entry);
      if (light === this.nanoleaf && this.nanoleafStatus !== 'ok') {
        this.nanoleafStatus = 'ok';
        if (this.effects.length === 0) this.refreshNanoleaf();
        this.emit('change');
      }
      return { ok: true };
    } catch (err) {
      const code = err.code || 'offline';
      // A missing effect is about this one scene, not the light as a whole.
      if (light === this.nanoleaf && code !== 'notFound') {
        this.nanoleafStatus = code;
        this.emit('change');
      }
      return { ok: false, error: code };
    }
  }

  /**
   * Waits for the streamer to hold the power button. Resolves to
   * { ok, host, token, name } or { ok: false, reason }; saving the token is
   * the caller's job.
   */
  async pair(host) {
    this.cancelPairing();
    const address = parseAddress(host);
    if (!address) return { ok: false, reason: 'badAddress' };

    const controller = new AbortController();
    const windowMs = (this.options.pair && this.options.pair.windowMs) || PAIR_WINDOW_MS;
    const pairing = { host: String(host).trim(), endsAt: Date.now() + windowMs, controller };
    this.pairing = pairing;
    this.emit('change');

    const result = await pair(address, { ...this.options.pair, windowMs, signal: controller.signal });
    if (this.pairing === pairing) this.pairing = null;
    this.emit('change');
    if (!result.ok) return result;

    // The name is only a nicety; a light that pairs and then goes quiet is
    // still paired.
    let name = '';
    try {
      const info = await new Nanoleaf({ address, token: result.token }, this.options.nanoleaf).info();
      name = String(info.name || '').slice(0, 60);
    } catch {
      name = '';
    }
    return { ok: true, host: pairing.host, token: result.token, name };
  }

  cancelPairing() {
    if (!this.pairing) return;
    this.pairing.controller.abort();
    this.pairing = null;
    this.emit('change');
  }

  discover() {
    const find = this.options.discover || mdns.discover;
    return find({ timeoutMs: 3000 }).catch(() => []);
  }

  // ---- state -----------------------------------------------------------
  state() {
    const obs = this.obs ? this.obs.state() : { status: 'disabled', scenes: [], current: null };
    return {
      obs,
      nanoleaf: {
        status: this.nanoleafStatus,
        name: this.config.nanoleafName,
        host: this.config.nanoleafHost,
        effects: [...this.effects],
      },
      pairing: this.pairing ? { host: this.pairing.host, endsAt: this.pairing.endsAt } : null,
      lastApplied: this.lastApplied,
    };
  }

  stop() {
    this.cancelPairing();
    this.stopObs();
    this.obsKey = '';
    if (this.waiting) this.waiting.resolve({ ok: false, error: 'superseded' });
    this.waiting = null;
  }
}

module.exports = { Lights };
