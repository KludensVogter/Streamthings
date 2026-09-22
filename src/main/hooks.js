'use strict';

const koffi = require('koffi');

/**
 * Low-level keyboard and mouse hooks, used only to let a chat command
 * override the streamer's own hands.
 *
 * This is the same Windows API a keylogger would use, so it is worth being
 * precise about what this does and does not do: nothing is recorded, nothing
 * is written down, and nothing leaves the callback. The hook answers exactly
 * one question — "is this specific key suppressed right now?" — and only
 * ever while an overriding command is running.
 *
 * Every guard below exists so a mistake cannot leave the keyboard dead:
 *
 *  - the hooks are only installed while a profile actually has an
 *    overriding command and chat is playing;
 *  - suppression is time-boxed, so it ends on its own even if the code that
 *    started it never gets to stop it;
 *  - the panic key is never suppressed;
 *  - injected input is never suppressed, or we would eat our own presses;
 *  - the callback can only ever return "pass it on" if anything throws.
 */

const user32 = koffi.load('user32.dll');

const HOOKPROC = koffi.proto('intptr_t __stdcall HookProc(int nCode, uintptr_t wParam, void *lParam)');
const SetWindowsHookExW = user32.func('void *SetWindowsHookExW(int idHook, HookProc *lpfn, void *hmod, uint32_t dwThreadId)');
const UnhookWindowsHookEx = user32.func('bool UnhookWindowsHookEx(void *hhk)');
const CallNextHookEx = user32.func('intptr_t __stdcall CallNextHookEx(void *hhk, int nCode, uintptr_t wParam, void *lParam)');

const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
  vkCode: 'uint32_t',
  scanCode: 'uint32_t',
  flags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
});

const MSLLHOOKSTRUCT = koffi.struct('MSLLHOOKSTRUCT', {
  x: 'int32_t',
  y: 'int32_t',
  mouseData: 'uint32_t',
  flags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
});

const WH_KEYBOARD_LL = 13;
const WH_MOUSE_LL = 14;
const HC_ACTION = 0;
const LLKHF_INJECTED = 0x10;
const LLMHF_INJECTED = 0x01;
const SUPPRESS = 1;

/** Mouse messages, paired so a suppressed button never sticks down. */
const MOUSE_MESSAGES = {
  0x0201: 'left', 0x0202: 'left',
  0x0204: 'right', 0x0205: 'right',
  0x0207: 'middle', 0x0208: 'middle',
};

const state = {
  installed: false,
  keyboardHook: null,
  mouseHook: null,
  keyboardCallback: null,
  mouseCallback: null,
  /** Suppression is always time-boxed; zero means nothing is suppressed. */
  until: 0,
  keys: new Set(),
  buttons: new Set(),
  panicKey: 0,
  swallowed: 0,
};

function activeNow(now = Date.now()) {
  if (state.until === 0) return false;
  if (now >= state.until) {
    state.until = 0;
    state.keys.clear();
    state.buttons.clear();
    return false;
  }
  return true;
}

/**
 * Whether this key press should be swallowed. Pulled out of the hook
 * callback so the rules can be tested without a real keyboard: only real
 * physical presses can ever be suppressed, and no test can produce one.
 */
function shouldSuppressKey(vkCode, flags, now = Date.now()) {
  if (!activeNow(now)) return false;
  // Our own injected presses must pass, or we would eat the command.
  if ((flags & LLKHF_INJECTED) !== 0) return false;
  // The panic key always reaches Windows, whatever else is going on.
  if (vkCode === state.panicKey) return false;
  return state.keys.has(vkCode);
}

function shouldSuppressMouse(message, flags, now = Date.now()) {
  if (!activeNow(now)) return false;
  if ((flags & LLMHF_INJECTED) !== 0) return false;
  const button = MOUSE_MESSAGES[Number(message)];
  return Boolean(button) && state.buttons.has(button);
}

function onKeyboard(nCode, wParam, lParam) {
  try {
    if (nCode === HC_ACTION) {
      const event = koffi.decode(lParam, KBDLLHOOKSTRUCT);
      if (shouldSuppressKey(event.vkCode, event.flags)) {
        state.swallowed += 1;
        return SUPPRESS;
      }
    }
  } catch {
    // Anything unexpected falls through to the normal path rather than
    // risking a key that never arrives.
  }
  return CallNextHookEx(null, nCode, wParam, lParam);
}

function onMouse(nCode, wParam, lParam) {
  try {
    if (nCode === HC_ACTION && MOUSE_MESSAGES[Number(wParam)]) {
      const event = koffi.decode(lParam, MSLLHOOKSTRUCT);
      if (shouldSuppressMouse(wParam, event.flags)) {
        state.swallowed += 1;
        return SUPPRESS;
      }
    }
  } catch {
    // As above: never let a failure here swallow a click by accident.
  }
  return CallNextHookEx(null, nCode, wParam, lParam);
}

/**
 * Installs the hooks. Only called when a profile really has an overriding
 * command, so the ordinary case never touches this API at all.
 */
function install() {
  if (state.installed) return true;
  try {
    state.keyboardCallback = koffi.register(onKeyboard, koffi.pointer(HOOKPROC));
    state.mouseCallback = koffi.register(onMouse, koffi.pointer(HOOKPROC));
    state.keyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, state.keyboardCallback, null, 0);
    state.mouseHook = SetWindowsHookExW(WH_MOUSE_LL, state.mouseCallback, null, 0);
    state.installed = Boolean(state.keyboardHook);
    if (!state.installed) uninstall();
    return state.installed;
  } catch {
    uninstall();
    return false;
  }
}

function uninstall() {
  state.until = 0;
  state.keys.clear();
  state.buttons.clear();
  try {
    if (state.keyboardHook) UnhookWindowsHookEx(state.keyboardHook);
    if (state.mouseHook) UnhookWindowsHookEx(state.mouseHook);
  } catch {
    // Losing the handle is not worth crashing over; the hooks die with the
    // process in any case.
  }
  try {
    if (state.keyboardCallback) koffi.unregister(state.keyboardCallback);
    if (state.mouseCallback) koffi.unregister(state.mouseCallback);
  } catch {
    // Same reasoning.
  }
  state.keyboardHook = null;
  state.mouseHook = null;
  state.keyboardCallback = null;
  state.mouseCallback = null;
  state.installed = false;
}

/** The virtual-key code that must always reach Windows. */
function setPanicKey(vkCode) {
  state.panicKey = Number(vkCode) || 0;
}

/**
 * Swallows the streamer's own presses of these keys for a while.
 * The window is capped so a runaway value cannot lock the keyboard.
 */
function suppress(virtualKeys, buttons, milliseconds) {
  if (!state.installed) return false;
  const span = Math.max(0, Math.min(Number(milliseconds) || 0, 30000));
  if (span === 0) return false;

  state.keys = new Set((virtualKeys || []).filter((vk) => vk && vk !== state.panicKey));
  state.buttons = new Set(buttons || []);
  state.until = Math.max(state.until, Date.now() + span);
  return true;
}

/** Hands control straight back, used by the panic key and when stopping. */
function release() {
  state.until = 0;
  state.keys.clear();
  state.buttons.clear();
}

function status() {
  return {
    installed: state.installed,
    suppressing: activeNow(),
    swallowed: state.swallowed,
  };
}

module.exports = {
  install, uninstall, suppress, release, setPanicKey, status,
  // Exposed for tests; the hook callbacks are the only other callers.
  shouldSuppressKey, shouldSuppressMouse,
  LLKHF_INJECTED, LLMHF_INJECTED,
};
