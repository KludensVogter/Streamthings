'use strict';

const { suite, ok, eq, sleep } = require('./helpers');
const input = require('../src/main/input');

// Record input instead of sending it, and pretend a set of keys is held.
const sent = [];
const physicallyDown = new Set();
input.keyDown = (k) => { sent.push(['down', k]); return true; };
input.keyUp = (k) => { sent.push(['up', k]); physicallyDown.delete(k); return true; };
input.mouseDown = (b) => { sent.push(['mdown', b]); return true; };
input.mouseUp = (b) => { sent.push(['mup', b]); physicallyDown.delete(b); return true; };
input.mouseMove = () => true;
input.releaseAll = () => {};
input.foregroundTitle = () => 'Some Game';
input.isKeyDown = (k) => physicallyDown.has(k);
input.isButtonDown = (b) => physicallyDown.has(b);
input.releaseIfDown = (names, buttons) => {
  const released = [];
  for (const name of names || []) {
    if (physicallyDown.has(name)) { input.keyUp(name); released.push(name); }
  }
  for (const button of buttons || []) {
    if (physicallyDown.has(button)) { input.mouseUp(button); released.push(button); }
  }
  return released;
};

const { CommandSet, execute, normaliseCommand } = require('../src/main/commands');
const { defaultProfile } = require('../src/main/profiles');

module.exports = async function run() {
  suite('Hidden commands');
  const set = new CommandSet([
    { id: 'forward', keys: ['w'], info: 'Walk forward' },
    { id: 'selfdestruct', keys: ['k'], info: 'Boom', hidden: true },
    { id: 'jump', keys: ['space'], info: 'Jump' },
  ]);
  eq('all three exist', set.size, 3);
  eq('only two are listed for viewers', set.describe().length, 2);
  ok('the hidden one is left off the overlay',
    !set.describe().some((c) => c.id === 'selfdestruct'));
  ok('but chat can still trigger it', set.parse('selfdestruct') !== null);
  eq('and it resolves to the right command', set.parse('selfdestruct').command.keys, ['k']);
  ok('visible commands are unaffected', set.describe().some((c) => c.id === 'forward'));

  suite('Hold switch');
  const holdOff = new CommandSet([{ id: 'jump', keys: ['space'], duration: 0.2, allowHold: false }]);
  eq('a number is ignored when hold is off', holdOff.parse('jump 3').seconds, null);
  ok('the command still runs', holdOff.parse('jump 3').command.id === 'jump');
  ok('hold is not advertised to viewers', holdOff.describe()[0].holdable === false);

  const holdOn = new CommandSet([
    { id: 'forward', keys: ['w'], duration: 0.4, allowHold: true, maxHold: 3 },
  ]);
  eq('a number is honoured when hold is on', holdOn.parse('forward 2').seconds, 2);
  eq('and capped by its own limit', holdOn.parse('forward 99').seconds, 3);
  ok('hold is advertised to viewers', holdOn.describe()[0].holdable === true);
  eq('a plain command still taps', holdOn.parse('forward').seconds, null);

  suite('Press length and hold limit are separate numbers');
  const command = normaliseCommand({
    id: 'forward', keys: ['w'], duration: 0.4, allowHold: true, maxHold: 3,
  }, 0);
  eq('press length is its own value', command.duration, 0.4);
  eq('hold limit is its own value', command.maxHold, 3);

  sent.length = 0;
  await execute(command, null);
  await sleep(120);
  eq('an ordinary press uses the press length', sent.filter((s) => s[0] === 'down').length, 1);

  const turnedOff = normaliseCommand({
    id: 'forward', keys: ['w'], duration: 0.4, allowHold: false, maxHold: 3,
  }, 0);
  eq('turning hold off clears the limit', turnedOff.maxHold, 0);
  ok('and the press length survives', turnedOff.duration === 0.4);

  suite('Profiles written before the switch existed');
  const legacy = normaliseCommand({ id: 'forward', keys: ['w'], duration: 0.4, maxHold: 3 }, 0);
  ok('a maxHold with no switch means hold was on', legacy.allowHold === true);
  eq('and the limit is kept', legacy.maxHold, 3);

  const legacyTap = normaliseCommand({ id: 'jump', keys: ['space'], duration: 0.1 }, 0);
  ok('a plain command stays a tap', legacyTap.allowHold === false);

  const switchedOnWithoutLimit = normaliseCommand({ id: 'x', keys: ['x'], allowHold: true }, 0);
  ok('switching hold on without a limit gets a sensible one', switchedOnWithoutLimit.maxHold === 3);

  suite('Override releases what you are holding');
  const profile = defaultProfile();
  const all = new CommandSet(profile.commands);
  const context = { overrideKeys: all.allKeys(), overrideButtons: all.allButtons() };
  ok('the profile knows every key it can press', context.overrideKeys.includes('w'));
  ok('and every mouse button', context.overrideButtons.includes('left'));

  // She is holding W to walk forward; chat sends an overriding "back".
  physicallyDown.add('w');
  sent.length = 0;
  const back = normaliseCommand({ id: 'back', keys: ['s'], duration: 0.05, override: true }, 0);
  await execute(back, null, context);
  await sleep(90);
  eq('her key was released first', sent[0], ['up', 'w']);
  eq('then the chat command pressed its own key', sent[1], ['down', 's']);
  ok('and released it again', sent.some((s) => s[0] === 'up' && s[1] === 's'));

  physicallyDown.add('w');
  sent.length = 0;
  const polite = normaliseCommand({ id: 'back', keys: ['s'], duration: 0.05, override: false }, 0);
  await execute(polite, null, context);
  await sleep(90);
  eq('without override her key is left alone', sent[0], ['down', 's']);
  ok('so she keeps holding it', physicallyDown.has('w'));
  physicallyDown.clear();

  physicallyDown.add('left');
  sent.length = 0;
  await execute(normaliseCommand({ id: 'x', keys: ['x'], duration: 0.05, override: true }, 0), null, context);
  await sleep(90);
  eq('a held mouse button is released too', sent[0], ['mup', 'left']);
  physicallyDown.clear();

  suite('Validation of the new switches');
  const broken = new CommandSet([{ id: 'x', keys: ['x'], allowHold: true, maxHold: 0 }]);
  ok('hold on with no limit is repaired rather than reported',
    broken.commands[0].maxHold === 3 && broken.problems().length === 0);
};
