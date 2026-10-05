'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('../src/log');

test('passwords never reach the log', () => {
  const env = { SPS_PASSWORD: 'p@ss w$rd', SQL_PASSWORD: 'sql-secret' };
  const line = redact('fill("p@ss w$rd") failed; login sql-secret refused', env);
  assert.equal(line, 'fill("***") failed; login *** refused');
});

test('an unset password does not blank the message', () => {
  assert.equal(redact('login failed', { SPS_PASSWORD: '' }), 'login failed');
});
