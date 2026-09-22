'use strict';

const { suite, ok, eq, sleep } = require('./helpers');
const input = require('../src/main/input');

const sent = [];
const stamps = [];
input.keyDown = (k) => { sent.push(['down', k]); stamps.push(Date.now()); return true; };
input.keyUp = (k) => { sent.push(['up', k]); return true; };
input.mouseDown = (b) => { sent.push(['mdown', b]); return true; };
input.mouseUp = (b) => { sent.push(['mup', b]); return true; };
input.mouseMove = () => true;
input.releaseAll = () => {};
input.releaseIfDown = () => [];
input.beginOverride = (keys, buttons, ms) => { sent.push(['override', Math.round(ms)]); return true; };
input.foregroundTitle = () => 'Some Game';

const { CommandSet, normaliseCommand, execute } = require('../src/main/commands');

const presses = () => sent.filter((s) => s[0] === 'down').length;

module.exports = async function run() {
  suite('Repeat switch');
  const repeating = normaliseCommand({
    id: 'jump', keys: ['space'], duration: 0.02,
    allowRepeat: true, repeatCount: 4, repeatInterval: 0.05,
  }, 0);
  eq('repeat is on', repeating.allowRepeat, true);
  eq('count is kept', repeating.repeatCount, 4);
  eq('interval is kept', repeating.repeatInterval, 0.05);

  sent.length = 0;
  await execute(repeating, null);
  eq('presses the key the configured number of times', presses(), 4);
  eq('and releases it every time', sent.filter((s) => s[0] === 'up').length, 4);

  sent.length = 0;
  stamps.length = 0;
  await execute(normaliseCommand({
    id: 'jump', keys: ['space'], duration: 0.02,
    allowRepeat: true, repeatCount: 3, repeatInterval: 0.2,
  }, 0), null);
  const gap = stamps[1] - stamps[0];
  ok('waits roughly the interval between presses', gap > 150 && gap < 400, `(${gap}ms)`);

  suite('Chat can ask for fewer');
  const set = new CommandSet([{
    id: 'jump', keys: ['space'], duration: 0.02,
    allowRepeat: true, repeatCount: 6, repeatInterval: 0.02,
  }]);
  eq('a number means times, not seconds', set.parse('jump 3').amount, 3);
  eq('capped by the configured count', set.parse('jump 99').amount, 6);
  eq('a fraction is rounded to whole presses', set.parse('jump 2.6').amount, 3);
  eq('no number runs the full count', set.parse('jump').amount, null);

  sent.length = 0;
  await execute(set.commands[0], 2);
  eq('asking for two presses gives two', presses(), 2);

  sent.length = 0;
  await execute(set.commands[0], null);
  eq('asking for nothing gives the full count', presses(), 6);

  suite('Hold and repeat are either-or');
  const both = normaliseCommand({
    id: 'x', keys: ['x'], allowHold: true, maxHold: 3, allowRepeat: true, repeatCount: 4,
  }, 0);
  eq('repeat wins when a file asks for both', both.allowRepeat, true);
  eq('and hold is turned off', both.allowHold, false);
  eq('so the hold limit is cleared', both.maxHold, 0);

  const holdOnly = normaliseCommand({ id: 'y', keys: ['y'], allowHold: true, maxHold: 2 }, 0);
  eq('a holding command does not repeat', holdOnly.allowRepeat, false);
  eq('and has no repeat count', holdOnly.repeatCount, 0);

  suite('Sensible limits');
  eq('a repeat count below two is raised', normaliseCommand({
    id: 'x', keys: ['x'], allowRepeat: true, repeatCount: 1,
  }, 0).repeatCount, 2);
  eq('a silly count is capped', normaliseCommand({
    id: 'x', keys: ['x'], allowRepeat: true, repeatCount: 5000,
  }, 0).repeatCount, 50);
  eq('a missing interval gets a default', normaliseCommand({
    id: 'x', keys: ['x'], allowRepeat: true,
  }, 0).repeatInterval, 0.25);
  ok('an interval stays workable', normaliseCommand({
    id: 'x', keys: ['x'], allowRepeat: true, repeatInterval: 900,
  }, 0).repeatInterval <= 5);

  // 50 presses a second apart would run for the best part of a minute, so
  // the whole command stays inside the same ceiling a single press has.
  sent.length = 0;
  const marathon = normaliseCommand({
    id: 'x', keys: ['x'], duration: 1, allowRepeat: true, repeatCount: 50, repeatInterval: 5,
  }, 0);
  const started = Date.now();
  const running = execute(marathon, null);
  await sleep(50);
  ok('a marathon is trimmed rather than run in full', presses() <= 5, `(${presses()} so far)`);
  eq('elapsed so far is small', Date.now() - started < 200, true);
  // Let it finish in the background rather than waiting it out.
  running.catch(() => {});

  suite('Overriding a repeating command covers the whole run');
  sent.length = 0;
  await execute(normaliseCommand({
    id: 'x', keys: ['x'], duration: 0.02, override: true,
    allowRepeat: true, repeatCount: 3, repeatInterval: 0.05,
  }, 0), null, { overrideKeys: ['x'], overrideButtons: [] });
  const span = sent.find((s) => s[0] === 'override');
  ok('suppression was asked for', Boolean(span));
  ok('and it spans every press, not just the first',
    span[1] >= 150, `(${span ? span[1] : 0}ms for 3 presses 50ms apart)`);

  suite('Key combinations');
  const combo = normaliseCommand({ id: 'jumpleft', keys: ['space', 'a'], duration: 0.02 }, 0);
  eq('both keys are kept', combo.keys, ['space', 'a']);
  sent.length = 0;
  await execute(combo, null);
  eq('both go down, in order', sent.slice(0, 2), [['down', 'space'], ['down', 'a']]);
  eq('and come up in reverse', sent.slice(2), [['up', 'a'], ['up', 'space']]);

  const modifier = normaliseCommand({ id: 'sprint', keys: ['shift', 'w'], duration: 0.02 }, 0);
  sent.length = 0;
  await execute(modifier, null);
  eq('the modifier is pressed first', sent[0], ['down', 'shift']);
  eq('and released last', sent[sent.length - 1], ['up', 'shift']);

  const comboSet = new CommandSet([{ id: 'jumpleft', keys: ['space', 'a'] }]);
  ok('a combination is one command to chat', comboSet.parse('jumpleft') !== null);
  eq('and both its keys count for the override',
    comboSet.allKeys().sort(), ['a', 'space']);

  const repeatingCombo = normaliseCommand({
    id: 'hopleft', keys: ['space', 'a'], duration: 0.02,
    allowRepeat: true, repeatCount: 3, repeatInterval: 0.02,
  }, 0);
  sent.length = 0;
  await execute(repeatingCombo, null);
  eq('a combination can repeat too', sent.filter((s) => s[0] === 'down' && s[1] === 'space').length, 3);
  eq('with the other key alongside it each time',
    sent.filter((s) => s[0] === 'down' && s[1] === 'a').length, 3);
};
