'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prune } = require('../src/files');

test('files older than 730 days are deleted, newer ones kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dicks-prune-'));
  const now = Date.UTC(2026, 9, 5);
  const day = 24 * 60 * 60 * 1000;
  for (const [name, age] of [['old.csv', 731], ['keep.csv', 729]]) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '');
    const t = new Date(now - age * day);
    fs.utimesSync(file, t, t);
  }
  assert.deepEqual(prune(dir, 730, now), ['old.csv']);
  assert.deepEqual(fs.readdirSync(dir), ['keep.csv']);
});
