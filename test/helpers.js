'use strict';

const results = { passed: 0, failed: [] };
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log(`\n${name}`);
}

function ok(label, condition, detail) {
  if (condition) {
    results.passed += 1;
    console.log(`  pass  ${label}${detail ? '  ' + detail : ''}`);
  } else {
    results.failed.push(`${currentSuite} / ${label}`);
    console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`);
  }
}

// BigInt has no JSON representation, and struct offsets are read as BigInt.
const show = (value) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

function eq(label, actual, expected) {
  const a = show(actual);
  const e = show(expected);
  ok(label, a === e, a === e ? '' : `got ${a}, expected ${e}`);
}

function summary() {
  const line = '='.repeat(58);
  console.log(`\n${line}`);
  if (results.failed.length === 0) {
    console.log(`  ALL ${results.passed} TESTS PASSED`);
  } else {
    console.log(`  ${results.failed.length} FAILED of ${results.passed + results.failed.length}`);
    for (const f of results.failed) console.log(`    - ${f}`);
  }
  console.log(line);
  return results.failed.length === 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { suite, ok, eq, summary, sleep };
