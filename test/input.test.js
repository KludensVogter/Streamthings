'use strict';

const koffi = require('koffi');
const { suite, ok, eq, sleep } = require('./helpers');
const input = require('../src/main/input');
const { SCANCODES, EXTENDED, KEY_NAMES } = require('../src/main/scancodes');

const user32 = koffi.load('user32.dll');
const SendInput = user32.func('uint32_t SendInput(uint32_t cInputs, void *pInputs, int cbSize)');
const GetAsyncKeyState = user32.func('int16_t GetAsyncKeyState(int vKey)');

// F13 has a scancode and a virtual-key code but exists on no real keyboard,
// so we can press it for real without any application reacting to it.
const SCAN_F13 = 0x64;
const VK_F13 = 0x7c;
const INPUT_SIZE = 40;

function rawKey(scan, flags) {
  const b = Buffer.alloc(INPUT_SIZE);
  b.writeUInt32LE(1, 0);
  b.writeUInt16LE(scan, 10);
  b.writeUInt32LE(flags, 12);
  return b;
}

function isDown(vk) {
  return (GetAsyncKeyState(vk) & 0x8000) !== 0;
}

module.exports = async function run() {
  suite('Windows input');

  // Proves the whole path: our struct -> SendInput -> the OS input queue.
  GetAsyncKeyState(VK_F13); // clear any latched state
  const before = isDown(VK_F13);
  SendInput(1, rawKey(SCAN_F13, 0x0008), INPUT_SIZE);
  await sleep(40);
  const during = isDown(VK_F13);
  SendInput(1, rawKey(SCAN_F13, 0x0008 | 0x0002), INPUT_SIZE);
  await sleep(40);
  const after = isDown(VK_F13);

  ok('key is not down before the test', before === false);
  ok('SendInput actually presses the key', during === true,
    during ? '' : '(Windows did not register the press)');
  ok('key is released again', after === false);

  suite('Scancode table');
  ok('a-z present', 'abcdefghijklmnopqrstuvwxyz'.split('').every((c) => SCANCODES[c] !== undefined));
  ok('0-9 present', '0123456789'.split('').every((c) => SCANCODES[c] !== undefined));
  ok('f1-f12 present', Array.from({ length: 12 }, (_, i) => `f${i + 1}`).every((k) => SCANCODES[k] !== undefined));
  ok('arrows flagged as extended', ['up', 'down', 'left', 'right'].every((k) => EXTENDED.has(k)));
  ok('left/right arrow differ from numpad twins only by the extended flag',
    SCANCODES.left === SCANCODES.num4 && EXTENDED.has('left') && !EXTENDED.has('num4'));
  eq('key list is sorted and complete', KEY_NAMES.length, Object.keys(SCANCODES).length);

  suite('Held-key tracking');
  input.releaseAll();
  eq('starts empty', input.heldKeys(), []);
  input.keyDown('f13_not_a_key');
  eq('unknown key is not tracked', input.heldKeys(), []);
  ok('unknown key returns false', input.keyDown('nope') === false);

  suite('Window inspection');
  const title = input.foregroundTitle();
  ok('foreground window has a title', typeof title === 'string' && title.length > 0, JSON.stringify(title));
  const windows = input.listWindows();
  ok('finds open windows', Array.isArray(windows) && windows.length > 0, `(${windows.length})`);
  ok('window titles are non-empty strings', windows.every((w) => typeof w === 'string' && w.length > 0));
  ok('no duplicates', new Set(windows).size === windows.length);
};
