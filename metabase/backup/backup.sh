#!/bin/bash
# Dump the Metabase metadata DB, store a rotated local copy, and upload offsite to Azure Blob.
# Dumps are plain gzipped pg_dump files — restorable with: gunzip -c FILE | psql ...
set -euo pipefail

STAMP="$(date +%Y%m%d-%H%M%S)"
BLOB="${MB_DB_DBNAME}-${STAMP}.sql.gz"
FILE="/backups/${BLOB}"
PARTIAL="${FILE}.partial"

# Dump to a .partial name and rename only on success. A dump killed halfway still leaves bytes
# on disk, and a truncated .sql.gz under the real name looks exactly like a restorable backup.
trap 'rm -f "${PARTIAL}"' EXIT

echo "[backup] $(date '+%F %T') dumping ${MB_DB_DBNAME} -> ${FILE}"
PGPASSWORD="${MB_DB_PASS}" pg_dump -h metabase-db -U "${MB_DB_USER}" "${MB_DB_DBNAME}" \
    | gzip > "${PARTIAL}"
mv "${PARTIAL}" "${FILE}"

# AZURE_BLOB_SAS_URL points at the *container*:  https://<acct>.blob.core.windows.net/<container>?<sas>
# Splice the blob name in before the query string to get the per-blob upload URL.
base="${AZURE_BLOB_SAS_URL%%\?*}"
sas="${AZURE_BLOB_SAS_URL#*\?}"
upload_url="${base}/${BLOB}?${sas}"

echo "[backup] uploading ${BLOB} to Azure Blob"
# A failed upload must not abort the script, so capture the status instead of letting `set -e`
# kill the run. The prune below still has to happen, and the exit code is re-raised at the end.
upload_rc=0
curl -sf -X PUT -T "${FILE}" \
    --retry 3 --retry-delay 10 --retry-connrefused \
    -H "x-ms-blob-type: BlockBlob" \
    -H "Content-Type: application/gzip" \
    "${upload_url}" || upload_rc=$?

if [ "${upload_rc}" -eq 0 ]; then
    echo "[backup] upload complete"
else
    echo "[backup] ERROR: upload failed (curl exit ${upload_rc}). Local dump kept: ${FILE}" >&2
    echo "[backup] ERROR: this dump has NO offsite copy — check AZURE_BLOB_SAS_URL." >&2
fi

# Prune runs even when the upload failed. Skipping it turns one expired SAS token into a full
# /backups volume, and a full volume stops the next dump from being written at all — trading a
# missing offsite copy for no backups whatsoever. Today's dump is newer than the window, so at
# least one local copy always survives.
find /backups -name '*.sql.gz' -mtime +"${RETENTION_DAYS:-14}" -delete
echo "[backup] $(date '+%F %T') done (local retention ${RETENTION_DAYS:-14}d)"

# Exit nonzero on a failed upload so `docker compose exec ... backup.sh` and any future health
# check see the failure, rather than reading the prune's success as the whole job's success.
exit "${upload_rc}"
