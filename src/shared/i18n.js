'use strict';

const fs = require('fs');
const path = require('path');

const DICT_DIR = path.join(__dirname, '..', 'renderer', 'i18n');
const FALLBACK = 'en';

/** Language codes we ship a dictionary for, discovered from the folder. */
function available() {
  try {
    return fs.readdirSync(DICT_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.basename(f, '.json'))
      .sort();
  } catch {
    return [FALLBACK];
  }
}

function load(code) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DICT_DIR, `${code}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Picks the language to use. "auto" follows Windows, falling back to English
 * when we do not ship that language.
 */
function resolve(setting, systemLocale) {
  const codes = available();
  if (setting && setting !== 'auto' && codes.includes(setting)) return setting;
  const short = String(systemLocale || '').toLowerCase().split('-')[0];
  if (codes.includes(short)) return short;
  return FALLBACK;
}

/** English is merged underneath so a half-translated file never shows a blank. */
function dictionary(code) {
  const base = load(FALLBACK) || {};
  if (code === FALLBACK) return base;
  return { ...base, ...(load(code) || {}) };
}

function translate(dict, key, vars) {
  let text = dict && dict[key] !== undefined ? dict[key] : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** Language names shown in the picker, always in their own language. */
const LANGUAGE_NAMES = { en: 'English', da: 'Dansk' };

module.exports = { available, resolve, dictionary, translate, LANGUAGE_NAMES, FALLBACK };
