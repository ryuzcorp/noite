# Noite

Tiny self-hostable PaaS for [celld](https://celld.dev/). Spec: [SPEC.md](SPEC.md), operator guide: [apps/website/docs/deployment.mdx](apps/website/docs/deployment.mdx).

Noite ships as **one image**, `ghcr.io/<owner>/noite`: the runner (deploy pipeline, API, Git, telemetry) runs as PID 1 and supervises Caddy (the edge), the control UI (a celld node, fleet #0) and one celld fleet per tenant app. `docker compose up -d` runs it from `docker/compose.yaml` next to the bundled RustFS store.

Registration is invite-only: the **first** account to sign up bootstraps the instance — it needs no code and is promoted to `admin` — and every later account needs a single-use code. Each member holds two codes to hand out (read them on `/account`), and admins mint more from the Invitations panel in `/god-mode`.

```bash
cp .env.example .env
make up      # build the image from the tree and start
make logs
make doctor  # codified health checks
make backup  # tar both volumes into backups/<UTC stamp>/
```

Restore is destructive and replays a backup directory over the live volumes: `make restore FROM=backups/<stamp>`.

`make up-prod` pulls the release image instead of building. `docker/compose.yaml` pulls by default and gives every variable a default, so on a host with nothing but Compose (a cloud VM, a panel's or registry's template) `docker compose -f docker/compose.yaml up -d` is the whole install. Pin `NOITE_IMAGE` to a SHA tag in production.

Bring your own S3 (R2, Tigris or S3, the stores celld qualifies; recommended for real installs): set `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and start with `--scale rustfs=0`.

| Path |  |
| --- | --- |
| `apps/runner` | Rust runner (deploy, fleets, edge config, telemetry, supervision) |
| `apps/noite` | Oxide control UI (passkeys, app actions → runner) |
| `apps/noite/test` | sample app + `deploy.sh`; `test/hostile` is the isolation probe app |
| `docker/Dockerfile` | the one image (`noite` target) and its dev variant (`dev` target) |
| `docker/compose.yaml` | the whole install: pulls the image, every variable defaulted (Compose, Coolify, stores, VMs) |
| `docker/compose.build.yaml` | overlay: build the image from the tree (`make up`) |
| `docker/compose.dev.yaml` | overlay: `cargo watch` runner + `vite dev` UI in the same service (`make dev`) |
| `docker/compose.e2e.yaml` | overlay: the e2e lane (`make e2e`, `make e2e-isolation`) |

| URL                            |                       |
| ------------------------------ | --------------------- |
| http://localhost:9080          | control UI (passkeys) |
| http://api.localhost:9080      | runner API            |
| `http://{slug}.localhost:9080` | deployed apps         |

## Architecture

- **The `noite` container.** `noite-runner` is PID 1 (under `tini`) and owns every other process:
  - **Caddy** (edge): TLS with on-demand certificates ask-gated at `/v1/edge/tls-ask`, host routing, and the compression celld does not do (`encode zstd gzip` on every site: the control UI's JS bundle drops 462 KB → 144 KB gzip, CSS 129 KB → 22 KB, while `text/event-stream` responses stay uncompressed). The runner generates the Caddyfile and loads it through Caddy's admin API (`127.0.0.1:2019`); certificates live in the volume.
  - **Control UI** (fleet #0): the Oxide worker bundle baked into the image, deployed into `s3://<bucket>/control` at boot (revision-gated, vars from the container environment) and served by a supervised celld node on `127.0.0.1:8090`.
  - **Tenant fleets**: one celld node per app, running as the unprivileged `fleet` user. Builds and release commands run as the `build` user with a cleared environment.
  - Everything else the runner does: Git smart-HTTP, bare mirrors, builds, telemetry aggregation (DuckDB), and its SQLite state, which it also snapshots into the bucket so a lost volume loses nothing.
- **rustfs** (bundled, optional): the bucket: `git/` tip bundles, `fleets/` tenant celld, `control/` the UI worker and its D1, `runner/state/` runner snapshots.

Content-hashed `/assets/*` chunks are cached immutably (`apps/noite/public/_headers`, `max-age=31536000, immutable`) because celld serves an asset with `max-age=0, must-revalidate` and no `Last-Modified`.

Tenancy: `NOITE_TENANCY=multi` (the default off `localhost`) runs tenant code sandboxed, as unprivileged users behind an egress policy that closes loopback, private ranges and cloud metadata (the object store is the one allowed private address), and refuses builds when the container lacks the capabilities for it. `single` means only you push code to the install. See [SPEC.md](SPEC.md).

Tenant subdomains are automatic: `{slug}.{BASE_DOMAIN}` routes to that app's celld listen port (20000+), decided by the edge config the runner writes. `app`/`api`/`git` slugs are reserved.

Custom hostnames are opt-in per app: add one in the app's settings (or `POST /v1/apps/{id}/domains`), point its DNS at the server, and the first visit mints the certificate — the runner routes a registered hostname to its app's port only while the app is deployed and running, and the on-demand TLS gate only issues for a live app. Platform hostnames and a hostname another app already holds are refused. There is no DNS/TXT control check yet — treat that as later hardening.

## LAN access (dev)

Phones can't do passkeys over `http://<lan-ip>:9080` (not a secure context — the browser hides WebAuthn entirely), and `*.localhost` resolves to the phone itself. Serve the dev stack as `https://noite.local` via [portless](https://github.com/vercel-labs/portless) LAN mode instead.

One-time setup (your terminal — `:443` needs sudo):

```bash
npm install -g portless
portless alias noite 9080 # route lives in ~/.portless, survives restarts
sudo firewall-cmd --permanent --add-service=https && sudo firewall-cmd --reload
```

Auth needs a secret or every `/api/auth/*` call answers 500 (`BETTER_AUTH_SECRET is missing`) on all origins. No extra file: in dev, `vite dev` hands the container's environment to the worker, as the runner does with the control fleet in prod, so `.env` alone is that source.

Set `BETTER_AUTH_URL=https://noite.local` in `.env` for this flow. Passkeys bind to that origin as their rpID, so the laptop and the phone share one credential namespace — the `.env.example` default (`http://localhost:9080`) binds them to `localhost` instead, and a phone registering on `noite.local` then fails with an rpID mismatch. A hand-written `apps/noite/.dev.vars` still overrides the environment when it exists.

Per boot:

```bash
CONTROL_EXTRA_HOSTS=noite.local make dev-host # route noite.local to control
portless proxy start --lan --https # https://noite.local (accept sudo)
```

On the phone: install `~/.portless/ca.pem` as a trusted CA (iOS: tap the file → install profile → enable full trust; Android: Security → install CA certificate), open `https://noite.local`, and register a **fresh** passkey there — `localhost` credentials are rpID-bound and never transfer. Android often can't resolve mDNS `.local` names; iOS works. `portless list` shows routes, `portless proxy stop` kills the proxy.

Tenant apps follow the same pattern: with `CONTROL_EXTRA_HOSTS=noite.local` the runner also serves `{slug}.noite.local` (same routes + wildcard fallback as `{slug}.localhost`), the UI links rebase onto the host you're browsing from, and one alias per app wires DNS on both machines:

```bash
portless alias test.noite 9080 # → https://test.noite.local (hosts + mDNS)
```

## Deploy to Coolify

Point a Docker Compose resource at `docker/compose.yaml` (repo root, branch `main`): the same file as `make up-prod`, driven by env. In Environment Variables, set `BASE_DOMAIN` to your domain (defaults to `localhost`) and `BETTER_AUTH_URL` / `GIT_PUBLIC_BASE` to match, the three secrets (`BETTER_AUTH_SECRET`, `RUNNER_TOKEN`, and `RUSTFS_ACCESS_KEY` + `RUSTFS_SECRET_KEY` or your own S3 keys), and pin `NOITE_IMAGE` to a SHA tag. Nothing generates secrets here; dev-default secrets are refused on real domains. Coolify auto-provisions a generated domain for the `noite` service (boot check via `SERVICE_URL_NOITE_80`), then paste the real hostnames once on that service's Domains field (Coolify can't take custom hostnames from Compose): `https://app.<domain>:80,https://api.<domain>:80,https://git.<domain>:80`. Behind a terminating proxy set `CADDY_AUTO_HTTPS=off`; Noite's Caddy still mints per-host certs on demand. The apex stays on your marketing site.

A new image restarts the runner and every tenant fleet with it (they cold-boot), so batch upgrades and deploy off-peak.

Tenant subdomains (`<slug>.<domain>`) are fully automatic: a Traefik TCP router forwards every `*.<domain>` SNI straight to Noite's Caddy on `:443`, which mints a per-slug cert on demand (ask-gated at `/v1/edge/tls-ask`: only live tenant/platform hosts get certs, no wildcard cert or DNS provider involved). Two one-time prerequisites: `*.<domain>` DNS → the server, and this file saved under `Servers > server > Proxy > Dynamic Configurations` (dashboard-pasted file config is static text that Coolify cannot mangle, and `noite-tenants@docker` resolves the TCP service the `noite` service label defines):

```yaml
tcp:
  routers:
    noite-tenants:
      entryPoints: [https]
      rule: 'HostSNIRegexp(`^.+\.<domain>$`)'
      service: noite-tenants@docker
      tls: { passthrough: true }
```

Then redeploy once and confirm the `noite-tenants` router in the Traefik dashboard. First visit to a new slug pauses a few seconds for issuance; certs persist in the `noite-data` volume. Fallback if passthrough misbehaves: add `https://<slug>.<domain>:80` per app (exact hostnames use the plain HTTP challenge).

## Deploy to Railway

One service from the image `ghcr.io/<owner>/noite:<sha>` with a volume at `/data`, plus a bucket: R2 or Tigris (recommended), or a second service from `docker.io/rustfs/rustfs` with its own volume. Set the same variables as above, `S3_ENDPOINT` to the bucket (`http://rustfs.railway.internal:9000` for the RustFS service), `CADDY_AUTO_HTTPS=off` (Railway terminates TLS with the `*.<domain>` custom domain), the domain's target port to `80`, and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=35` so the stop budget fits. Healthcheck path `/ready` on port `8080` if you set one (first boot can take minutes). Whether Railway grants the capabilities multi-tenant mode needs is unverified: check `make doctor`'s output (or `/ready`) on the deployed service, and run `NOITE_TENANCY=single` if isolation cannot be set up there.

Full guide: [apps/website/docs/deployment.mdx](apps/website/docs/deployment.mdx).
