'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

// obs-websocket v5 opcodes. Only the ones this client sends or reads.
const OP = {
  HELLO: 0,
  IDENTIFY: 1,
  IDENTIFIED: 2,
  EVENT: 5,
  REQUEST: 6,
  REQUEST_RESPONSE: 7,
};

// Event subscription bit for the Scenes category, which carries both the
// program scene changing and the scene list itself changing.
const SUBSCRIBE_SCENES = 1 << 2;

// Close codes OBS uses when it turns us away on purpose.
const CLOSE_AUTH_FAILED = 4009;
const CLOSE_UNSUPPORTED_RPC = 4010;

const SCENE_LIST_EVENTS = ['SceneListChanged', 'SceneCreated', 'SceneRemoved', 'SceneNameChanged'];

/**
 * The answer obs-websocket expects to its challenge:
 * base64(sha256(base64(sha256(password + salt)) + challenge)).
 */
function authResponse(password, salt, challenge) {
  const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('base64');
  return sha(sha(String(password) + String(salt)) + String(challenge));
}

/**
 * Scene names in the order OBS shows them. The list arrives bottom-first,
 * with sceneIndex counting from the bottom, so sorting on it descending puts
 * the top scene first.
 */
function sceneNames(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((scene) => scene && typeof scene.sceneName === 'string')
    .map((scene, position) => ({
      name: scene.sceneName,
      index: Number.isFinite(scene.sceneIndex) ? scene.sceneIndex : position,
    }))
    .sort((a, b) => b.index - a.index)
    .map((scene) => scene.name);
}

/**
 * Talks to the websocket server built into OBS 28 and newer.
 *
 * Only listens: it learns the scene list and which scene is on air, and
 * never changes anything in OBS. Like the chat connectors it keeps trying in
 * the background with a growing delay, so OBS can be started before or after
 * the app, or restarted mid-stream, and nothing else has to wait for it.
 */
class ObsClient extends EventEmitter {
  constructor({ host, port, password } = {}, options = {}) {
    super();
    this.host = String(host || '127.0.0.1');
    this.port = Number(port) || 4455;
    this.password = String(password || '');

    this.timeoutMs = options.timeoutMs || 5000;
    this.heartbeatMs = options.heartbeatMs || 10000;
    this.firstRetryMs = options.retryMs || 2000;
    this.maxRetryMs = options.maxRetryMs || 30000;
    this.WebSocket = options.WebSocket || WebSocket;

    this.socket = null;
    this.running = false;
    this.identified = false;
    this.status = 'idle'; // idle | connecting | connected | offline | authFailed | needPassword | unsupported
    this.scenes = [];
    this.current = null;

    this.retryDelay = this.firstRetryMs;
    this.retryTimer = null;
    this.handshakeTimer = null;
    this.heartbeatTimer = null;
    this.awaitingPong = false;
    this.pending = new Map();
    this.nextId = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.setStatus('connecting');
    this.connect();
  }

  /** Skips the wait before the next attempt, for a "try again" button. */
  retryNow() {
    if (!this.running || this.identified) return;
    this.retryDelay = this.firstRetryMs;
    this.connect();
  }

  connect() {
    if (!this.running) return;
    this.cleanupSocket();

    let socket;
    try {
      socket = new this.WebSocket(`ws://${this.host}:${this.port}`, 'obswebsocket.json', {
        handshakeTimeout: this.timeoutMs,
      });
    } catch {
      // A host that cannot even form a URL is as good as OBS being closed.
      this.fail('offline');
      return;
    }
    this.socket = socket;

    // Covers the whole way in: TCP, the upgrade, Hello and Identified.
    this.handshakeTimer = setTimeout(() => this.fail('offline'), this.timeoutMs);

    socket.on('message', (data) => this.handleMessage(data));
    socket.on('pong', () => { this.awaitingPong = false; });
    socket.on('error', () => this.fail('offline'));
    socket.on('close', (code) => {
      if (code === CLOSE_AUTH_FAILED) this.fail('authFailed');
      else if (code === CLOSE_UNSUPPORTED_RPC) this.fail('unsupported');
      else this.fail('offline');
    });
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    const d = message.d || {};

    if (message.op === OP.HELLO) {
      const identify = { rpcVersion: 1, eventSubscriptions: SUBSCRIBE_SCENES };
      if (d.authentication) {
        // OBS would only close on us with a less helpful reason.
        if (!this.password) {
          this.fail('needPassword');
          return;
        }
        identify.authentication = authResponse(this.password, d.authentication.salt, d.authentication.challenge);
      }
      this.send({ op: OP.IDENTIFY, d: identify });
      return;
    }

    if (message.op === OP.IDENTIFIED) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.identified = true;
      this.retryDelay = this.firstRetryMs;
      this.startHeartbeat();
      this.setStatus('connected');
      this.refreshScenes();
      return;
    }

