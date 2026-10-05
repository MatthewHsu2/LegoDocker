'use strict';

const REQUIRED = [
  'Style', 'LW Sls U', 'LW Sls $', '2 WA Sls U', '3 WA Sls U', '4 WA Sls U',
  'EOP U', 'EOP $', 'LW UNITS IT', 'LW UNITS OO',
];

// "2 WA" is the week before the file's own week ("LW"), so it is 7 days back, not 14.
const REFILL_COLUMNS = [['2 WA Sls U', 7], ['3 WA Sls U', 14], ['4 WA Sls U', 21]];

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

// "$1,234" -> 1234, "(1)" -> -1, "($2,900)" -> -2900, "" -> null.
function parseNumber(text, what) {
  let s = text.trim().replace(/[$,%]/g, '');
  if (s === '') return null;
  const negative = s.startsWith('(') && s.endsWith(')');
  if (negative) s = s.slice(1, -1);
  const n = Number(s);
  if (s === '' || !Number.isFinite(n)) throw new Error(`${what}: not a number: "${text}"`);
  return negative ? -n : n;
}

function parseInteger(text, what) {
  const n = parseNumber(text, what);
  if (n !== null && !Number.isInteger(n)) throw new Error(`${what}: not a whole number: "${text}"`);
  return n;
}

function readDateLine(lines) {
  for (const line of lines) {
    const m = /^Date \(Date\) = (\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(line);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

function toUtcDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isSaturday(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const date = toUtcDate(iso);
  return date.toISOString().slice(0, 10) === iso && date.getUTCDay() === 6;
}

function addDays(iso, days) {
  const date = toUtcDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parse(text, { weekEnding } = {}) {
  const lines = text.split(/\r?\n/);

  const fileWeek = readDateLine(lines);
  if (fileWeek && weekEnding && fileWeek !== weekEnding) {
    throw new Error(`file says week ending ${fileWeek}, --week-ending says ${weekEnding}`);
  }
  const week = fileWeek ?? weekEnding;
  if (!week) throw new Error('no "Date (Date) =" line in the file and no --week-ending given');
  if (!isSaturday(week)) throw new Error(`week ending ${week} is not a Saturday`);

  const headerAt = lines.findIndex((l) => l.startsWith('"Style",'));
  if (headerAt < 0) throw new Error('no header row starting with "Style"');
  const header = splitCsvLine(lines[headerAt]);
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`missing columns: ${missing.join(', ')}`);
  const col = Object.fromEntries(REQUIRED.map((c) => [c, header.indexOf(c)]));

  let total = null;
  const refillTotals = new Map();
  const refillSums = new Map(REFILL_COLUMNS.map(([column]) => [column, 0]));
  const rows = [];
  const refills = [];
  const seen = new Set();

  for (const line of lines.slice(headerAt + 1)) {
    if (line.trim() === '') continue;
    const cells = splitCsvLine(line);
    if (cells.length !== header.length) {
      throw new Error(`row has ${cells.length} cells, header has ${header.length}: ${line.slice(0, 60)}`);
    }
    const name = cells[col.Style];
    if (name === 'Total') {
      total = parseInteger(cells[col['LW Sls U']], 'Total LW Sls U');
      for (const [column] of REFILL_COLUMNS) {
        refillTotals.set(column, parseInteger(cells[col[column]], `Total ${column}`) ?? 0);
      }
      continue;
    }

    const dash = name.indexOf(' - ');
    const style = (dash < 0 ? name : name.slice(0, dash)).trim();
    const description = dash < 0 ? null : name.slice(dash + 3).trim() || null;
    if (style === '') throw new Error(`row with an empty style: ${line.slice(0, 60)}`);
    if (seen.has(style)) throw new Error(`style ${style} appears twice`);
    seen.add(style);

    const unitsSold = parseInteger(cells[col['LW Sls U']], `${style} LW Sls U`);
    if (unitsSold !== null) {
      rows.push({
        style,
        description,
        unitsSold,
        salesDollars: parseNumber(cells[col['LW Sls $']], `${style} LW Sls $`),
        onHandUnits: parseInteger(cells[col['EOP U']], `${style} EOP U`),
        onHandDollars: parseNumber(cells[col['EOP $']], `${style} EOP $`),
        inTransitUnits: parseInteger(cells[col['LW UNITS IT']], `${style} LW UNITS IT`),
        onOrderUnits: parseInteger(cells[col['LW UNITS OO']], `${style} LW UNITS OO`),
      });
    }

    for (const [column, days] of REFILL_COLUMNS) {
      const units = parseInteger(cells[col[column]], `${style} ${column}`);
      if (units === null) continue;
      refills.push({ weekEnding: addDays(week, -days), style, description, unitsSold: units });
      refillSums.set(column, refillSums.get(column) + units);
    }
  }

  if (total === null) throw new Error('no Total row');
  const stored = rows.reduce((n, r) => n + r.unitsSold, 0);
  if (stored !== total) throw new Error(`stored units ${stored} do not match Total LW Sls U ${total}`);
  for (const [column, sum] of refillSums) {
    if (sum !== refillTotals.get(column)) {
      throw new Error(`refill units ${sum} do not match Total ${column} ${refillTotals.get(column)}`);
    }
  }

  return { weekEnding: week, rows, refills };
}

module.exports = { decode, parse };
