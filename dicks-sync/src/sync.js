'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { decode, parse } = require('./parse');
const { log, error } = require('./log');
const { prune } = require('./files');

const DATA = process.env.DATA_DIR || '/data';
const RAW = path.join(DATA, 'raw');
const FAILURES = path.join(DATA, 'failures');
const RETENTION_DAYS = 730;

const USAGE = 'usage: sync.js once [--dry-run] | load-file <path> --week-ending YYYY-MM-DD';

async function apply(parsed, file, dryRun) {
  const units = parsed.rows.reduce((n, r) => n + r.unitsSold, 0);
  log(`week ending ${parsed.weekEnding}: ${parsed.rows.length} styles, ${units} units, `
    + `${parsed.refills.length} refill rows (${path.basename(file)})`);
  if (dryRun) {
    for (const r of parsed.rows) log(`  ${r.style}  ${r.unitsSold} units  $${r.salesDollars ?? ''}`);
    for (const r of parsed.refills) log(`  refill ${r.weekEnding} ${r.style}  ${r.unitsSold} units`);
    log('dry run: nothing written');
    return;
  }
  const { writeWeek } = require('./store');
  const result = await writeWeek(process.env, parsed, path.basename(file));
  log(`wrote ${result.inserted} rows for ${parsed.weekEnding}; `
    + `refilled weeks: ${result.refilledWeeks.join(', ') || 'none'}`);
}

async function loadFile(args) {
  const flag = args.indexOf('--week-ending');
  const weekEnding = flag >= 0 ? args[flag + 1] : undefined;
  const rest = args.filter((_, i) => flag < 0 || (i !== flag && i !== flag + 1));
  if (rest.length !== 1 || !weekEnding) throw new Error(USAGE);
  const file = rest[0];
  const parsed = parse(decode(fs.readFileSync(file)), { weekEnding });
  await apply(parsed, file, false);
}

async function once(dryRun) {
  for (const dir of [RAW, FAILURES]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of prune(dir, RETENTION_DAYS)) log(`pruned ${path.join(dir, name)}`);
  }
  const { download } = require('./portal');
  const downloaded = await download({
    email: process.env.SPS_EMAIL,
    password: process.env.SPS_PASSWORD,
    rawDir: RAW,
    failuresDir: FAILURES,
  });
  let parsed;
  try {
    parsed = parse(decode(fs.readFileSync(downloaded)));
  } catch (err) {
    throw new Error(`${err.message} (raw file kept: ${downloaded})`);
  }
  const file = path.join(RAW, `${parsed.weekEnding}.csv`);
  fs.renameSync(downloaded, file);
  await apply(parsed, file, dryRun);
}

async function main([command, ...args]) {
  if (command === 'once') return once(args.includes('--dry-run'));
  if (command === 'load-file') return loadFile(args);
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((err) => {
  error(err.message);
  process.exitCode = 1;
});
