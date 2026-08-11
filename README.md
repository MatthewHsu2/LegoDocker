# Self-hosted internal tools — lego-style Docker stack

A modular Docker Compose stack for self-hosting internal tools on one host, managed with
Portainer. The current host is a **Windows laptop** running Docker Desktop.

Each tool is a self-contained **"lego"** — its own folder with its own `compose.yaml`, `.env`,
and config. The root `compose.yaml` just `include:`s the legos and declares one shared network.
Adding a tool = drop in a folder + add one line.

**Ingress is not settled yet.** The Caddy lego is present but disabled by default, because it
cannot get a certificate on a laptop. Until that is decided the stack runs on the LAN over
plain HTTP. See [Ingress](#ingress-the-open-decision).


## Deployment checklist — what is left

Work top to bottom. Each item names the section with the details.

- [ ] **Host ready** — Windows laptop, Docker Desktop installed, power and auto-start
      configured, this repo cloned. *(→ Windows laptop setup)*
- [ ] **Secrets** — `cp` each `*.env.example` → `.env`; set `LAN_HOST`, the Metabase DB
      password, and `AZURE_BLOB_SAS_URL`. *(→ First run)*
- [ ] **Encryption key** — generate `MB_ENCRYPTION_SECRET_KEY` once (`openssl rand -base64 32`),
      paste into `metabase/.env`, and store it in a password manager. Losing it is
      unrecoverable. *(→ First run)*
- [ ] **JVM heap** — set `MB_JAVA_XMX` / `MB_MEM_LIMIT` to fit the laptop's RAM, and cap WSL2
      in `.wslconfig`. *(→ Windows laptop setup)*
- [ ] **Reserve the LAN IP** — give the laptop a DHCP reservation on the router, then put that
      address in `LAN_HOST`. *(→ Ingress)*
- [ ] **Bring the stack up** — `docker network create edge`, then the LAN command in
      *First run*; watch `docker compose logs -f metabase` until `/api/health` is green.
- [ ] **Metabase setup wizard** — create the admin account and org settings.
- [ ] **Connect the data source** — add SpiritWebDB (SQL Server) with a **read-only** login;
      needs a network path + a firewall rule allowing the laptop's IP on 1433.
      *(→ Post-deploy: connect Metabase to SpiritWebDB)*
- [ ] **Automated deployment** — install the GitHub Actions runner and the secrets directory.
      *(→ Automated deployment)*
- [ ] **Verify backups** — confirm a nightly dump lands in Azure Blob, and test-restore one
      into a scratch DB. An untested backup isn't a backup. *(→ Backups)*
- [ ] **Decide the public path** — LAN-only, tunnel, or a publicly reachable host.
      *(→ Ingress)*

---

## Ingress — the open decision

Caddy gets its TLS certificate through the Let's Encrypt **HTTP-01 challenge**. That challenge
needs the public internet to open a connection to port 80 **on this host**. A VM with a public
IP satisfies that. A laptop does not: it sits behind NAT on a private address, the office WAN
address changes, and no port is forwarded to it. Caddy would fail issuance and retry forever.

So the `caddy` service carries `profiles: [public]` and **does not start** with a plain
`docker compose up -d`. It stays in the repo, ready for a host that is publicly reachable:

```bash
docker compose --profile public up -d      # only on a host the internet can reach on :80
```

**What runs today: LAN mode.** The `compose.lan.yaml` overlay publishes Metabase on the office
network over plain HTTP, and Portainer on loopback only.

```bash
docker compose -f compose.yaml -f compose.lan.yaml up -d
```

Give the laptop a **DHCP reservation** on the router first and put that address in `LAN_HOST`
in the root `.env`. Metabase builds the links in its emails and alerts from `MB_SITE_URL`; a
lease change silently breaks every link already sent.

Plain HTTP means passwords cross the office network unencrypted. LAN mode is a staging step.

**Three ways to finish it, when you choose:**

| Option | Needs | Cost |
|---|---|---|
| Keep LAN-only | Nothing more | No remote access, no TLS |
| Outbound tunnel (Cloudflare, Tailscale Funnel, ngrok) | An account; Cloudflare partial-zone against a Route 53 domain needs a Business plan | No inbound ports, works behind NAT |
| Publicly reachable host | A static IP + port forward, or move back to a VM | Then `--profile public` and Caddy works as designed |

**Portainer is intentionally not exposed.** It mounts the Docker socket, which is root on the
host, and nothing authenticates in front of it. `compose.lan.yaml` binds it to `127.0.0.1:9000`.
Reach it from another machine over an SSH tunnel, and never add it to the `Caddyfile`:

```bash
ssh -L 9000:localhost:9000 <user>@<laptop>    # then browse http://localhost:9000
```

---

## Windows laptop setup

A laptop is not a server. Five things have to be handled before the stack stays up on its own.

**1. Docker Desktop starts at user login, not as a Windows service.** After a reboot the
laptop waits at the lock screen and **nothing runs**, whatever `restart: unless-stopped` says.
Pick one:

- Enable Windows auto-login, plus Docker Desktop → *Settings → General → "Start Docker Desktop
  when you sign in"*. Simple, but the machine boots to an unlocked desktop — keep it physically
  secured.
- Or install Docker Engine directly inside WSL2 instead of Docker Desktop, and start it from a
  scheduled task that runs as SYSTEM at boot. No login needed, and no Docker Desktop licence
  question.

**2. Sleep stops every container.** Control Panel → Power Options → set *Plugged in* to never
sleep, and set *Closing the lid* to "Do nothing". Confirm with `powercfg /requests` after the
stack is up.

**3. Cap WSL2 memory.** WSL2 takes up to 50% of host RAM by default and the JVM sizing in
`metabase/.env` assumes it fits. Create `%UserProfile%\.wslconfig`:

```ini
[wsl2]
memory=6GB
processors=4
```

Then `wsl --shutdown` and restart Docker Desktop. Keep `MB_JAVA_XMX` about 2 GB below that
`memory` value, and `MB_MEM_LIMIT` about 1 GB above `MB_JAVA_XMX`.

**4. Line endings are already handled — do not undo it.** `.gitattributes` pins `eol=lf` on
every file a container reads. Without it a Windows checkout writes `backup.sh` with CRLF, the
kernel reads the shebang as `/bin/bash\r`, and the container dies with `no such file or
directory` — an error that says nothing about line endings. If you ever see that message,
check the line endings first.

**5. The data lives in one file.** Every named volume sits inside the WSL2 `ext4.vhdx` disk
image. A corrupt image loses Metabase's whole metadata store in one step, so the Azure Blob
backup matters more here than it did on a VM. Verify it (→ Backups).

Two smaller notes:

- The `/dev/urandom:/dev/random` mount was removed. It is a workaround for entropy starvation
  on pre-5.6 Linux kernels, and that host path does not exist on Windows. Do not re-add it.
- Ports 80 and 443 are often already held on Windows by IIS or `http.sys` (System, PID 4).
  This only matters if you later run `--profile public`. Check with
  `netstat -ano | findstr ":443"`.

---

## First run

```bash
cd LegoDocker

# 1. Fill in secrets (do this for each folder that has one)
cp .env.example .env
cp metabase/.env.example metabase/.env
#   edit the .env files: set LAN_HOST, DB passwords, AZURE_BLOB_SAS_URL, etc.

#   Generate the Metabase encryption key ONCE and paste it into metabase/.env as
#   MB_ENCRYPTION_SECRET_KEY. Losing it later is unrecoverable — also store it in your
#   password manager, NOT only in the .env / backups.
openssl rand -base64 32

#   Lock down the secret files (cp inherits your umask, usually world-readable):
chmod 600 .env */.env

#   Set JVM heap to fit the host in metabase/.env (MB_JAVA_XMX): leave 1-2 GB for Postgres and
#   the OS — e.g. 2g on 4 GB, 3-4g on 8 GB. Keep MB_MEM_LIMIT ~1g above it. On Windows this
#   budget is the WSL2 `memory=` value, not the laptop's total RAM (→ Windows laptop setup).

# 2. Bring the stack up — LAN mode (the current ingress; see Ingress)
docker network create edge      # once, if not already created
docker compose -f compose.yaml -f compose.lan.yaml up -d

# 3. Watch it come up
docker compose ps
docker compose logs -f metabase
```

Then browse `http://<LAN_HOST>:3000` and complete the Metabase setup wizard. The first load
takes 1-2 minutes while Metabase runs its schema migrations.

Every later `docker compose` command needs the same `-f compose.yaml -f compose.lan.yaml`
pair. Without it Compose reads only the root file, sees no published ports, and would take
Metabase off the LAN on the next `up -d`.

---

## Run locally (quick test on a dev machine)

`compose.local.yaml` publishes Metabase on **loopback only** — use it to click around on your
own machine without putting anything on the network. (`compose.lan.yaml` is the deployment
overlay; this one is not.)

```bash
cp .env.example .env                 # if you haven't already
cp metabase/.env.example metabase/.env
#   Placeholder values in metabase/.env work locally — no need for a real Azure SAS or a
#   permanent encryption key just to click around.

docker network create edge           # once, if it doesn't exist
docker compose -f compose.yaml -f compose.local.yaml up -d metabase
docker compose logs -f metabase      # wait ~1-2 min for /api/health to go green
```

Then browse **http://localhost:3000**. Only `metabase` + its Postgres start — Caddy, the
nightly backup, and Portainer stay down. Tear down with
`docker compose -f compose.yaml -f compose.local.yaml down`. (Lower `MB_JAVA_XMX` in
`metabase/.env` if your machine is tight on RAM.)

---

## Add a new lego

1. Create `<tool>/compose.yaml` — put the service on the external `edge` network with
   **no published ports**, plus a named volume if it needs state. Add `<tool>/.env.example`.
2. Add one line to the root `compose.yaml` `include:` list: `- <tool>/compose.yaml`.
3. Give it a way in:
   - **LAN mode (now):** add a `ports:` entry for the service in `compose.lan.yaml`.
   - **Public mode (later):** add a block to `caddy/Caddyfile` and a DNS record
     `<tool>.<domain>` → the host's public IP. Caddy hot-reloads and issues the cert.
     ```
     <tool>.{$DOMAIN} {
         reverse_proxy <container>:<port>
     }
     ```
4. Commit and push. The runner deploys it (→ Automated deployment), or run the `up -d` command
   from *First run* by hand.

---

## Automated deployment

A push to `main` redeploys the laptop. `.github/workflows/deploy.yml` runs on a **self-hosted
GitHub Actions runner** installed on the laptop.

**Why a runner and not a webhook.** A webhook needs GitHub to open a connection *to* the
laptop, which is the same inbound problem that stops Caddy from getting a certificate. The
runner instead holds a long-poll connection *out* to GitHub. No inbound port, no static IP,
and it keeps working when the office WAN address changes.

**Why not Watchtower.** Watchtower only redeploys when an image tag moves. Everything that
changes in this repo is a Compose file or a shell script, and Watchtower ignores those.

### One-time install

1. **Move the repo to its own private GitHub repo.** The runner has full access to the laptop,
   so anyone who can push can run commands on it. Keep the repo private, and restrict who can
   push to `main`.
2. **Put the secrets outside the workspace.** `actions/checkout` runs `git clean -ffdx` on
   every job, which deletes untracked files — and the `.env` files are git-ignored. Kept in the
   workspace they would be wiped on the first deploy. Create `C:\LegoDocker\secrets\` and put
   the filled-in copies there as `root.env` and `metabase.env`. The workflow copies them into
   place each run. Back that folder up: it holds `MB_ENCRYPTION_SECRET_KEY`.
3. **Install the runner.** Repo → *Settings → Actions → Runners → New self-hosted runner*,
   choose Windows, and follow the commands it shows. When it asks for labels add
   **`legodocker`** — the workflow targets `[self-hosted, legodocker]`. Then install it as a
   service so it survives a reboot:
   ```
   .\svc.sh install
   .\svc.sh start
   ```
4. **Check `docker compose` is on the service account's PATH.** The runner service does not
   run as your interactive user. Trigger the workflow manually from the Actions tab
   (*Run workflow*) and read the log.

### What a deploy does

| Step | Purpose |
|---|---|
| Check out the pushed commit | Get the new Compose files onto the laptop |
| Restore the `.env` files | Copy secrets in from `C:\LegoDocker\secrets\` |
| `docker compose config --quiet` | Fail on a bad push **before** touching the running stack |
| `up -d --build --remove-orphans` | `--build` rebuilds `metabase-backup` after a `backup.sh` change; `--remove-orphans` deletes containers for legos taken out of the include list |
| Wait for `metabase` healthy | `up -d` only means "started". Metabase can still fail its schema migration minutes later, and the job must catch that |
| `docker compose ps` | Record the final state in the job log |

The root `compose.yaml` sets `name: legodocker`. Without it Compose derives the project name
from the current folder, and the runner's workspace path differs from wherever you ran the
stack by hand — which would create a second, empty set of volumes instead of updating the
running one.

Two things to know:

- **The overlay is pinned in the workflow.** `COMPOSE_ARGS` at the top of `deploy.yml` holds
  `-f compose.yaml -f compose.lan.yaml`. Change that one line when the ingress decision lands.
- **Roll back with a revert.** `git revert` and push; the same job redeploys the previous
  state. Image tags are all pinned, so the Compose files are the whole deployment.

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

> **The dump does not contain `MB_ENCRYPTION_SECRET_KEY`.** Data-source credentials inside it
> are encrypted with that key; a restore without it leaves every connection undecryptable and
> you'd have to re-enter them all. Keep the key in your password manager, separate from the
> Azure Blob backups. Periodically test-restore a dump into a scratch DB — an untested backup
> isn't a backup.

---

## Upgrading Metabase

Metabase pins a specific tag (`metabase/metabase:v0.63.1`); never `:latest`. To upgrade:

1. **Back up first** (`docker compose exec metabase-backup /usr/local/bin/backup.sh`) — the
   nightly dump plus a fresh one give you a rollback point.
2. Bump the tag in `metabase/compose.yaml` to the target version (pick a specific
   `v0.<minor>.<patch>` from Docker Hub — `v0.x` = OSS, `v1.x` = Enterprise, same minor).
3. `docker compose up -d metabase` — it pulls the image and runs schema migrations on boot.

Expect **downtime for schema migrations on major bumps** (e.g. v0.62 → v0.63); minor/patch
bumps within a version have no schema changes. Watch it come back with
`docker compose logs -f metabase` until `/api/health` is green.

---

## Migrating to a new host

The payoff of the lego + external-backup design — no data is trapped on the old host. This is
the same procedure whether you move laptop → laptop or laptop → VM.

1. **Old host:** the latest nightly dump is already in Azure Blob. (Or run a backup now:
   `docker compose exec metabase-backup /usr/local/bin/backup.sh`.)
2. **New host:**
   ```bash
   # install Docker + Compose, then:
   git clone <this-repo> && cd LegoDocker
   docker network create edge
   # Restore the .env files (incl. the SAME MB_ENCRYPTION_SECRET_KEY as the old host — without
   # it the restored data-source credentials can't be decrypted).
   docker compose -f compose.yaml -f compose.lan.yaml up -d metabase-db   # metadata DB only
   # download the newest dump from Azure Blob, then restore it:
   gunzip -c metabaseappdb-YYYYmmdd-HHMMSS.sql.gz \
     | docker compose exec -T metabase-db psql -U "$MB_DB_USER" -d "$MB_DB_DBNAME"
   docker compose -f compose.yaml -f compose.lan.yaml up -d               # the rest
   ```
3. **Repoint clients:** update `LAN_HOST` (and `MB_SITE_URL` through it) to the new host's
   address. If the new host is publicly reachable, point the `metabase.<domain>` A record at
   it, open 80/443, and switch to `--profile public` — Caddy then issues the cert itself.
4. **Move the runner:** remove the old runner in *Settings → Actions → Runners* and install a
   new one on the new host with the same `legodocker` label. Copy the secrets directory across.

---

## Post-deploy: connect Metabase to SpiritWebDB

After first boot, in Metabase → **Admin → Databases → Add**, choose **SQL Server** and enter
the `SpiritWebDB` host, port (1433), database, and a **read-only** login. This needs a network
path from the laptop to the SQL Server host and a **firewall rule allowing the laptop's IP on
1433**. Use the DHCP reservation from *Ingress* for that rule — a lease change would otherwise
break the data source. (Runtime configuration — not part of this compose stack.)
