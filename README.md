# Self-hosted internal tools — lego-style Docker stack

A modular Docker Compose stack for self-hosting internal tools on one host, managed with
Portainer.

Each tool is a self-contained **"lego"** — its own folder with its own `compose.yaml`, `.env`,
and config. The root `compose.yaml` just `include:`s the legos and declares one shared network.
Adding a tool means dropping in a folder and adding one line.

Current legos: **metabase** (with its Postgres metadata DB and a nightly backup), **portainer**,
and **caddy** (present but off by default).

For host setup, backups, upgrades, and migration, see [docs/operations.md](docs/operations.md).

---

## Layout

```
compose.yaml           includes every lego, declares the shared `edge` network
compose.lan.yaml       overlay: publishes ports on the host
compose.funnel.yaml    overlay: points MB_SITE_URL at the public Tailscale Funnel address
compose.local.yaml     overlay: loopback-only, for a dev machine
<tool>/compose.yaml    one lego
<tool>/.env.example    that lego's secrets, as a template
```

Overlays layer left to right, and later files win.

---

## Run it

```bash
docker network create edge          # once per host

cp .env.example .env                # then fill in the values
cp metabase/.env.example metabase/.env
chmod 600 .env metabase/.env

docker compose -f compose.yaml -f compose.lan.yaml -f compose.funnel.yaml up -d
docker compose -f compose.yaml -f compose.lan.yaml -f compose.funnel.yaml ps
```

Drop `-f compose.funnel.yaml` for LAN-only. Use `-f compose.yaml -f compose.local.yaml` on a
dev machine.

---

## Add a new lego

**1. Create the folder.**

`<tool>/compose.yaml` — put the service on the external `edge` network with **no published
ports**, and add a named volume if it needs state:

```yaml
services:
  <tool>:
    image: vendor/<tool>:<pinned-tag>     # pin the tag, never `latest`
    container_name: <tool>
    restart: unless-stopped
    environment:
      TZ: ${TZ}
    volumes:
      - <tool>-data:/data
    networks:
      - edge
    logging:
      driver: local

volumes:
  <tool>-data:

networks:
  edge:
    name: edge
    external: true
```

Add `<tool>/.env.example` if it needs secrets. Never commit the real `.env` — `.gitignore`
already blocks `**/.env`.

**2. Register it.** Add one line to the root `compose.yaml` `include:` list:

```yaml
include:
  - <tool>/compose.yaml
```

**3. Give it a way in.** Pick the mode you are running:

- **LAN** — add a `ports:` entry for the service in `compose.lan.yaml`. Bind to
  `127.0.0.1:<port>:<port>` unless the whole office should reach it.
- **Public via Funnel** — Tailscale serves one port on 443, so a second tool needs a path:
  `tailscale funnel --set-path /<tool> <port>`. It then answers at
  `https://<host>.<tailnet>.ts.net/<tool>`.
- **Public via Caddy** — only on a host the internet can reach on port 80. Add a block to
  `caddy/Caddyfile` and a DNS record for `<tool>.<domain>`. Caddy hot-reloads and issues the
  certificate:
  ```
  <tool>.{$DOMAIN} {
      reverse_proxy <container>:<port>
  }
  ```

**4. Ship it.** Commit and push. The runner deploys it, or run the `up -d` command by hand.

### Rules the stack relies on

- **Pin every image tag.** The Compose files are the whole deployment, so a floating tag makes
  a deploy non-reproducible and a rollback meaningless.
- **No published ports in the lego itself.** Ports belong in an overlay. That is what lets the
  same lego run LAN-only, behind Funnel, or behind Caddy without editing it.
- **Anything a container executes needs `eol=lf`.** `.gitattributes` already pins this. A CRLF
  shell script fails with `no such file or directory`, which says nothing about line endings.
- **Do not expose anything that mounts the Docker socket.** Portainer mounts it and is bound to
  loopback for that reason. Reach it over an SSH tunnel:
  `ssh -L 9000:localhost:9000 <user>@<host>`.
