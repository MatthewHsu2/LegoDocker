# Operations

Host setup, backups, upgrades, and migration. For the lego workflow see the
[README](../README.md).

---

## The host

The stack runs on a Windows 11 Pro laptop, with **Docker CE inside WSL2 Ubuntu** — not Docker
Desktop. The project lives at `/home/it/LegoDocker` inside the distro, on the Linux filesystem.
Do not move it to `/mnt/c`: bind mounts across the Windows boundary are slow and break file
permissions for Postgres.

Six things about running this on a laptop.

**1. WSL shuts the whole VM down when no session holds it open.** Docker and every container
die with it. The symptom is deceptive — containers show `Up 3 seconds` with `RestartCount=0`,
which looks like a fresh start rather than a crash loop. Check `uptime -s` inside the distro; a
boot time that keeps changing means the VM is restarting, not the containers.

Two things keep it alive: `vmIdleTimeout=-1` in `%UserProfile%\.wslconfig`, and a Windows
scheduled task named **LegoDocker WSL keepalive** that runs
`wsl.exe -d Ubuntu -u root --exec /usr/bin/sleep infinity` at startup.

> **Not yet verified:** whether that task starts WSL after a cold boot. It uses S4U logon, which
> runs before any user session exists — exactly when WSL may refuse to start. Test with a real
> reboot before trusting the stack to survive a power cut.

**2. Mirrored networking routes container traffic through the Hyper-V firewall**, whose
`DefaultInboundAction` is `Block`. Publishing a port needs a rule for the WSL VM, not just an
ordinary Windows firewall rule:

```powershell
New-NetFirewallHyperVRule -Name "LegoDocker-<tool>-<port>" `
  -DisplayName "LegoDocker <tool> <port>" -Direction Inbound `
  -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' `
  -Protocol TCP -LocalPorts <port> -Action Allow
New-NetFirewallRule -Name "LegoDocker-<tool>-<port>-In" `
  -DisplayName "LegoDocker <tool> <port>" -Direction Inbound `
  -Protocol TCP -LocalPort <port> -Action Allow -Profile Any
```

Without the first rule the port answers on loopback inside WSL and nowhere else.

**3. Sleep stops every container.** Control Panel → Power Options → set *Plugged in* to never
sleep, and *Closing the lid* to "Do nothing". Confirm with `powercfg /requests` once the stack
is up.

**4. Cap WSL2 memory.** `.wslconfig` sets `memory=16GB` on a 31.8 GB host. Keep `MB_JAVA_XMX`
about 2 GB below that value and `MB_MEM_LIMIT` about 1 GB above `MB_JAVA_XMX`.

**5. The data lives in one file.** Every named volume sits inside the WSL2 `ext4.vhdx` image. A
corrupt image loses Metabase's whole metadata store in one step, so the offsite backup matters
more here than it would on a VM.

**6. Cap container logs.** Every lego sets `logging: driver: local` (5 files × 20 MB,
compressed, per container). A container started outside the compose files uses the daemon
default, `json-file`, which has no limit. One-time host step:

```bash
echo '{"log-driver": "local"}' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
```

If `/etc/docker/daemon.json` already has content, add the key instead of overwriting the file.
Existing containers keep their old driver until they are recreated.

Two smaller notes:

- The `/dev/urandom:/dev/random` mount was removed. It works around entropy starvation on
  pre-5.6 kernels, and this kernel is 6.18. Do not re-add it.
- Ports 80 and 443 are often already held on Windows by IIS or `http.sys` (System, PID 4). This
  matters only if you later run `--profile public`. Check with `netstat -ano | findstr ":443"`.

---

## Ingress

**Public access uses Tailscale Funnel** at `https://metabase.tailfcfc4a.ts.net`. Tailscale runs
inside the WSL2 distro, dials outbound, and terminates TLS at its edge with a Let's Encrypt
certificate. No inbound port, no static IP, and a DHCP change cannot break it.

```bash
tailscale funnel status          # show what is served
tailscale funnel --bg 3000       # serve port 3000 on 443
tailscale funnel --https=443 off # stop serving
```

`compose.funnel.yaml` sets `MB_SITE_URL` from `PUBLIC_URL` in the root `.env`. Metabase builds
email, alert, and public-share links from that value, so it must be the address the viewer
types. Without the overlay the LAN address leaks into mail that outside viewers cannot open.

Two things Funnel does not do:

- **It does not authenticate.** The Metabase login page is reachable by anyone on the internet.
  Keep the image tag current — that is the real control.
- **It does not support a custom domain.** The certificate covers `*.ts.net` only, so a CNAME
  from your own domain fails the TLS handshake. Moving to a custom domain means moving to
  Cloudflare Tunnel, which is a swap of one container rather than a redesign.

