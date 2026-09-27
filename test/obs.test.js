'use strict';

const crypto = require('crypto');
const { suite, ok, eq, sleep } = require('./helpers');
const { until, freePort, fakeObs, silentServer } = require('./fakes');
const { ObsClient, authResponse, sceneNames, SUBSCRIBE_SCENES } = require('../src/main/lights/obs');

// Short enough that the whole suite takes a couple of seconds.
const FAST = { retryMs: 40, maxRetryMs: 200, timeoutMs: 400, heartbeatMs: 150 };

function client(port, password) {
  const obs = new ObsClient({ host: '127.0.0.1', port, password }, FAST);
  const seen = [];
  obs.on('scene', (name) => seen.push(name));
  return { obs, seen };
}

module.exports = async function run() {
  suite('OBS: scene order and auth');
  eq('scenes come out top-first', sceneNames([
    { sceneName: 'Bottom', sceneIndex: 0 },
    { sceneName: 'Middle', sceneIndex: 1 },
    { sceneName: 'Top', sceneIndex: 2 },
  ]), ['Top', 'Middle', 'Bottom']);
  eq('junk in the list is skipped', sceneNames([null, { sceneName: 3 }, { sceneName: 'Ok', sceneIndex: 0 }]), ['Ok']);
  eq('no list is an empty list', sceneNames(undefined), []);

  const sha = (text) => crypto.createHash('sha256').update(text).digest('base64');
  eq('auth string follows the documented recipe',
    authResponse('pw', 'salt', 'chal'), sha(sha('pwsalt') + 'chal'));

  suite('OBS: connecting without a password');
  const server = await fakeObs({ scenes: ['Starting', 'Game', 'BRB'], current: 'Game' });
  const { obs, seen } = client(server.port, '');
  obs.start();
  ok('connects', await until(() => obs.status === 'connected'));
  ok('asks for scene events', (server.identifies[0].eventSubscriptions & SUBSCRIBE_SCENES) !== 0);
  eq('sends no password when none is needed', server.identifies[0].authentication, undefined);
  ok('reads the scene list', await until(() => obs.scenes.length === 3));
  eq('in the order OBS shows them', obs.scenes, ['Starting', 'Game', 'BRB']);
  eq('knows what is on air', obs.current, 'Game');
  eq('announces the scene it found on air', seen, ['Game']);

  suite('OBS: following scene changes');
  server.switchTo('BRB');
  ok('hears the switch', await until(() => seen.length === 2));
  eq('with the right name', seen[1], 'BRB');
  eq('and remembers it', obs.current, 'BRB');

  server.renameList(['Starting', 'Game', 'BRB', 'Ending']);
  ok('picks up a changed scene list', await until(() => obs.scenes.length === 4));
  eq('new scene included', obs.scenes[3], 'Ending');

  suite('OBS: losing and finding OBS again');
  server.dropEveryone();
  ok('notices the drop', await until(() => obs.status === 'offline'));
  ok('reconnects by itself', await until(() => obs.status === 'connected'));
  await sleep(80);
  eq('same scene on reconnect does not fire again', seen.length, 2);

  server.dropEveryone();
  await until(() => obs.status === 'offline');
  server.current = 'Starting';
  ok('back again', await until(() => obs.status === 'connected'));
  ok('a scene changed while away is announced', await until(() => seen[seen.length - 1] === 'Starting'));

  server.freeze();
  ok('a frozen OBS is noticed by the heartbeat', await until(() => obs.status === 'offline', 1500));
  obs.stop();
  await server.close();

  suite('OBS: passwords');
  const locked = await fakeObs({ password: 'hunter2', scenes: ['Only'] });
  const right = client(locked.port, 'hunter2');
  right.obs.start();
  ok('the right password gets in', await until(() => right.obs.status === 'connected'));
  right.obs.stop();

  const wrong = client(locked.port, 'nope');
  wrong.obs.start();
  ok('a wrong password is reported as such', await until(() => wrong.obs.status === 'authFailed'));
  wrong.obs.stop();

  const none = client(locked.port, '');
  none.obs.start();
  ok('a missing password is reported as such', await until(() => none.obs.status === 'needPassword'));
  none.obs.stop();
  await locked.close();

  suite('OBS: when OBS is not there');
  const port = await freePort();
  const early = client(port, '');
  early.obs.start();
  ok('closed OBS shows as offline, quietly', await until(() => early.obs.status === 'offline'));
  const late = await fakeObs({ port, scenes: ['Late'] });
  ok('connects once OBS is started', await until(() => early.obs.status === 'connected', 3000));
  early.obs.stop();
  await late.close();

  const mute = await silentServer();
  const hung = client(mute.port, '');
  const began = Date.now();
  hung.obs.start();
  ok('a port that never answers gives up', await until(() => hung.obs.status === 'offline', 2000));
  ok('within the timeout', Date.now() - began < FAST.timeoutMs + 500, `${Date.now() - began} ms`);
  hung.obs.stop();
  await mute.close();

  suite('OBS: stopping');
  const stopPort = await freePort();
  const stopped = client(stopPort, '');
  stopped.obs.start();
  await until(() => stopped.obs.status === 'offline');
  stopped.obs.stop();
  const after = await fakeObs({ port: stopPort });
  await sleep(300);
  eq('no attempts after stop', after.connections, 0);
  await after.close();

  const bad = new ObsClient({ host: 'not a host', port: 1 }, FAST);
  bad.start();
  ok('a nonsense host does not throw', await until(() => bad.status === 'offline'));
  bad.stop();
};
