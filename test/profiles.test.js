'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, ok, eq } = require('./helpers');
const { ProfileStore, defaultProfile, sanitise, slugify } = require('../src/main/profiles');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'streamthings-test-'));
}

module.exports = async function run() {
  suite('Clean install');
  const dir = tempDir();
  const store = new ProfileStore(dir);
  const listed = store.list();
  eq('exactly one profile exists', listed.length, 1);
  eq('and it is the default', listed[0].id, 'default');

  const def = store.load('default');
  const ids = def.commands.map((c) => c.id);
  ok('has WASD', ['forward', 'back', 'left', 'right'].every((k) => ids.includes(k)));
  ok('WASD is bound to w/a/s/d', ['w', 'a', 's', 'd'].every(
    (key) => def.commands.some((c) => c.keys && c.keys.includes(key)),
  ));
  ok('has mouse buttons', def.commands.some((c) => c.type === 'mouse' && c.button === 'left')
    && def.commands.some((c) => c.type === 'mouse' && c.button === 'right'));
  ok('has mouse movement', def.commands.some((c) => c.type === 'move'));
  ok('every command has viewer text', def.commands.every((c) => c.info && c.info.length > 0));

  suite('Creating and copying');
  const made = store.create('My Game');
  eq('id is slugified', made.id, 'my-game');
  eq('name kept as typed', made.name, 'My Game');
  eq('now two profiles', store.list().length, 2);

  const again = store.create('My Game');
  eq('same name gets a unique id', again.id, 'my-game-2');

  const copy = store.duplicate('my-game', 'Copy of mine');
  eq('duplicate has its own id', copy.id, 'copy-of-mine');
  eq('duplicate keeps the commands', copy.commands.length, made.commands.length);

  const renamed = store.rename('my-game', 'Renamed');
  eq('rename changes the name', renamed.name, 'Renamed');
  eq('rename keeps the id stable', renamed.id, 'my-game');

  suite('Deleting');
  eq('delete works', store.remove('my-game-2').ok, true);
  ok('gone from the list', !store.list().some((p) => p.id === 'my-game-2'));
  store.remove('my-game');
  store.remove('copy-of-mine');
  eq('one profile left', store.list().length, 1);
  const refused = store.remove('default');
  eq('refuses to delete the last one', refused.ok, false);
  eq('and says why', refused.reason, 'lastProfile');

  suite('Import and export');
  const exportPath = path.join(dir, 'exported.json');
  eq('export succeeds', store.exportTo('default', exportPath).ok, true);
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  ok('exported file carries no id, so importing cannot clash', exported.id === undefined);
  ok('exported file has the commands', exported.commands.length > 0);

  const imported = store.importFrom(exportPath);
  eq('import succeeds', imported.ok, true);
  ok('import does not overwrite the original', imported.profile.id !== 'default');
  eq('imported commands survive the round trip',
    imported.profile.commands.length, defaultProfile().commands.length);

  const junkPath = path.join(dir, 'junk.json');
  fs.writeFileSync(junkPath, JSON.stringify({ name: 'Nothing', commands: [] }));
  eq('refuses a profile with no commands', store.importFrom(junkPath).ok, false);

  suite('Bad input is repaired, not trusted');
  const fixed = sanitise({
    name: 'x'.repeat(200),
    mode: 'chaos',
    voteSeconds: -5,
    messageRate: 9999,
    maxQueue: 0,
    userCooldown: 'abc',
    commands: [{ id: 'ok', keys: ['w'] }],
  }, 'fallback');
  ok('name is truncated', fixed.name.length === 60);
  eq('unknown mode falls back to anarchy', fixed.mode, 'anarchy');
  ok('voteSeconds clamped up', fixed.voteSeconds >= 2);
  ok('messageRate clamped down', fixed.messageRate <= 10);
  ok('maxQueue clamped up', fixed.maxQueue >= 1);
  eq('bad number falls back', fixed.userCooldown, 0);

  eq('slug of empty name', slugify(''), 'profile');
  eq('slug strips accents', slugify('Højre HåND'), 'hojre-hand');
  eq('slug strips path characters', slugify('../../etc/passwd'), 'etc-passwd');

  suite('Recovery');
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json at all');
  ok('unreadable profile is skipped, not fatal', store.list().every((p) => p.id !== 'broken'));
  const fallback = store.load('does-not-exist');
  eq('missing profile falls back to default', fallback.id, 'default');

  fs.rmSync(dir, { recursive: true, force: true });
};