**Caddy** stays in the repo behind `profiles: [public]` for a host the internet can reach on
port 80. Let's Encrypt HTTP-01 cannot issue to a laptop behind NAT, which is why it is off.

**Portainer is intentionally not exposed.** It mounts the Docker socket, which is root on the
host, and nothing authenticates in front of it. Reach it over a tunnel:

```bash
ssh -L 9000:localhost:9000 <user>@<host>    # then browse http://localhost:9000
```

---

## Secrets

Three files hold everything: the root `.env`, `metabase/.env`, and `dicks-sync/.env`, all
mode 600.

They also live **outside the workspace** at `/home/it/legodocker-secrets/` as `root.env`,
`metabase.env`, and `dicks-sync.env`. This is not redundancy — `actions/checkout` runs `git clean -ffdx` on every CI
job, which deletes untracked files, and the `.env` files are git-ignored. Kept only in the
workspace they would be wiped on the first deploy. The workflow copies them back in each run.
Keep the copies in step when you change one.

> **`MB_ENCRYPTION_SECRET_KEY` is unrecoverable if lost.** It encrypts data-source credentials
> inside the app DB. The nightly dump does **not** contain it, so a restore without the key
> leaves every connection undecryptable and you would re-enter them all. Store it in a password
> manager, separate from the Azure Blob backups.

---

## Backups

`metabase-backup` runs `pg_dump` on the schedule in `metabase/.env` (`BACKUP_CRON`, default
02:00), writes a gzip to the `metabase-backups` volume, uploads it to Azure Blob via
`AZURE_BLOB_SAS_URL`, and prunes local dumps older than `RETENTION_DAYS`.

Run one on demand:

```bash
docker compose exec metabase-backup /usr/local/bin/backup.sh
```

**A failed upload does not stop the job.** The script logs `ERROR: upload failed`, keeps the
local dump, still prunes, and exits with curl's status. Pruning has to happen either way: an
expired SAS token would otherwise fill the `/backups` volume, and a full volume stops the next
dump from being written at all — trading a missing offsite copy for no backups whatsoever.

Nothing alerts on this yet, so check the logs when you verify backups:

```bash
docker compose logs metabase-backup | grep ERROR
```

Test-restore a dump into a scratch database from time to time. An untested backup is not a
backup.

---

## Dick's sync

`dicks-sync` downloads Dick's Item Performance report from the SPS Commerce portal at 06:00
Mountain each day (`SYNC_CRON`, `DICKS_SYNC_TZ` in `dicks-sync/.env`) and loads `ext.DicksSellThrough` in
Spirit Web DB. Dick's posts a week (ending Saturday) on Sunday evening, so Monday's run brings it
in; the later daily runs retry a failed Monday on their own. Design:
`docs/specs/2026-10-05-dicks-sell-through-design.md`.

Test the download without writing to the database:

```bash
docker exec dicks-sync dicks-sync once --dry-run
```

**A failed run writes nothing.** Find failures in the logs:

```bash
docker logs dicks-sync 2>&1 | grep ERROR
```

- `ERROR: login failed` — the shared portal password changed. Update `SPS_PASSWORD` in
  `/home/it/legodocker-secrets/dicks-sync.env`, then redeploy (Actions → Run workflow).
- `ERROR: <step>` with a screenshot path — the portal page changed. Copy the screenshot out with
  `docker cp dicks-sync:/data/failures/<file>.png .` and fix the selector in
  `dicks-sync/src/portal.js`.
- `ERROR: ... (raw file kept: ...)` — the file did not pass the checks. The raw download stays in
  `/data/raw/`.

Load a saved file by hand (one that has no date line needs `--week-ending`, a Saturday):

```bash
docker cp dicks-sync/test/fixtures/2026-09-26.csv dicks-sync:/data/raw/2026-09-26.csv
docker exec dicks-sync dicks-sync load-file /data/raw/2026-09-26.csv --week-ending 2026-09-26
```

Only one run happens at a time. A manual run while the 06:00 run is still going logs
`ERROR: another run is still going` and does nothing.

Raw files and screenshots older than 730 days are deleted at the start of each run.

---

## Upgrading Metabase

The tag is pinned (`metabase/metabase:v0.63.1`); never `:latest`.

1. **Back up first** — `docker compose exec metabase-backup /usr/local/bin/backup.sh` gives you
   a rollback point on top of the nightly dump.
2. Bump the tag in `metabase/compose.yaml`. Pick a specific `v0.<minor>.<patch>` from Docker Hub
   — `v0.x` is open source, `v1.x` is Enterprise, same minor number.
3. `docker compose up -d metabase` — it pulls and runs schema migrations on boot.

