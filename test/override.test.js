'use strict';

const { suite, ok, eq, sleep } = require('./helpers');
const hooks = require('../src/main/hooks');
const input = require('../src/main/input');

const VK_W = 0x57;
const VK_A = 0x41;
const VK_F8 = 0x77;
const VK_F13 = 0x7c;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;
const PHYSICAL = 0;
const INJECTED = hooks.LLKHF_INJECTED;

module.exports = async function run() {
  suite('Override hooks install and come off again');
  hooks.uninstall();
  eq('nothing is hooked to begin with', hooks.status().installed, false);
  ok('installing works', hooks.install() === true);
  eq('and reports itself', hooks.status().installed, true);
  ok('installing twice is harmless', hooks.install() === true);
  hooks.uninstall();
  eq('uninstalling works', hooks.status().installed, false);
  ok('uninstalling twice is harmless', (hooks.uninstall(), true));

  suite('Nothing is suppressed unless a command asked for it');
  hooks.install();
  hooks.setPanicKey(VK_F8);
  hooks.release();
  eq('idle by default', hooks.status().suppressing, false);
  ok('a key passes while idle', hooks.shouldSuppressKey(VK_W, PHYSICAL) === false);
  ok('suppress does nothing with no time', hooks.suppress([VK_W], [], 0) === false);

  suite('While a command is overriding');
  hooks.suppress([VK_W, VK_A], ['left'], 5000);
  eq('it is suppressing', hooks.status().suppressing, true);
  ok('a listed key is swallowed', hooks.shouldSuppressKey(VK_W, PHYSICAL) === true);
  ok('so is the other one', hooks.shouldSuppressKey(VK_A, PHYSICAL) === true);
  ok('an unlisted key still gets through', hooks.shouldSuppressKey(VK_F13, PHYSICAL) === false);

  suite('The guards that keep this safe');
  ok('our own injected presses are never swallowed',
    hooks.shouldSuppressKey(VK_W, INJECTED) === false);
  ok('the panic key is never swallowed',
    hooks.shouldSuppressKey(VK_F8, PHYSICAL) === false);
  hooks.suppress([VK_W, VK_F8], [], 5000);
  ok('and cannot be suppressed even when asked for explicitly',
    hooks.shouldSuppressKey(VK_F8, PHYSICAL) === false);
  ok('while its neighbours still are', hooks.shouldSuppressKey(VK_W, PHYSICAL) === true);

  suite('Mouse buttons');
  hooks.suppress([], ['left'], 5000);
  ok('a listed button down is swallowed',
    hooks.shouldSuppressMouse(WM_LBUTTONDOWN, PHYSICAL) === true);
  ok('and its matching up, so it cannot stick',
    hooks.shouldSuppressMouse(WM_LBUTTONUP, PHYSICAL) === true);
  ok('an unlisted button gets through',
    hooks.shouldSuppressMouse(WM_RBUTTONDOWN, PHYSICAL) === false);
  ok('injected clicks get through',
    hooks.shouldSuppressMouse(WM_LBUTTONDOWN, hooks.LLMHF_INJECTED) === false);

  suite('Overlapping commands extend rather than cut short');
  hooks.release();
  hooks.suppress([VK_W], [], 5000);
  hooks.suppress([VK_A], [], 200);
  await sleep(320);
  ok('a shorter second command does not end the first one early',
    hooks.status().suppressing === true);

  suite('Suppression always ends by itself');
  hooks.release();
  hooks.suppress([VK_W], [], 300);
  ok('suppressing now', hooks.shouldSuppressKey(VK_W, PHYSICAL) === true);
  await sleep(420);
  ok('the window closed on its own', hooks.shouldSuppressKey(VK_W, PHYSICAL) === false);
  eq('and the status agrees', hooks.status().suppressing, false);

  hooks.suppress([VK_W], [], 10 * 60 * 1000);
  const stretched = hooks.status();
  ok('a silly long request is capped rather than honoured', stretched.suppressing === true);
  hooks.release();
  ok('release hands control straight back',
    hooks.shouldSuppressKey(VK_W, PHYSICAL) === false);

  suite('Panic and shutdown let go');
  hooks.suppress([VK_W], [], 5000);
  ok('suppressing before the panic key', hooks.shouldSuppressKey(VK_W, PHYSICAL) === true);
  hooks.release();
  ok('panic clears it', hooks.shouldSuppressKey(VK_W, PHYSICAL) === false);

  hooks.suppress([VK_W], [], 5000);
  hooks.uninstall();
  eq('uninstalling clears suppression too', hooks.status().suppressing, false);
  ok('and a later request cannot re-arm it', input.beginOverride(['w'], [], 500) === false);

  suite('Key names reach the hook as virtual keys');
  hooks.install();
  hooks.setPanicKey(0);
  input.beginOverride(['w', 'a'], ['left'], 2000);
  ok('the name "w" arrived as its virtual key',
    hooks.shouldSuppressKey(VK_W, PHYSICAL) === true);
  ok('and "a" as its own', hooks.shouldSuppressKey(VK_A, PHYSICAL) === true);
  hooks.release();
  hooks.uninstall();
};
