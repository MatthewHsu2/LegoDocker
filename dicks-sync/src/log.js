'use strict';

const SECRETS = ['SPS_PASSWORD', 'SQL_PASSWORD'];

function redact(text, env = process.env) {
  let out = String(text);
  for (const name of SECRETS) {
    const value = env[name];
    if (value) out = out.split(value).join('***');
  }
  return out;
}

// The sv-SE locale formats as "YYYY-MM-DD HH:MM:SS" in the container's TZ.
function stamp() {
  return new Date().toLocaleString('sv-SE');
}

function log(msg) {
  console.log(`[dicks-sync] ${stamp()} ${redact(msg)}`);
}

function error(msg) {
  console.error(`[dicks-sync] ${stamp()} ERROR: ${redact(msg)}`);
}

module.exports = { redact, stamp, log, error };
