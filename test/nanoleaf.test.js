'use strict';

const { suite, ok, eq } = require('./helpers');
const { freePort, fakeNanoleaf, silentServer } = require('./fakes');
const { Nanoleaf, pair, parseAddress, hexToHsv } = require('../src/main/lights/nanoleaf');

const FAST = { timeoutMs: 300 };
const FAST_PAIR = { intervalMs: 20, windowMs: 1000, timeoutMs: 200 };

async function failsWith(promise) {
  try {
    await promise;
    return 'no error';
  } catch (err) {
    return err.code;
  }
}

module.exports = async function run() {
  suite('Nanoleaf: reading an address');
  eq('bare IP gets the standard port', parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 16021 });
  eq('explicit port kept', parseAddress(' 10.0.0.9:1234 '), { host: '10.0.0.9', port: 1234 });
  eq('a pasted link works', parseAddress('http://10.0.0.9:16021/api/v1/'), { host: '10.0.0.9', port: 16021 });
  eq('blank is not an address', parseAddress(''), null);
  eq('spaces are not an address', parseAddress('my light'), null);

  suite('Nanoleaf: colours');
  eq('red', hexToHsv('#ff0000'), { hue: 0, sat: 100, value: 100 });
  eq('green', hexToHsv('#00ff00').hue, 120);
  eq('blue', hexToHsv('#0000ff').hue, 240);
  eq('purple, just below the wrap-around', hexToHsv('#ff00cc').hue, 312);
  eq('grey has no saturation', hexToHsv('#808080'), { hue: 0, sat: 0, value: 50 });
  eq('black does not divide by zero', hexToHsv('#000000'), { hue: 0, sat: 0, value: 0 });
  eq('nonsense is no colour', hexToHsv('red'), null);

  suite('Nanoleaf: pairing');
  const light = await fakeNanoleaf({ refusals: 3 });
  const paired = await pair(light.address, FAST_PAIR);
  ok('gets a token once the button has been held', paired.ok === true);
  eq('the token the light handed out', paired.token, 'fakeToken123');
  eq('kept asking through the refusals', light.pairAsks, 4);

  const stubborn = await fakeNanoleaf({ refusals: 1000 });
  const began = Date.now();
  const refused = await pair(stubborn.address, { ...FAST_PAIR, windowMs: 300 });
  eq('gives up when the button is never held', refused.reason, 'timeout');
  ok('when the window closes', Date.now() - began < 800, `${Date.now() - began} ms`);
  await stubborn.close();

  const nobody = await pair(`127.0.0.1:${await freePort()}`, { ...FAST_PAIR, windowMs: 300 });
  eq('nothing at that address says so', nobody.reason, 'offline');
  eq('a nonsense address is refused straight away', (await pair('', FAST_PAIR)).reason, 'badAddress');

  const cancelMe = await fakeNanoleaf({ refusals: 1000 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  const stopEarly = Date.now();
  const cancelled = await pair(cancelMe.address, { ...FAST_PAIR, windowMs: 5000, signal: controller.signal });
  eq('can be cancelled', cancelled.reason, 'cancelled');
  ok('straight away', Date.now() - stopEarly < 500, `${Date.now() - stopEarly} ms`);
  await cancelMe.close();

  suite('Nanoleaf: talking to a paired light');
  const leaf = new Nanoleaf({ address: light.address, token: 'fakeToken123' }, FAST);
  eq('reads the name', (await leaf.info()).name, 'Shapes 5A3B');
  eq('lists the effects', await leaf.effects(), ['Northern Lights', 'Fireplace', 'Snowfall']);

  light.changes.length = 0;
  await leaf.apply({ effect: 'Fireplace', brightness: 40, off: false });
  eq('effect and brightness, in order, switched on first', light.changes, [
    '/state {"on":{"value":true}}',
    '/effects {"select":"Fireplace"}',
    '/state {"brightness":{"value":40}}',
  ]);

  light.changes.length = 0;
  await leaf.apply({ effect: '', brightness: 0, off: false });
  eq('brightness zero is a real value, not "unchanged"', light.changes[1], '/state {"brightness":{"value":0}}');

  light.changes.length = 0;
  await leaf.apply({ effect: 'Fireplace', brightness: 80, off: true });
  eq('off only turns it off', light.changes, ['/state {"on":{"value":false}}']);
  eq('and the light is off', light.state.on, false);

  light.changes.length = 0;
  await leaf.apply({ effect: '', color: '#0000ff', brightness: 30, off: false });
  eq('a single colour is hue then saturation, then brightness', light.changes, [
    '/state {"on":{"value":true}}',
    '/state {"hue":{"value":240}}',
    '/state {"sat":{"value":100}}',
    '/state {"brightness":{"value":30}}',
  ]);

  light.changes.length = 0;
  await leaf.apply({ color: '#800000', brightness: null });
  eq('a dark colour with no brightness chosen comes out dark', light.changes[3], '/state {"brightness":{"value":50}}');

  light.changes.length = 0;
  await leaf.apply({ effect: 'Snowfall', brightness: null, off: false });
  eq('no brightness means brightness is left alone', light.changes.length, 2);

  eq('a vanished effect is reported', await failsWith(leaf.apply({ effect: 'Gone', brightness: null })), 'notFound');

  const stale = new Nanoleaf({ address: light.address, token: 'oldToken' }, FAST);
  eq('a token the light has forgotten', await failsWith(stale.effects()), 'unauthorized');
  eq('no token at all', await failsWith(new Nanoleaf({ address: light.address, token: '' }).effects()), 'unpaired');
  eq('a token that would break the URL is refused',
    await failsWith(new Nanoleaf({ address: light.address, token: '../x' }).effects()), 'unpaired');
  await light.close();

  suite('Nanoleaf: when the light does not answer');
  const gone = new Nanoleaf({ address: `127.0.0.1:${await freePort()}`, token: 'abc' }, FAST);
  const t0 = Date.now();
  eq('switched off at the wall', await failsWith(gone.apply({ effect: 'x', brightness: 10 })), 'offline');
  ok('fails fast', Date.now() - t0 < 300, `${Date.now() - t0} ms`);

  const mute = await silentServer();
  const hung = new Nanoleaf({ address: `127.0.0.1:${mute.port}`, token: 'abc' }, FAST);
  const t1 = Date.now();
  eq('accepts but never replies', await failsWith(hung.apply({ effect: 'x', brightness: 10 })), 'timeout');
  const took = Date.now() - t1;
  ok('gives up after one timeout, not one per step', took < FAST.timeoutMs * 2, `${took} ms`);
  await mute.close();

  const slow = await fakeNanoleaf({ silent: true });
  const quiet = new Nanoleaf({ address: slow.address, token: 'fakeToken123' }, FAST);
  eq('an HTTP server that never finishes', await failsWith(quiet.effects()), 'timeout');
  await slow.close();
};
