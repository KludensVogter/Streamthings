'use strict';

const tls = require('tls');
const { EventEmitter } = require('events');
const { parseLine, toChatMessage } = require('./irc');

const HOST = 'irc.chat.twitch.tv';
const PORT = 6697;
const PING_TIMEOUT_MS = 330000; // Twitch pings every ~5 min; allow a little slack

/**
 * Reads a Twitch channel's chat anonymously.
 *
 * Twitch lets anyone join as a "justinfan" guest with no token, so the app
 * never touches the streamer's credentials and cannot post. Tags are requested
 * so we can tell who is a moderator.
 */
class TwitchChat extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = String(channel || '').trim().toLowerCase().replace(/^#/, '');
    this.socket = null;
    this.buffer = '';
    this.running = false;
    this.connected = false;
    this.retryDelay = 2000;
    this.retryTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  connect() {
    if (!this.running) return;
    this.cleanupSocket();

    const nick = `justinfan${10000 + Math.floor(Math.random() * 89999)}`;
    const socket = tls.connect({ host: HOST, port: PORT, servername: HOST });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(PING_TIMEOUT_MS);

    socket.on('secureConnect', () => {
      socket.write('CAP REQ :twitch.tv/tags\r\n');
      socket.write(`PASS SCHMOOPIIE\r\nNICK ${nick}\r\n`);
      socket.write(`JOIN #${this.channel}\r\n`);
    });

    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\r\n')) !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        this.handleLine(line);
      }
    });

    socket.on('timeout', () => this.fail('timeout'));
    socket.on('error', (err) => this.fail(err.message));
    socket.on('close', () => this.fail('closed'));
  }

  handleLine(line) {
    if (line.startsWith('PING')) {
      this.socket.write('PONG :tmi.twitch.tv\r\n');
      return;
    }
    const parsed = parseLine(line);
    if (!parsed) return;

    // 366 = end of the names list, i.e. the join actually succeeded.
    if (parsed.command === '366' || parsed.command === 'JOIN') {
      if (!this.connected) {
        this.connected = true;
        this.retryDelay = 2000;
        this.emit('status', { connected: true });
      }
      return;
    }

    if (parsed.command === 'NOTICE' && /improperly formatted|no such channel/i.test(parsed.trailing || '')) {
      this.emit('status', { connected: false, error: 'channelNotFound' });
      return;
    }

    const message = toChatMessage(parsed);
    if (message && message.text) this.emit('message', message);
  }

  fail(reason) {
    if (!this.running) return;
    const wasConnected = this.connected;
    this.connected = false;
    this.cleanupSocket();
    if (wasConnected) this.emit('status', { connected: false, reason });

    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30000);
  }

  cleanupSocket() {
    this.buffer = '';
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  stop() {
    this.running = false;
    this.connected = false;
    this.cleanupSocket();
  }
}

module.exports = { TwitchChat };
