# Nightly Metabase-metadata backup image.
# Based on the same Postgres major as the server so pg_dump is version-compatible.
FROM postgres:16.4

# cron for scheduling; curl to PUT the dump to Azure Blob via a container SAS URL.
RUN apt-get update \
    && apt-get install -y --no-install-recommends cron curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY backup.sh /usr/local/bin/backup.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh

# Override the postgres image's entrypoint — this container schedules dumps, it is not a DB.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
