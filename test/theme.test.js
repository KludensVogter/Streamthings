'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, ok, eq } = require('./helpers');
const { Settings, DEFAULT_THEME, cleanTheme } = require('../src/main/settings');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'streamthings-theme-'));
}

module.exports = async function run() {
  suite('Overlay look defaults');
  const fresh = cleanTheme(undefined);
  eq('a missing theme is the default one', fresh, DEFAULT_THEME);
  ok('every colour is a six-digit hex',
    [fresh.accent, fresh.background, fresh.text].every((c) => /^#[0-9a-f]{6}$/.test(c)));

  suite('Colours');
  eq('a valid colour is kept', cleanTheme({ accent: '#FF8800' }).accent, '#ff8800');
  eq('a colour name is refused', cleanTheme({ accent: 'red' }).accent, DEFAULT_THEME.accent);
  eq('a short hex is refused', cleanTheme({ accent: '#f80' }).accent, DEFAULT_THEME.accent);
  eq('nonsense is refused', cleanTheme({ background: 42 }).background, DEFAULT_THEME.background);
  eq('and one bad colour does not spoil the others',
    cleanTheme({ accent: 'nope', text: '#112233' }).text, '#112233');

  suite('Numbers are clamped to something usable');
  eq('opacity cannot exceed one', cleanTheme({ opacity: 5 }).opacity, 1);
  ok('and never goes fully invisible', cleanTheme({ opacity: 0 }).opacity >= 0.15);
  eq('width has a floor', cleanTheme({ width: 10 }).width, 240);
  eq('and a ceiling', cleanTheme({ width: 9999 }).width, 640);
  eq('radius cannot be negative', cleanTheme({ radius: -8 }).radius, 0);
  eq('radius is a whole number', cleanTheme({ radius: 12.7 }).radius, 13);
  ok('text size stays readable',
    cleanTheme({ scale: 0.1 }).scale >= 0.75 && cleanTheme({ scale: 99 }).scale <= 1.5);
  eq('a non-number falls back', cleanTheme({ width: 'wide' }).width, DEFAULT_THEME.width);

  suite('What to show');
  for (const key of ['border', 'showTitle', 'showAliases', 'showHoldHint']) {
    eq(`${key} can be turned off`, cleanTheme({ [key]: false })[key], false);
    eq(`${key} defaults to on`, cleanTheme({})[key], true);
  }

  suite('Saving and loading');
  const dir = tempDir();
  const settings = new Settings(dir);
  eq('a fresh install has the default look', settings.get().overlayTheme, DEFAULT_THEME);

  settings.update({ overlayTheme: { accent: '#00c853', opacity: 0.5, showTitle: false } });
  const saved = settings.get().overlayTheme;
  eq('a change sticks', saved.accent, '#00c853');
  eq('so does a switch', saved.showTitle, false);
  eq('untouched values keep their defaults', saved.width, DEFAULT_THEME.width);

  const reopened = new Settings(dir);
  eq('and it survives a restart', reopened.get().overlayTheme.accent, '#00c853');

  reopened.update({ overlayTheme: null });
  eq('resetting brings the default look back', reopened.get().overlayTheme, DEFAULT_THEME);

  fs.writeFileSync(path.join(dir, 'settings.json'), '{ "overlayTheme": "broken" }');
  const recovered = new Settings(dir);
  eq('a mangled theme falls back rather than crashing',
    recovered.get().overlayTheme, DEFAULT_THEME);

  fs.rmSync(dir, { recursive: true, force: true });
};
