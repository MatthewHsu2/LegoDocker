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

test('backfill --file --dry-run reads a saved Sales Trends export and writes nothing', () => {
  const fixture = path.join(__dirname, 'fixtures/sales-trends-2023-01-07-to-2026-10-03.csv');
  const result = run('backfill', '--dry-run', '--file', fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /196 weeks from 2023-01-07 to 2026-10-03, 7978 rows/);
  assert.match(result.stdout, /dry run: nothing written/);
});
