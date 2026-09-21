'use strict';

/**
 * DirectInput scancodes.
 *
 * Games built on DirectX read scancodes straight from the keyboard driver and
 * ignore the virtual-key codes that most automation libraries send. Injecting
 * scancodes is what makes chat input actually register in a game rather than
 * only in menus and text fields.
 */
const SCANCODES = {
  esc: 0x01,
  1: 0x02, 2: 0x03, 3: 0x04, 4: 0x05, 5: 0x06,
  6: 0x07, 7: 0x08, 8: 0x09, 9: 0x0a, 0: 0x0b,
  '-': 0x0c, '=': 0x0d, backspace: 0x0e, tab: 0x0f,
  q: 0x10, w: 0x11, e: 0x12, r: 0x13, t: 0x14,
  y: 0x15, u: 0x16, i: 0x17, o: 0x18, p: 0x19,
  '[': 0x1a, ']': 0x1b, enter: 0x1c, ctrl: 0x1d, lctrl: 0x1d,
  a: 0x1e, s: 0x1f, d: 0x20, f: 0x21, g: 0x22,
  h: 0x23, j: 0x24, k: 0x25, l: 0x26,
  ';': 0x27, "'": 0x28, '`': 0x29, shift: 0x2a, lshift: 0x2a, '\\': 0x2b,
  z: 0x2c, x: 0x2d, c: 0x2e, v: 0x2f, b: 0x30,
  n: 0x31, m: 0x32, ',': 0x33, '.': 0x34, '/': 0x35,
  rshift: 0x36, alt: 0x38, lalt: 0x38, space: 0x39, capslock: 0x3a,
  f1: 0x3b, f2: 0x3c, f3: 0x3d, f4: 0x3e, f5: 0x3f, f6: 0x40,
  f7: 0x41, f8: 0x42, f9: 0x43, f10: 0x44, f11: 0x57, f12: 0x58,
  num0: 0x52, num1: 0x4f, num2: 0x50, num3: 0x51, num4: 0x4b,
  num5: 0x4c, num6: 0x4d, num7: 0x47, num8: 0x48, num9: 0x49,
  // Keys below live on the "extended" part of the keyboard and need the
  // extended flag, or the game reads them as their numpad twins.
  up: 0x48, down: 0x50, left: 0x4b, right: 0x4d,
  home: 0x47, end: 0x4f, pageup: 0x49, pagedown: 0x51,
  insert: 0x52, delete: 0x53, rctrl: 0x1d, ralt: 0x38,
};

const EXTENDED = new Set([
  'up', 'down', 'left', 'right', 'home', 'end',
  'pageup', 'pagedown', 'insert', 'delete', 'rctrl', 'ralt',
]);

const MOUSE_BUTTONS = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};

/** Every key name the app accepts, for the UI's key picker. */
const KEY_NAMES = Object.keys(SCANCODES).sort();

module.exports = { SCANCODES, EXTENDED, MOUSE_BUTTONS, KEY_NAMES };
