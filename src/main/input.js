'use strict';

const koffi = require('koffi');
const { SCANCODES, EXTENDED, MOUSE_BUTTONS } = require('./scancodes');

const user32 = koffi.load('user32.dll');

const SendInput = user32.func('uint32_t SendInput(uint32_t cInputs, void *pInputs, int cbSize)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetWindowTextW = user32.func('int GetWindowTextW(void *hWnd, _Out_ uint16_t *lpString, int nMaxCount)');
const GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(void *hWnd)');
const IsWindowVisible = user32.func('bool IsWindowVisible(void *hWnd)');
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void *hWnd, int64_t lParam)');
const EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc *lpEnumFunc, int64_t lParam)');

const INPUT_KEYBOARD = 1;
const INPUT_MOUSE = 0;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;
const MOUSEEVENTF_MOVE = 0x0001;

/**
 * The Win32 INPUT struct is 40 bytes on x64: a 4-byte type, 4 bytes of
 * padding, then a 32-byte union. Writing the bytes by hand rather than
 * declaring the union to koffi keeps the layout under our control and
 * removes any doubt about how the union is packed.
 */
const INPUT_SIZE = 40;

function keyboardInput(scan, flags) {
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(INPUT_KEYBOARD, 0);
  buf.writeUInt16LE(0, 8); // wVk unused: we send scancodes
  buf.writeUInt16LE(scan, 10);
  buf.writeUInt32LE(flags, 12);
  return buf;
}

function mouseInput(dx, dy, flags) {
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(INPUT_MOUSE, 0);
  buf.writeInt32LE(dx, 8);
  buf.writeInt32LE(dy, 12);
  buf.writeUInt32LE(0, 16); // mouseData
  buf.writeUInt32LE(flags, 20);
  return buf;
}

/** Keys currently held down, so a stuck key can always be released. */
const held = new Set();

function keyDown(name) {
  const scan = SCANCODES[name];
  if (scan === undefined) return false;
  let flags = KEYEVENTF_SCANCODE;
  if (EXTENDED.has(name)) flags |= KEYEVENTF_EXTENDEDKEY;
  SendInput(1, keyboardInput(scan, flags), INPUT_SIZE);
  held.add(name);
  return true;
}

function keyUp(name) {
  const scan = SCANCODES[name];
  if (scan === undefined) return false;
  let flags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;
  if (EXTENDED.has(name)) flags |= KEYEVENTF_EXTENDEDKEY;
  SendInput(1, keyboardInput(scan, flags), INPUT_SIZE);
  held.delete(name);
  return true;
}

function mouseDown(button) {
  const b = MOUSE_BUTTONS[button];
  if (!b) return false;
  SendInput(1, mouseInput(0, 0, b.down), INPUT_SIZE);
  return true;
}

function mouseUp(button) {
  const b = MOUSE_BUTTONS[button];
  if (!b) return false;
  SendInput(1, mouseInput(0, 0, b.up), INPUT_SIZE);
  return true;
}

function mouseMove(dx, dy) {
  SendInput(1, mouseInput(Math.round(dx), Math.round(dy), MOUSEEVENTF_MOVE), INPUT_SIZE);
  return true;
}

/** Release everything we are holding. The panic button depends on this. */
function releaseAll() {
  for (const name of [...held]) keyUp(name);
}

function heldKeys() {
  return [...held];
}

function readWindowText(hwnd) {
  const length = GetWindowTextLengthW(hwnd);
  if (!length) return '';
  const buf = new Uint16Array(length + 1);
  const written = GetWindowTextW(hwnd, buf, length + 1);
  if (written <= 0) return '';
  return Buffer.from(buf.buffer, 0, written * 2).toString('utf16le');
}

function foregroundTitle() {
  const hwnd = GetForegroundWindow();
  if (!hwnd) return '';
  return readWindowText(hwnd);
}

/** Titles of every visible top-level window, for the "only this game" picker. */
function listWindows() {
  const titles = [];
  const seen = new Set();
  const callback = koffi.register((hwnd) => {
    if (IsWindowVisible(hwnd)) {
      const title = readWindowText(hwnd).trim();
      if (title && !seen.has(title)) {
        seen.add(title);
        titles.push(title);
      }
    }
    return true;
  }, koffi.pointer(EnumWindowsProc));

  try {
    EnumWindows(callback, 0);
  } finally {
    koffi.unregister(callback);
  }

  const noise = [
    'Streamthings', 'Program Manager', 'Windows Input Experience',
    'Settings', 'Microsoft Text Input Application', 'NVIDIA GeForce Overlay',
  ];
  return titles.filter((t) => !noise.some((n) => t.toLowerCase() === n.toLowerCase()));
}

module.exports = {
  keyDown, keyUp, mouseDown, mouseUp, mouseMove,
  releaseAll, heldKeys, foregroundTitle, listWindows,
};
