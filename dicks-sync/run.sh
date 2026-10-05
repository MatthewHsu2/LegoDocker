#!/bin/bash
# Runs sync.js under a lock, so the 06:00 cron run and a manual run never overlap.
# node inherits fd 9 through exec, so the lock is held until node exits.
exec 9>/tmp/dicks-sync.lock
if ! flock -n 9; then
    echo "[dicks-sync] $(date '+%F %T') ERROR: another run is still going; this run did nothing" >&2
    exit 1
fi
cd /app
exec node src/sync.js "$@"
