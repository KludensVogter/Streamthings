'use strict';

const http = require('http');

const DEFAULT_PORT = 16021;
const TOKEN_PATTERN = /^[A-Za-z0-9]{1,64}$/;

/** An error with a short code the interface can translate. */
function failure(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

/**
 * Reads "192.168.1.50", "192.168.1.50:16021" or a pasted http:// link into
 * a host and port. Returns null for anything that is not an address.
 */
function parseAddress(text) {
  const raw = String(text || '').trim().replace(/^https?:\/\//i, '').split('/')[0];
  if (!raw || /\s/.test(raw)) return null;
  try {
    const url = new URL(`http://${raw}`);
    if (!url.hostname) return null;
    return { host: url.hostname, port: Number(url.port) || DEFAULT_PORT };
  } catch {
    return null;
  }
}

/**
 * One HTTP call with a hard limit on the whole exchange, not just on idle
 * time, so a light that accepts the connection and then says nothing still
 * gives up on schedule. Resolves to { status, body } and rejects only with
 * 'offline' or 'timeout'.
 */
function call(address, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const req = http.request({
      host: address.host,
      port: address.port,
      method,
      path,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', () => settle(reject, failure('offline')));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        settle(resolve, { status: res.statusCode, body: parsed });
      });
    });

    const timer = setTimeout(() => {
      settle(reject, failure('timeout'));
      req.destroy();
    }, timeoutMs);

    req.on('error', () => settle(reject, failure('offline')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Turns an HTTP status into the same short codes, or passes the body on. */
function expectOk(response) {
  if (response.status >= 200 && response.status < 300) return response.body;
  if (response.status === 401 || response.status === 403) throw failure('unauthorized');
  if (response.status === 404) throw failure('notFound');
  throw failure('badResponse');
}

/**
 * Nanoleaf's local Open API: http://<ip>:16021/api/v1/<token>/...
 *
 * Every method either resolves or rejects with one of the short codes
 * above within a few seconds, so nothing waiting on the light waits long.
 */
class Nanoleaf {
  constructor({ address, token }, options = {}) {
    this.address = typeof address === 'string' ? parseAddress(address) : address;
    this.token = TOKEN_PATTERN.test(String(token || '')) ? String(token) : '';
    this.timeoutMs = options.timeoutMs || 3000;
  }

  async send(method, path, body) {
    if (!this.address || !this.token) throw failure('unpaired');
    const response = await call(this.address, method, `/api/v1/${this.token}${path}`, body, this.timeoutMs);
    return expectOk(response);
  }

  /** Name, model, firmware and the current state. */
  async info() {
    const body = await this.send('GET', '/');
    return body && typeof body === 'object' ? body : {};
  }

  async effects() {
    const list = await this.send('GET', '/effects/effectsList');
    return Array.isArray(list) ? list.filter((name) => typeof name === 'string') : [];
  }

  selectEffect(name) {
    return this.send('PUT', '/effects', { select: String(name) });
  }

  setOn(on) {
    return this.send('PUT', '/state', { on: { value: Boolean(on) } });
  }

  setBrightness(value) {
    return this.send('PUT', '/state', { brightness: { value: Math.round(value) } });
  }

  /**
   * Carries out one scene's wish: { effect?, brightness?, off? }.
   * The steps run one at a time and the first failure stops the rest, so an
   * unreachable light costs one timeout, not three.
   */
  async apply({ effect, brightness, off }) {
    if (off) {
      await this.setOn(false);
      return;
    }
    await this.setOn(true);
    if (effect) await this.selectEffect(effect);
    if (brightness !== null && brightness !== undefined) await this.setBrightness(brightness);
  }
}

/**
 * Asks the light for a token. It only hands one out for about 30 seconds
 * after its power button is held for 5–7 seconds, so this keeps asking until
 * it says yes or the window runs out.
 *
 * Resolves to { ok: true, token } or { ok: false, reason } where reason is
 * 'badAddress', 'offline' (never answered at all), 'timeout' (answered, but
 * was never put in pairing mode) or 'cancelled'. Never rejects.
 */
async function pair(addressText, options = {}) {
  const address = typeof addressText === 'string' ? parseAddress(addressText) : addressText;
  if (!address) return { ok: false, reason: 'badAddress' };

  const windowMs = options.windowMs || 30000;
  const intervalMs = options.intervalMs || 2000;
  const timeoutMs = options.timeoutMs || 3000;
  const signal = options.signal;
  const endsAt = Date.now() + windowMs;
  let everAnswered = false;

  while (Date.now() < endsAt) {
    if (signal && signal.aborted) return { ok: false, reason: 'cancelled' };
    try {
      const response = await call(address, 'POST', '/api/v1/new', undefined, timeoutMs);
      everAnswered = true;
      const token = response.body && response.body.auth_token;
      if (response.status >= 200 && response.status < 300 && TOKEN_PATTERN.test(String(token || ''))) {
        return { ok: true, token: String(token) };
      }
      // 403 is the light saying it is not in pairing mode yet.
    } catch {
      // Not answering yet is expected while the button is being held.
    }
    await wait(Math.min(intervalMs, Math.max(0, endsAt - Date.now())), signal);
  }

  if (signal && signal.aborted) return { ok: false, reason: 'cancelled' };
  return { ok: false, reason: everAnswered ? 'timeout' : 'offline' };
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

module.exports = { Nanoleaf, pair, parseAddress, DEFAULT_PORT, TOKEN_PATTERN };
