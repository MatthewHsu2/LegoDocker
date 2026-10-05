'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../src/sync.js'), ...args],
  { encoding: 'utf8', env: { PATH: process.env.PATH } });

test('load-file reads the flag and the path in either order', () => {
  const fixture = path.join(__dirname, 'fixtures/2026-10-03.csv');
  // The date line says 2026-10-03, so this fails in parse, before any database work.
  const result = run('load-file', '--week-ending', '2026-09-26', fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR: file says week ending 2026-10-03, --week-ending says 2026-09-26/);
});