Expect **downtime for schema migrations on minor bumps** such as v0.62 to v0.63; patch bumps
within a minor have no schema changes. Watch it with `docker compose logs -f metabase` until
`/api/health` returns green.

---

## Automated deployment

A push to `main` redeploys the host. `.github/workflows/deploy.yml` runs on a **self-hosted
GitHub Actions runner**.

**Why a runner and not a webhook.** A webhook needs GitHub to open a connection *to* the host,
which is the same inbound problem that stops Caddy from getting a certificate. The runner holds
a long-poll connection *out* to GitHub instead.

**Why not Watchtower.** Watchtower only redeploys when an image tag moves. Everything that
changes in this repo is a Compose file or a shell script, and Watchtower ignores those.

### Installing the runner

> **The runner must live inside the WSL2 Ubuntu distro, not as a Windows service.** Docker CE
> runs inside WSL2 and its socket does not exist on the Windows side, so a Windows runner fails
> every `docker` step.

1. **Keep the repo access tight.** The runner can run commands on the host, so anyone who can
   push to `main` can too. Restrict who can push.
2. **Confirm the secrets directory exists** at `/home/it/legodocker-secrets/` with `root.env`
   and `metabase.env`. Back it up — it holds `MB_ENCRYPTION_SECRET_KEY`.
3. **Install the runner** from *Settings → Actions → Runners → New self-hosted runner*, choose
   **Linux**, and run the commands inside the distro. Add the label **`legodocker`** — the
   workflow targets `[self-hosted, legodocker]`. Then install it as a service so it starts with
   the distro:
   ```bash
   sudo ./svc.sh install it
   sudo ./svc.sh start
   ```
4. **Trigger the workflow manually** from the Actions tab and read the log.

### What a deploy does

| Step | Purpose |
|---|---|
| Check out the pushed commit | Get the new Compose files onto the host |
| Restore the `.env` files | Copy secrets in from `/home/it/legodocker-secrets/` |
| `docker compose config --quiet` | Fail on a bad push **before** touching the running stack |
| `up -d --build --remove-orphans` | `--build` rebuilds `metabase-backup` after a `backup.sh` change; `--remove-orphans` deletes containers for legos taken out of the include list |
| Wait for `metabase` healthy | `up -d` only means "started". Metabase can still fail its schema migration minutes later |
| `docker compose ps` | Record the final state in the job log |

The root `compose.yaml` sets `name: legodocker`. Without it Compose derives the project name
from the current folder, and the runner's workspace path differs from wherever you ran the stack
by hand — which would create a second, empty set of volumes instead of updating the running one.

**The overlays are pinned in the workflow.** `COMPOSE_ARGS` at the top of `deploy.yml` holds the
three `-f` flags. Change that one line when ingress changes.

**Roll back with a revert.** `git revert` and push; the same job redeploys the previous state.
Image tags are all pinned, so the Compose files are the whole deployment.

---

## Migrating to a new host

No data is trapped on the old host. This is the same procedure whether you move laptop to laptop
or laptop to VM.

1. **Old host:** the latest nightly dump is already in Azure Blob, or run one now.
2. **New host:**
   ```bash
   # install Docker and Compose, then:
   git clone https://github.com/MatthewHsu2/LegoDocker.git && cd LegoDocker
   docker network create edge
   # Restore the .env files, including the SAME MB_ENCRYPTION_SECRET_KEY as the old host —
   # without it the restored data-source credentials cannot be decrypted.
   docker compose -f compose.yaml -f compose.lan.yaml up -d metabase-db   # metadata DB only
   # download the newest dump from Azure Blob, then restore it:
   gunzip -c metabaseappdb-YYYYmmdd-HHMMSS.sql.gz \
     | docker compose exec -T metabase-db psql -U "$MB_DB_USER" -d "$MB_DB_DBNAME"
   docker compose -f compose.yaml -f compose.lan.yaml -f compose.funnel.yaml up -d
   ```
3. **Repoint clients:** update `LAN_HOST` and `PUBLIC_URL`. For Funnel, run `tailscale up` on
   the new host and re-enable the funnel; the `ts.net` name follows the machine name.
4. **Move the runner:** remove the old one in *Settings → Actions → Runners*, install a new one
   with the same `legodocker` label, and copy the secrets directory across.

---

## Connecting Metabase to SpiritWebDB

In Metabase → **Admin → Databases → Add**, choose **SQL Server** and enter the `SpiritWebDB`
host, port 1433, database, and a **read-only** login.

This needs a network path from the host to the SQL Server machine and a firewall rule allowing
the host's IP on 1433. Reserve the host's address on the router first — a lease change would
otherwise break the data source. Runtime configuration, not part of this compose stack.
