'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decode, parse } = require('../src/parse');

const fixture = (name) => decode(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
const oct3 = fixture('2026-10-03.csv');
const sep26 = fixture('2026-09-26.csv');
const find = (rows, style) => rows.find((r) => r.style === style);
const sum = (rows) => rows.reduce((n, r) => n + r.unitsSold, 0);

test('2026-10-03: week, F63-2026 values, and units match the Total row', () => {
  const p = parse(oct3);
  assert.equal(p.weekEnding, '2026-10-03');
  const f63 = find(p.rows, 'F63-2026');
  assert.equal(f63.description, 'SOLE F63 TREADMILL (2026)');
  assert.equal(f63.unitsSold, 225);
  assert.equal(f63.salesDollars, 220988);
  assert.equal(f63.onHandUnits, 4682);
  assert.equal(f63.onHandDollars, 4710953);
  assert.equal(f63.inTransitUnits, 110);
  assert.equal(f63.onOrderUnits, 9588);
  assert.equal(sum(p.rows), 532);
});

test('2026-10-03: refills for the three weeks before', () => {
  const p = parse(oct3);
  const f63 = p.refills.filter((r) => r.style === 'F63-2026');
  assert.deepEqual(
    f63.map((r) => [r.weekEnding, r.unitsSold]),
    [['2026-09-26', 206], ['2026-09-19', 170], ['2026-09-12', 169]],
  );
});

test('a style with an empty LW Sls U is not stored', () => {
  const p = parse(oct3);
  assert.equal(p.rows.length, 59);
  assert.equal(find(p.rows, 'E20-2020'), undefined);
  assert.equal(find(p.rows, 'RVFR-10600BL'), undefined);
});

test('2026-09-26 without a date line or --week-ending is rejected', () => {
  assert.throws(() => parse(sep26), /Date \(Date\)/);
});

test('2026-09-26 with --week-ending: F63-2026 206, TT8-2023 -1', () => {
  const p = parse(sep26, { weekEnding: '2026-09-26' });
  assert.equal(p.weekEnding, '2026-09-26');
  assert.equal(find(p.rows, 'F63-2026').unitsSold, 206);
  assert.equal(find(p.rows, 'TT8-2023').unitsSold, -1);
  assert.equal(sum(p.rows), 488);
});

test('--week-ending that disagrees with the date line is rejected', () => {
  assert.throws(() => parse(oct3, { weekEnding: '2026-09-26' }), /2026-10-03/);
});

test('a week ending that is not a Saturday is rejected', () => {
  assert.throws(() => parse(oct3.replace('10/3/2026', '10/4/2026')), /Saturday/);
  assert.throws(() => parse(sep26, { weekEnding: '2026-09-27' }), /Saturday/);
});

test('a file missing LW Sls U is rejected', () => {
  assert.throws(() => parse(oct3.replace('"LW Sls U"', '"XX"')), /LW Sls U/);
});

test('units that do not add up to the Total row are rejected', () => {
  assert.throws(() => parse(oct3.replace('"982.17","225"', '"982.17","226"')), /533.*532/);
});

test('refill units that do not add up to the Total row are rejected', () => {
  // F63-2026's "2 WA Sls U" is 206; the Total row's is 488.
  const tampered = oct3.replace('"4.6%","206"', '"4.6%","207"');
  assert.throws(() => parse(tampered), /refill units 489 do not match Total 2 WA Sls U 488/);
});
