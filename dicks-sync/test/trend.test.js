'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decode, parse } = require('../src/parse');
const { parseTrend } = require('../src/trend');

const fixture = (name) => decode(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
const trend = fixture('sales-trends-2023-01-07-to-2026-10-03.csv');
const unitsOf = (p, week, style) => p.refills.find((r) => r.weekEnding === week && r.style === style)?.unitsSold;

test('Sales Trends export: 196 Saturdays from 2023-01-07 to 2026-10-03', () => {
  const p = parseTrend(trend);
  assert.equal(p.weeks.length, 196);
  assert.equal(p.weeks[0], '2023-01-07');
  assert.equal(p.weeks.at(-1), '2026-10-03');
  assert.equal(p.refills.length, 7978);
});

test('Sales Trends export: units per style and week, negatives included', () => {
  const p = parseTrend(trend);
  assert.equal(unitsOf(p, '2023-01-07', 'F63-2023'), 2);
  assert.equal(unitsOf(p, '2023-02-04', 'F63-2023'), -1);
  const f63 = p.refills.find((r) => r.style === 'F63-2023');
  assert.equal(f63.description, 'SOLE F63 TREADMILL (2023)');
});

test('Sales Trends week 2026-09-26 equals the Item Performance file for that week', () => {
  const p = parseTrend(trend);
  const item = parse(fixture('2026-09-26.csv'), { weekEnding: '2026-09-26' });
  const fromTrend = new Map(p.refills.filter((r) => r.weekEnding === '2026-09-26' && r.unitsSold !== 0)
    .map((r) => [r.style, r.unitsSold]));
  const fromItem = new Map(item.rows.filter((r) => r.unitsSold !== 0).map((r) => [r.style, r.unitsSold]));
  assert.deepEqual(fromTrend, fromItem);
});

test('a week whose styles do not add up to the Total row is rejected', () => {
  const tampered = trend.replace('"F63-2023","SOLE F63 TREADMILL (2023)","75,208","49,288","2"',
    '"F63-2023","SOLE F63 TREADMILL (2023)","75,208","49,288","3"');
  assert.throws(() => parseTrend(tampered), /2023-01-07.*1655.*1654/);
});

test('a week column that is not a Saturday is rejected', () => {
  assert.throws(() => parseTrend(trend.replace('"01/07/2023","01/07/2023"', '"01/08/2023","01/08/2023"')), /Saturday/);
});

test('a file without the TY Sls U row is rejected', () => {
  assert.throws(() => parseTrend(trend.replaceAll('"TY Sls U"', '"XX"')), /TY Sls U/);
});
