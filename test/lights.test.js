'use strict';

const dgram = require('dgram');
const { suite, ok, eq, sleep } = require('./helpers');
const { until, freePort, fakeObs, fakeNanoleaf } = require('./fakes');
const { Lights } = require('../src/main/lights/lights');
const { cleanLights, cleanScene, clean } = require('../src/main/settings');
const mdns = require('../src/main/lights/mdns');

const OPTIONS = {
  obs: { retryMs: 40, maxRetryMs: 200, timeoutMs: 400, heartbeatMs: 1000 },
  nanoleaf: { timeoutMs: 300 },
  pair: { intervalMs: 20, windowMs: 1000, timeoutMs: 200 },
};

/** A hand-built mDNS answer, using name compression the way real ones do. */
function nanoleafAnswer({ instance = 'Shapes 5A3B', host = 'Shapes-5A3B.local', address = [192, 168, 1, 77], withA = true } = {}) {
  const parts = [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(1, 6); // one answer
  header.writeUInt16BE(withA ? 2 : 1, 10); // SRV (+ A) as additionals
  parts.push(header);

  const serviceAt = 12;
  parts.push(mdns.encodeName(mdns.SERVICE));
  const record = (type, data) => {
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(type, 0);
    fixed.writeUInt16BE(1, 2);
    fixed.writeUInt32BE(120, 4);
    fixed.writeUInt16BE(data.length, 8);
    return Buffer.concat([fixed, data]);
  };
  const pointer = (at) => Buffer.from([0xc0 | (at >> 8), at & 0xff]);
  const label = (text) => Buffer.concat([Buffer.from([Buffer.byteLength(text)]), Buffer.from(text)]);

  // PTR: service -> "<instance>.<service>", the service part compressed.
  const ptrData = Buffer.concat([label(instance), pointer(serviceAt)]);
  parts.push(record(mdns.TYPE.PTR, ptrData));
  const soFar = Buffer.concat(parts).length;
  const instanceAt = soFar - ptrData.length;

  // SRV owner points back at the instance name inside the PTR data.
  const srvData = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x3e, 0x95]), mdns.encodeName(host)]);
  parts.push(pointer(instanceAt), record(mdns.TYPE.SRV, srvData));
  if (withA) parts.push(mdns.encodeName(host), record(mdns.TYPE.A, Buffer.from(address)));
  return Buffer.concat(parts);
}