    if (message.op === OP.EVENT) {
      this.handleEvent(d.eventType, d.eventData || {});
      return;
    }

    if (message.op === OP.REQUEST_RESPONSE) {
      const waiting = this.pending.get(d.requestId);
      if (!waiting) return;
      this.pending.delete(d.requestId);
      clearTimeout(waiting.timer);
      if (d.requestStatus && d.requestStatus.result) waiting.resolve(d.responseData || {});
      else waiting.reject(new Error((d.requestStatus && d.requestStatus.comment) || 'requestFailed'));
    }
  }

  handleEvent(type, data) {
    if (type === 'CurrentProgramSceneChanged') {
      this.setCurrent(data.sceneName);
      return;
    }
    if (type === 'SceneListChanged' && Array.isArray(data.scenes)) {
      this.scenes = sceneNames(data.scenes);
      this.emit('change');
      return;
    }
    if (SCENE_LIST_EVENTS.includes(type)) this.refreshScenes();
  }

  /** Fetches the scene list and the scene on air. Never rejects. */
  async refreshScenes() {
    try {
      const list = await this.request('GetSceneList');
      this.scenes = sceneNames(list.scenes);
      this.emit('change');
      this.setCurrent(list.currentProgramSceneName);
    } catch {
      // A dropped connection is already being handled by the socket events.
    }
  }

  /**
   * Only a real change is announced, so reconnecting to OBS on the same
   * scene does not fire the lights again.
   */
  setCurrent(name) {
    if (typeof name !== 'string' || name === this.current) return;
    this.current = name;
    this.emit('scene', name);
    this.emit('change');
  }

  request(requestType, requestData) {
    return new Promise((resolve, reject) => {
      if (!this.identified) {
        reject(new Error('notConnected'));
        return;
      }
      this.nextId += 1;
      const requestId = String(this.nextId);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('timeout'));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ op: OP.REQUEST, d: { requestType, requestId, requestData } });
    });
  }

  send(message) {
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // The close event that follows takes care of it.
    }
  }

  /**
   * OBS closing normally shows up straight away, but a frozen OBS or a
   * pulled cable does not, so the socket is pinged and dropped when silent.
   */
  startHeartbeat() {
    this.awaitingPong = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.awaitingPong) {
        this.fail('offline');
        return;
      }
      this.awaitingPong = true;
      try {
        this.socket.ping();
      } catch {
        this.fail('offline');
      }
    }, this.heartbeatMs);
  }

  fail(reason) {
    if (!this.running) return;
    this.cleanupSocket();
    this.setStatus(reason);
    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryMs);
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.emit('change');
  }

  cleanupSocket() {
    this.identified = false;
    for (const timer of [this.retryTimer, this.handshakeTimer]) clearTimeout(timer);
    clearInterval(this.heartbeatTimer);
    this.retryTimer = null;
    this.handshakeTimer = null;
    this.heartbeatTimer = null;

    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('notConnected'));
    }
    this.pending.clear();

    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.removeAllListeners();
      // ws still reports a late error on a socket we have walked away from.
      socket.on('error', () => {});
      try {
        socket.terminate();
      } catch {
        // Already gone.
      }
    }
  }

  stop() {
    this.running = false;
    this.cleanupSocket();
    this.status = 'idle';
  }

  state() {
    return { status: this.status, scenes: [...this.scenes], current: this.current };
  }
}

module.exports = { ObsClient, authResponse, sceneNames, SUBSCRIBE_SCENES, OP };
