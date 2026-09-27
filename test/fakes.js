'use strict';

const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { WebSocketServer } = require('ws');
const { sleep } = require('./helpers');

/** Waits until check() is true, or gives up after ms. Returns the last result. */
async function until(check, ms = 2000) {
  const endsAt = Date.now() + ms;
  while (Date.now() < endsAt) {
    if (check()) return true;
    await sleep(10);
  }
  return Boolean(check());
}

/** A port nothing is listening on, found by briefly borrowing one. */
function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Stands in for OBS's websocket server, written from the protocol docs
 * rather than from the client, so a shared misunderstanding shows up.
 * scenes are given top-first, as OBS shows them.
 */
async function fakeObs({ port = 0, password = '', scenes = ['Game'], current } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise((resolve) => wss.once('listening', resolve));

  const obs = {
    port: wss.address().port,
    scenes: [...scenes],
    current: current || scenes[0],
    identifies: [],
    requests: [],
    connections: 0,
    sockets: new Set(),

    switchTo(name) {
      obs.current = name;
      obs.broadcast({
        op: 5,
        d: { eventType: 'CurrentProgramSceneChanged', eventIntent: 4, eventData: { sceneName: name } },
      });
    },

    renameList(next) {
      obs.scenes = [...next];
      obs.broadcast({
        op: 5,
        d: { eventType: 'SceneListChanged', eventIntent: 4, eventData: { scenes: obs.sceneList() } },
      });
    },

    // Bottom-first, with sceneIndex counting from the bottom, as OBS does.
    sceneList() {
      const n = obs.scenes.length;
      return obs.scenes
        .map((sceneName, i) => ({ sceneName, sceneIndex: n - 1 - i, sceneUuid: `uuid-${i}` }))
        .reverse();
    },

    broadcast(message) {
      for (const socket of obs.sockets) socket.send(JSON.stringify(message));
    },

    // Stops reading from every client, so pings go unanswered, the way a
    // hung OBS behaves.
    freeze() {
      for (const socket of obs.sockets) socket._socket.pause();
    },

    dropEveryone() {
      for (const socket of obs.sockets) socket.terminate();
    },

    close() {
      obs.dropEveryone();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on('connection', (socket) => {
    obs.connections += 1;
    obs.sockets.add(socket);
    socket.on('close', () => obs.sockets.delete(socket));

    const salt = crypto.randomBytes(16).toString('base64');
    const challenge = crypto.randomBytes(16).toString('base64');
    const hello = { obsWebSocketVersion: '5.5.0', rpcVersion: 1 };
    if (password) hello.authentication = { salt, challenge };
    socket.send(JSON.stringify({ op: 0, d: hello }));

    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.op === 1) {
        obs.identifies.push(message.d);
        if (password) {
          const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
          const expected = crypto.createHash('sha256').update(secret + challenge).digest('base64');
          if (message.d.authentication !== expected) {
            socket.close(4009, 'Authentication failed.');
            return;
          }
        }
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (message.op === 6) {
        obs.requests.push(message.d.requestType);
        const reply = {
          requestType: message.d.requestType,
          requestId: message.d.requestId,
          requestStatus: { result: true, code: 100 },
        };
        if (message.d.requestType === 'GetSceneList') {
          reply.responseData = {
            currentProgramSceneName: obs.current,
            currentPreviewSceneName: null,
            scenes: obs.sceneList(),
          };
        } else {
          reply.requestStatus = { result: false, code: 204, comment: 'Unknown request type.' };
        }
        socket.send(JSON.stringify({ op: 7, d: reply }));
      }
    });
  });

  return obs;
}

/**
 * Stands in for a Nanoleaf controller's Open API. The light refuses to pair
 * until it has been asked refusals times, like someone still holding the
 * button, and can be made slow or silent.
 */
async function fakeNanoleaf({
  token = 'fakeToken123', effects = ['Northern Lights', 'Fireplace', 'Snowfall'],
  name = 'Shapes 5A3B', refusals = 0, delayMs = 0, silent = false,
} = {}) {
  const light = {
    port: 0,
    requests: [],
    changes: [], // only the PUTs, as "path body"
    pairAsks: 0,
    state: { on: false, brightness: 100, effect: effects[0] },
    delayMs,
    silent,
    close: null,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : null;
      light.requests.push({ method: req.method, url: req.url, body });
      if (light.silent) return;
      if (light.delayMs) await sleep(light.delayMs);

      const reply = (status, payload) => {
        const out = payload === undefined ? '' : JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(out);
      };

      if (req.method === 'POST' && req.url === '/api/v1/new') {
        light.pairAsks += 1;
        if (light.pairAsks <= refusals) reply(403);
        else reply(200, { auth_token: token });
        return;
      }

      const prefix = `/api/v1/${token}`;
      if (!req.url.startsWith(prefix)) {
        reply(401);
        return;
      }
      const path = req.url.slice(prefix.length) || '/';

      if (req.method === 'GET' && path === '/') {
        reply(200, { name, model: 'NL42', firmwareVersion: '9.0.0', state: light.state });
        return;
      }
      if (req.method === 'GET' && path === '/effects/effectsList') {
        reply(200, effects);
        return;
      }
      if (req.method === 'PUT' && (path === '/state' || path === '/effects')) {
        if (path === '/effects' && !effects.includes(body.select)) {
          reply(404);
          return;
        }
        light.changes.push(`${path} ${JSON.stringify(body)}`);
        if (body.on) light.state.on = body.on.value;
        if (body.brightness) light.state.brightness = body.brightness.value;
        if (body.select) light.state.effect = body.select;
        reply(204);
        return;
      }
      reply(404);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  light.port = server.address().port;
  light.address = `127.0.0.1:${light.port}`;
  light.close = () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return light;
}

/** A TCP port that accepts connections and then never says a word. */
async function silentServer() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

module.exports = { until, freePort, fakeObs, fakeNanoleaf, silentServer };
