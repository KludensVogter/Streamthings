'use strict';

const { suite, ok, eq } = require('./helpers');
const i18n = require('../src/shared/i18n');

module.exports = async function run() {
  suite('Languages');
  const codes = i18n.available();
  ok('English ships', codes.includes('en'));
  ok('Danish ships', codes.includes('da'));
  ok('every language has a display name', codes.every((c) => i18n.LANGUAGE_NAMES[c]));

  const en = i18n.dictionary('en');
  const da = i18n.dictionary('da');

  suite('Translation coverage');
  const missing = Object.keys(en).filter((key) => !Object.prototype.hasOwnProperty.call(
    JSON.parse(JSON.stringify(require('../src/renderer/i18n/da.json'))), key,
  ));
  eq('Danish translates every English key', missing, []);

  const extra = Object.keys(require('../src/renderer/i18n/da.json'))
    .filter((key) => !Object.prototype.hasOwnProperty.call(en, key));
  eq('Danish has no keys English lacks', extra, []);

  ok('no empty strings', Object.entries(da).every(([, v]) => String(v).trim().length > 0));

  suite('Placeholders match between languages');
  const holes = (text) => (String(text).match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  const mismatched = Object.keys(en).filter((key) => holes(en[key]) !== holes(da[key]));
  eq('same placeholders in both', mismatched, []);

  suite('Lookup');
  eq('known key', i18n.translate(en, 'button.start'), 'Start');
  eq('fills placeholders', i18n.translate(en, 'status.live', { channel: 'ana' }), 'Connected to ana');
  eq('unknown key returns the key itself', i18n.translate(en, 'nope.nope'), 'nope.nope');

  suite('Language choice');
  eq('explicit setting wins', i18n.resolve('da', 'en-US'), 'da');
  eq('auto follows Windows', i18n.resolve('auto', 'da-DK'), 'da');
  eq('auto falls back to English', i18n.resolve('auto', 'ja-JP'), 'en');
  eq('unknown setting falls back', i18n.resolve('kl', 'en-GB'), 'en');

  suite('Partial translations still render');
  const merged = i18n.dictionary('da');
  ok('Danish dictionary is backed by English', Object.keys(merged).length >= Object.keys(en).length);
};