module.exports = async function run() {
  suite('Lights settings are cleaned, not trusted');
  const cleaned = cleanLights({
    enabled: 'yes',
    obsPort: 99999,
    obsHost: '   ',
    nanoleafToken: 'abc/../../x',
    scenes: [
      { scene: 'Starting', effect: 'Northern Lights', brightness: '140' },
      { scene: 'Starting', effect: 'Duplicate' },
      { scene: 'Nothing set', effect: '', brightness: '' },
      { scene: '', effect: 'no name' },
      { scene: 'BRB', off: true, effect: 'ignored', brightness: 50 },
      'junk',
    ],
  });
  eq('enabled only when it is really true', cleaned.enabled, false);
  eq('bad port falls back to OBS default', cleaned.obsPort, 4455);
  eq('blank host falls back to this computer', cleaned.obsHost, '127.0.0.1');
  eq('a token that could escape the URL is dropped', cleaned.nanoleafToken, '');
  eq('scenes that ask for nothing are dropped', cleaned.scenes.map((s) => s.scene), ['Starting', 'BRB']);
  eq('brightness clamped to 100', cleaned.scenes[0].brightness, 100);
  eq('off wins over everything else', cleaned.scenes[1], { scene: 'BRB', effect: '', brightness: null, off: true });
  const pasted = cleanLights({ obsHost: 'ws://192.168.1.20:4456/', obsPort: 4455 });
  eq('a pasted ws:// address is split into host', pasted.obsHost, '192.168.1.20');
  eq('and port', pasted.obsPort, 4456);
  eq('blank brightness means leave it', cleanScene({ scene: 'x', effect: 'y', brightness: '' }).brightness, null);
  eq('fresh settings have lights off', clean({}).lights.enabled, false);
  eq('and no scenes', clean({}).lights.scenes, []);

  suite('Lights: scenes drive the light');
  const obs = await fakeObs({ scenes: ['Starting', 'Game', 'BRB', 'Ending'], current: 'Game' });
  const light = await fakeNanoleaf();
  const lights = new Lights(OPTIONS);
  lights.configure({
    enabled: true,
    obsPort: obs.port,
    nanoleafHost: light.address,
    nanoleafToken: 'fakeToken123',
    nanoleafName: 'Shapes 5A3B',
    scenes: [
      { scene: 'Starting', effect: 'Northern Lights', brightness: 40 },
      { scene: 'BRB', off: true },
      { scene: 'Ending', brightness: 10 },
    ],
  });

  ok('OBS connects', await until(() => lights.state().obs.status === 'connected'));
  ok('the light answers', await until(() => lights.state().nanoleaf.status === 'ok'));
  eq('its effects are listed', lights.state().nanoleaf.effects, ['Northern Lights', 'Fireplace', 'Snowfall']);
  eq('OBS scenes are listed', lights.state().obs.scenes, ['Starting', 'Game', 'BRB', 'Ending']);
  await sleep(80);
  eq('a scene with nothing set leaves the light alone', light.changes, []);

  obs.switchTo('Starting');
  ok('switching scene changes the light', await until(() => light.changes.length === 3));
  eq('to the chosen effect and brightness', light.changes, [
    '/state {"on":{"value":true}}',
    '/effects {"select":"Northern Lights"}',
    '/state {"brightness":{"value":40}}',
  ]);
  ok('and says so', await until(() => lights.state().lastApplied?.scene === 'Starting'));
  ok('successfully', lights.state().lastApplied.ok === true);

  light.changes.length = 0;
  obs.switchTo('BRB');
  ok('a scene set to off', await until(() => light.changes.length === 1));
  eq('turns it off and nothing more', light.changes, ['/state {"on":{"value":false}}']);

  light.changes.length = 0;
  obs.switchTo('Game');
  await sleep(100);
  eq('an unset scene after that still changes nothing', light.changes, []);

  suite('Lights: quick switching');
  light.delayMs = 60;
  light.changes.length = 0;
  obs.switchTo('Starting');
  await sleep(20);
  obs.switchTo('BRB');
  await sleep(5);
  obs.switchTo('Ending');
  ok('settles', await until(() => lights.state().lastApplied?.scene === 'Ending', 3000));
  await sleep(150);
  ok('the skipped scene was never sent', !light.changes.includes('/state {"on":{"value":false}}'));
  eq('the last scene wins', light.changes[light.changes.length - 1], '/state {"brightness":{"value":10}}');
  eq('the light ends up where the last scene wants it', light.state.brightness, 10);
  light.delayMs = 0;

  suite('Lights: the Test button');
  light.changes.length = 0;
  eq('works without OBS', await lights.test({ effect: 'Snowfall' }), { ok: true });
  eq('sent the effect', light.changes[1], '/effects {"select":"Snowfall"}');
  eq('an empty row has nothing to test', (await lights.test({ effect: '', brightness: null })).error, 'nothingToDo');
  eq('an effect the light lost is reported', (await lights.test({ effect: 'Vanished' })).error, 'notFound');
  eq('without marking the whole light broken', lights.state().nanoleaf.status, 'ok');

  suite('Lights: changing settings reconnects only what changed');
  const sameClient = lights.obs;
  lights.configure({ ...lights.config, scenes: [{ scene: 'Game', effect: 'Fireplace' }] });
  ok('editing scenes keeps the OBS connection', lights.obs === sameClient);
  light.changes.length = 0;
  obs.switchTo('Game');
  ok('and the new mapping is used straight away', await until(() => light.changes.includes('/effects {"select":"Fireplace"}')));

  lights.configure({ ...lights.config, enabled: false });
  eq('turning it off disconnects from OBS', lights.state().obs.status, 'disabled');
  eq('the Test button still works', (await lights.test({ brightness: 55 })).ok, true);

  suite('Lights: when the light is unplugged');
  await light.close();
  lights.configure({ ...lights.config, enabled: true });
  ok('OBS connects on its own', await until(() => lights.state().obs.status === 'connected'));
  const t0 = Date.now();
  const failed = await lights.test({ effect: 'Snowfall' });
  eq('the test says the light is gone', failed.error, 'offline');
  ok('quickly', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  eq('and the status says so', lights.state().nanoleaf.status, 'offline');
  obs.switchTo('Starting');
  obs.switchTo('Game');
  ok('scene switches are still followed', await until(() => lights.state().obs.current === 'Game'));
  ok('and the failure is recorded quietly', await until(() => lights.state().lastApplied?.ok === false, 2000));
  lights.stop();
  await obs.close();

  suite('Lights: pairing from the app');
  const fresh = await fakeNanoleaf({ refusals: 2, name: 'Canvas' });
  const pairing = new Lights(OPTIONS);
  const pending = pairing.pair(fresh.address);
  ok('shows a pairing countdown', pairing.state().pairing?.host === fresh.address);
  const result = await pending;
  eq('pairs', result.ok, true);
  eq('hands back the token', result.token, 'fakeToken123');
  eq('and the light\'s name', result.name, 'Canvas');
  eq('the countdown is gone', pairing.state().pairing, null);

  const cancelling = pairing.pair(`127.0.0.1:${await freePort()}`);
  pairing.cancelPairing();
  eq('can be cancelled', (await cancelling).reason, 'cancelled');
  eq('a blank address is refused', (await pairing.pair('  ')).reason, 'badAddress');
  eq('testing before pairing says so', (await pairing.test({ brightness: 5 })).error, 'unpaired');
  pairing.stop();
  await fresh.close();

  suite('Nanoleaf search on the network');
  const query = mdns.buildQuery(mdns.SERVICE, mdns.TYPE.PTR);
  eq('asks one question', query.readUInt16BE(4), 1);
  eq('for the Nanoleaf service', query.subarray(12, 12 + mdns.encodeName(mdns.SERVICE).length),
    mdns.encodeName(mdns.SERVICE));

  const found = mdns.findLights(mdns.parseResponse(nanoleafAnswer()));
  eq('finds the light, following compressed names', found, [{ name: 'Shapes 5A3B', host: '192.168.1.77', port: 16021 }]);
  const truncated = mdns.parseResponse(nanoleafAnswer().subarray(0, 60));
  ok('a truncated packet is not fatal', Array.isArray(truncated));
  eq('and finds nothing half-read', mdns.findLights(truncated), []);
  eq('garbage finds nothing', mdns.findLights(mdns.parseResponse(Buffer.from('nonsense'))), []);

  // A responder on localhost that answers the way a light does: first
  // without the address, then with it when asked for it separately.
  const responder = dgram.createSocket('udp4');
  const asked = [];
  responder.on('message', (message, from) => {
    // The question's type sits just before its class, at the very end.
    asked.push(message.readUInt16BE(message.length - 4));
    const reply = asked.length === 1 ? nanoleafAnswer({ withA: false }) : nanoleafAnswer();
    responder.send(reply, from.port, from.address);
  });
  await new Promise((resolve) => responder.bind(0, '127.0.0.1', resolve));
  const discovered = await mdns.discover({ timeoutMs: 300, group: '127.0.0.1', port: responder.address().port });
  eq('asks for the service, then for the missing address', asked, [mdns.TYPE.PTR, mdns.TYPE.A]);
  eq('discovers the light end to end', discovered.map((l) => l.host), ['192.168.1.77']);
  responder.close();

  const silent = await mdns.discover({ timeoutMs: 150, group: '127.0.0.1', port: await freePort() });
  eq('nobody answering is an empty list', silent, []);
};
