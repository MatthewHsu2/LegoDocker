#!/bin/bash
# Persist container env so the cron-launched job can see the credentials (cron runs each command
# in a minimal environment). Same pattern as metabase/backup/entrypoint.sh: `printf %q` keeps a
# password with spaces, $, quotes, or backticks intact when the file is sourced.
#
# PATH and PLAYWRIGHT_BROWSERS_PATH come from the base image. Without them cron finds neither
# node nor Chromium, and the job only fails when cron runs it, never under `docker compose exec`.
set -euo pipefail

: > /etc/dicks-sync.env
chmod 600 /etc/dicks-sync.env
for name in SPS_EMAIL SPS_PASSWORD SQL_SERVER SQL_DATABASE SQL_USER SQL_PASSWORD TZ \
            PATH PLAYWRIGHT_BROWSERS_PATH; do
    if [ -n "${!name+x}" ]; then
        printf 'export %s=%q\n' "$name" "${!name}" >> /etc/dicks-sync.env
    fi
done

{
    echo "SHELL=/bin/bash"
    echo "${SYNC_CRON:-0 6 * * *} . /etc/dicks-sync.env; dicks-sync once >> /proc/1/fd/1 2>&1"
} | crontab -

echo "dicks-sync: scheduled '${SYNC_CRON:-0 6 * * *}' (TZ=${TZ:-UTC})"
exec cron -f
