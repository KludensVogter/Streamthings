'use strict';

const { summary } = require('./helpers');

const suites = [
  './input.test.js',
  './engine.test.js',
  './profiles.test.js',
  './chat.test.js',
  './poll.test.js',
  './toggles.test.js',
  './i18n.test.js',
];

(async () => {
  for (const name of suites) {
    let mod;
    try {
      mod = require(name);
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(name.replace('./', ''))) continue;
      throw err;
    }
    await mod();
  }
  process.exit(summary() ? 0 : 1);
})();
