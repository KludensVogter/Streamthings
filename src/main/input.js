'use strict';

const koffi = require('koffi');
const { SCANCODES, EXTENDED, MOUSE_BUTTONS } = require('./scancodes');
const hooks = require('./hooks');

const user32 = koffi.load('user32.dll');

const SendInput = user32.func('uint32_t SendInput(uint32_t cInputs, void *pInputs, int cbSize)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetWindowTextW = user32.func('int GetWindowTextW(void *hWnd, _Out_ uint16_t *lpString, int nMaxCount)');
const GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(void *hWnd)');
const IsWindowVisible = user32.func('bool IsWindowVisible(void *hWnd)');
const GetAsyncKeyState = user32.func('int16_t GetAsyncKeyState(int vKey)');
const MapVirtualKeyW = user32.func('uint32_t MapVirtualKeyW(uint32_t uCode, uint32_t uMapType)');
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

const MAPVK_VSC_TO_VK_EX = 3;
const KEY_IS_DOWN = 0x8000;
const MOUSE_VIRTUAL_KEYS = { left: 0x01, right: 0x02, middle: 0x04 };

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

/**
 * The virtual-key code Windows reports for one of our scancodes.
 *
 * We send scancodes, but asking whether a key is currently down is a
 * virtual-key question, so the two have to be bridged through the active
 * keyboard layout.
 */
function virtualKeyFor(name) {
  const scan = SCANCODES[name];
  if (scan === undefined) return 0;
  const code = EXTENDED.has(name) ? (0xe000 | scan) : scan;
  return MapVirtualKeyW(code, MAPVK_VSC_TO_VK_EX);
}

function isKeyDown(name) {
  const vk = virtualKeyFor(name);
  return vk !== 0 && (GetAsyncKeyState(vk) & KEY_IS_DOWN) !== 0;
}

function isButtonDown(button) {
  const vk = MOUSE_VIRTUAL_KEYS[button];
  return vk !== undefined && (GetAsyncKeyState(vk) & KEY_IS_DOWN) !== 0;
}

/**
 * Lets go of anything in `names` that is currently held, whoever is holding
 * it. Windows does not distinguish a physical press from an injected one, so
 * a key up sent here releases the streamer's own finger as far as the game is
 * concerned. That is what lets a chat command win an argument with her.
 */
function releaseIfDown(names, buttons) {
  const released = [];
  for (const name of names || []) {
    if (isKeyDown(name)) {
      keyUp(name);
      released.push(name);
    }
  }
  for (const button of buttons || []) {
    if (isButtonDown(button)) {
      mouseUp(button);
      released.push(button);
    }
  }
  return released;
}

/**
 * Full override: let go of what is held, then stop the streamer's own
 * presses of those keys from reaching anything for the length of the
 * command. Only does anything while the hooks are installed.
 */
function beginOverride(keyNames, buttons, milliseconds) {
  const virtualKeys = (keyNames || []).map(virtualKeyFor).filter(Boolean);
  return hooks.suppress(virtualKeys, buttons, milliseconds);
}

function enableOverrideHooks(enabled) {
  return enabled ? hooks.install() : (hooks.uninstall(), false);
}

function setPanicKeyName(name) {
  hooks.setPanicKey(virtualKeyFor(name));
}

module.exports = {
  keyDown, keyUp, mouseDown, mouseUp, mouseMove,
  releaseAll, heldKeys, foregroundTitle, listWindows,
  virtualKeyFor, isKeyDown, isButtonDown, releaseIfDown,
  beginOverride, enableOverrideHooks, setPanicKeyName,
  releaseOverride: hooks.release, overrideStatus: hooks.status,
};
