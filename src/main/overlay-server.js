'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const OVERLAY_DIR = path.join(__dirname, '..', 'overlay');

// Two independent browser sources, so the streamer can place the command
// list and the poll wherever each one suits her scene.
const PAGES = {
  '/': 'commands.html',
  '/index.html': 'commands.html',
  '/commands': 'commands.html',
  '/poll': 'poll.html',
  '/poll.html': 'poll.html',
};

/**
 * Serves the viewer-facing sign that OBS loads as a browser source.
 *
 * Bound to localhost only: nothing here should be reachable from outside
 * the machine.
 */
class OverlayServer {
  constructor() {
    this.server = null;
    this.port = null;
    this.getState = () => ({});
  }

  /** Resolves to the port in use, or null if the port was taken. */
  start(port, getState) {
    this.getState = getState;
    if (this.server && this.port === port) return Promise.resolve(port);

    return this.stop().then(() => new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handle(req, res));

      server.once('error', () => {
        this.server = null;
        this.port = null;
        resolve(null);
      });

      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.port = port;
        resolve(port);
      });
    }));
  }

  handle(req, res) {
    const url = (req.url || '/').split('?')[0];

    if (url === '/state') {
      const body = Buffer.from(JSON.stringify(this.getState()), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    }

    const page = PAGES[url.replace(/\/+$/, '') || '/'];
    if (page) {
      fs.readFile(path.join(OVERLAY_DIR, page), (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end('overlay missing');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': data.length,
        });
        res.end(data);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      const server = this.server;
      this.server = null;
      this.port = null;
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  url() {
    return this.port ? `http://localhost:${this.port}` : null;
  }
}

module.exports = { OverlayServer };
