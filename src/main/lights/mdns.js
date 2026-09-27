'use strict';

const dgram = require('dgram');

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_nanoleafapi._tcp.local';

const TYPE = { A: 1, PTR: 12, SRV: 33 };
// The top bit of the class asks for a unicast answer.
const CLASS_IN_UNICAST = 0x8001;

function encodeName(name) {
  const parts = name.split('.').filter(Boolean).map((label) => {
    const bytes = Buffer.from(label, 'utf8');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** A one-question DNS query. */
function buildQuery(name, type) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(CLASS_IN_UNICAST, 2);
  return Buffer.concat([header, encodeName(name), tail]);
}

/**
 * Reads a possibly compressed name starting at offset. Returns the name and
 * where the record continues. Pointer loops are cut off rather than followed.
 */
function readName(buf, offset) {
  const labels = [];
  let position = offset;
  let resumeAt = -1;
  let hops = 0;

  while (position < buf.length) {
    const length = buf[position];
    if (length === 0) {
      position += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (position + 1 >= buf.length || ++hops > 20) throw new Error('bad name');
      if (resumeAt < 0) resumeAt = position + 2;
      position = ((length & 0x3f) << 8) | buf[position + 1];
      continue;
    }
    if (position + 1 + length > buf.length) throw new Error('bad name');
    labels.push(buf.toString('utf8', position + 1, position + 1 + length));
    position += 1 + length;
  }
  return { name: labels.join('.'), next: resumeAt >= 0 ? resumeAt : position };
}

/**
 * Every answer, authority and additional record in a response, with PTR,
 * SRV and A decoded. Anything malformed ends the parse with what was read.
 */
function parseResponse(buf) {
  const records = [];
  try {
    if (buf.length < 12) return records;
    const questions = buf.readUInt16BE(4);
    const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    let offset = 12;

    for (let i = 0; i < questions; i++) offset = readName(buf, offset).next + 4;

    for (let i = 0; i < total; i++) {
      const { name, next } = readName(buf, offset);
      const type = buf.readUInt16BE(next);
      const length = buf.readUInt16BE(next + 8);
      const start = next + 10;
      if (start + length > buf.length) break;

      const record = { name: name.toLowerCase(), type };
      if (type === TYPE.PTR) record.target = readName(buf, start).name;
      if (type === TYPE.SRV) {
        record.port = buf.readUInt16BE(start + 4);
        record.target = readName(buf, start + 6).name.toLowerCase();
      }
      if (type === TYPE.A && length === 4) record.address = [...buf.subarray(start, start + 4)].join('.');
      records.push(record);
      offset = start + length;
    }
  } catch {
    // Keep whatever came before the damage.
  }
  return records;
}

/** Joins PTR → SRV → A into { name, host, port } for each light. */
function findLights(records) {
  const found = [];
  const instances = records
    .filter((r) => r.type === TYPE.PTR && r.name === SERVICE && r.target)
    .map((r) => r.target);

  for (const instance of new Set(instances)) {
    const srv = records.find((r) => r.type === TYPE.SRV && r.name === instance.toLowerCase());
    if (!srv) continue;
    const a = records.find((r) => r.type === TYPE.A && r.name === srv.target && r.address);
    if (!a) continue;
    const name = instance.slice(0, instance.length - SERVICE.length - 1) || instance;
    if (!found.some((light) => light.host === a.address)) {
      found.push({ name, host: a.address, port: srv.port });
    }
  }
  return found;
}

/**
 * Asks the local network who offers the Nanoleaf API, for a few seconds.
 *
 * The question goes out from an ordinary port rather than 5353, which makes
 * lights answer straight back to us. That avoids fighting Bonjour or a
 * browser for port 5353 on Windows. Resolves to a list, possibly empty;
 * never rejects. group and port exist so tests can aim at a fake responder.
 */
function discover({ timeoutMs = 3000, group = MDNS_GROUP, port = MDNS_PORT } = {}) {
  return new Promise((resolve) => {
    const records = [];
    const askedFor = new Set();
    let socket;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(findLights(records));
    };
    const timer = setTimeout(finish, timeoutMs);

    const ask = (name, type) => {
      try {
        socket.send(buildQuery(name, type), port, group);
      } catch {
        // A machine with no network simply finds nothing.
      }
    };

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      clearTimeout(timer);
      resolve([]);
      return;
    }

    socket.on('error', finish);
    socket.on('message', (message) => {
      records.push(...parseResponse(message));
      // Some lights leave out the address; ask for it separately.
      for (const srv of records.filter((r) => r.type === TYPE.SRV)) {
        const known = records.some((r) => r.type === TYPE.A && r.name === srv.target);
        if (!known && !askedFor.has(srv.target)) {
          askedFor.add(srv.target);
          ask(srv.target, TYPE.A);
        }
      }
    });
    socket.bind(0, () => ask(SERVICE, TYPE.PTR));
  });
}

module.exports = { discover, buildQuery, parseResponse, findLights, encodeName, SERVICE, TYPE };
