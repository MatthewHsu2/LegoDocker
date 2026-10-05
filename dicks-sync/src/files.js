'use strict';
const fs = require('node:fs');
const path = require('node:path');

function prune(dir, maxAgeDays, now = Date.now()) {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const deleted = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.mtimeMs < cutoff) {
      fs.unlinkSync(file);
      deleted.push(name);
    }
  }
  return deleted;
}

module.exports = { prune };
