'use strict';
const { splitCsvLine, parseInteger, isSaturday } = require('./parse');

// Reads the "Weekly Unit Sales by Style" grid exported from the Sales Trends dashboard.
// Two header rows: dates on the first, metric names on the second. Each week has a
// "TY Sls U" column (units sold that week) and an "LY Sls U" column (same week a year
// earlier), which is ignored because the year before is its own TY column.
function parseTrend(text) {
  const lines = text.split(/\r?\n/);
  const headerAt = lines.findIndex((l) => l.startsWith('"Style Number",'));
  if (headerAt < 0) throw new Error('no header row starting with "Style Number"');
  const dates = splitCsvLine(lines[headerAt]);
  const metrics = splitCsvLine(lines[headerAt + 1] ?? '');

  const weeks = [];
  for (let i = 2; i < dates.length; i++) {
    if (metrics[i] !== 'TY Sls U' || dates[i] === 'Total') continue;
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dates[i]);
    const iso = m && `${m[3]}-${m[1]}-${m[2]}`;
    if (!iso || !isSaturday(iso)) throw new Error(`week column "${dates[i]}" is not a Saturday`);
    weeks.push({ column: i, iso });
  }
  if (weeks.length === 0) throw new Error('no "TY Sls U" week columns');

  let total = null;
  const refills = [];
  const sums = new Map(weeks.map((w) => [w.iso, 0]));
  const seen = new Set();

  for (const line of lines.slice(headerAt + 2)) {
    if (line.trim() === '') continue;
    const cells = splitCsvLine(line);
    if (cells.length !== dates.length) {
      throw new Error(`row has ${cells.length} cells, header has ${dates.length}: ${line.slice(0, 60)}`);
    }
    const style = cells[0].trim();
    if (style === 'Total') {
      total = new Map(weeks.map((w) => [w.iso, parseInteger(cells[w.column], `Total ${w.iso}`) ?? 0]));
      continue;
    }
    if (style === '') throw new Error(`row with an empty style: ${line.slice(0, 60)}`);
    if (seen.has(style)) throw new Error(`style ${style} appears twice`);
    seen.add(style);
    const description = cells[1].trim() || null;
    for (const w of weeks) {
      const units = parseInteger(cells[w.column], `${style} ${w.iso}`);
      if (units === null) continue;
      refills.push({ weekEnding: w.iso, style, description, unitsSold: units });
      sums.set(w.iso, sums.get(w.iso) + units);
    }
  }

  if (total === null) throw new Error('no Total row');
  for (const [week, sum] of sums) {
    if (sum !== total.get(week)) {
      throw new Error(`week ${week}: styles add up to ${sum}, Total row says ${total.get(week)}`);
    }
  }
  return { weeks: weeks.map((w) => w.iso), refills };
}

module.exports = { parseTrend };
