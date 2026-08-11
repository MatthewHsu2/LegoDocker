#!/bin/bash
# Persist container env so the cron-launched job can see the DB creds and SAS URL (cron runs
# each command in a minimal environment and would not otherwise inherit them).
#
# Values are written with `printf %q`, which emits an exactly round-trippable, shell-escaped
# form — so a password or Azure SAS token containing spaces, $, &, quotes, or backticks
# survives intact instead of breaking the file or executing as code when it's sourced.
set -euo pipefail

: > /etc/backup.env
chmod 600 /etc/backup.env
# Only the vars backup.sh actually reads; only if set (so downstream ${VAR:-default} still works).
for name in MB_DB_DBNAME MB_DB_USER MB_DB_PASS AZURE_BLOB_SAS_URL RETENTION_DAYS TZ; do
    if [ -n "${!name+x}" ]; then
        printf 'export %s=%q\n' "$name" "${!name}" >> /etc/backup.env
    fi
done

# Install root's crontab. `SHELL=/bin/bash` makes cron source the %q-quoted env file with bash
# (values may use bash $'...' escaping); then run the dump, logging to container stdout (PID 1).
{
    echo "SHELL=/bin/bash"
    echo "${BACKUP_CRON:-0 2 * * *} . /etc/backup.env; /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1"
} | crontab -

echo "metabase-backup: scheduled '${BACKUP_CRON:-0 2 * * *}' (TZ=${TZ:-UTC})"
exec cron -f
