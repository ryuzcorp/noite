# Noite

Tiny self-hostable PaaS for [celld](https://celld.dev/). Spec: [SPEC.md](SPEC.md), operator guide: [apps/website/docs/deployment.mdx](apps/website/docs/deployment.mdx).

`docker compose up -d` runs four services from `docker/compose.yaml`: `rustfs` (S3), `runner` (deploy pipeline, tenant fleets, Caddyfile, telemetry), `control` (Oxide control UI on a celld node) and `caddy` (edge).

Registration is invite-only: the **first** account to sign up bootstraps the instance — it needs no code and is promoted to `admin` — and every later account needs a single-use code. Each member holds two codes to hand out (read them on `/profile`), and admins mint more from the Invitations panel in `/god-mode`.

```bash
cp .env.example .env
make up      # build both images from the tree and start
make logs
make doctor  # codified health checks
make backup  # tar every data volume into backups/<UTC stamp>/
```

Restore is destructive and replays a backup directory over the live volumes: `make restore FROM=backups/<stamp>`.

`make up-prod` pulls the release images instead of building. On a host without a clone, set `NOITE_RUNNER_IMAGE=ghcr.io/<owner>/noite:latest` and `NOITE_CONTROL_IMAGE=ghcr.io/<owner>/noite-control:latest`, then `docker compose -f docker/compose.yaml up -d` (never `--build`) — same file, env-driven.

| Path |  |
| --- | --- |
| `apps/runner` | Rust runner (deploy, fleets, Caddyfile, telemetry) |
| `apps/noite` | Oxide control UI (passkeys, app actions → runner) |
| `apps/noite/test` | sample app + `deploy.sh` |
| `docker/compose.yaml` | the whole install (compose + Coolify via env) |
| `docker/compose.dev.yaml` | dev overlay: bind-mounted dev processes |
| `docker/compose.byob.yaml` | external-S3 overlay (compose `-f` flag), bundled RustFS excluded |

| URL                            |                       |
| ------------------------------ | --------------------- |
| http://localhost:9080          | control UI (passkeys) |
| http://api.localhost:9080      | runner API            |
| `http://{slug}.localhost:9080` | deployed apps         |

## Architecture

- **rustfs** — the fleet bucket: `git/` tip bundles, `fleets/` tenant celld, `control/` UI worker + its D1. Bundled by default; the `docker/compose.byob.yaml` overlay points the stack at any external S3 instead.
- **runner** — the Rust control plane: Git smart-HTTP, bare mirrors + builds, one celld fleet per tenant app, telemetry aggregation (DuckDB), and the Caddyfile. State lives in the `runner-data` volume and the fleet bucket; it talks straight to `rustfs:9000`.
- **control** — the Oxide control UI on a celld node. The worker bundle (`apps/noite/dist`) is baked into its image at build time and its entrypoint deploys it into `s3://<bucket>/control` on first start, revision-gated, with the worker's runtime vars patched from the container environment — so one image serves any domain/secret set and no secret is baked in.
- **caddy** — stock upstream `caddy:2.10.0-alpine`. The edge config is neither baked nor static: the runner writes the Caddyfile into the shared `caddy-config` volume and Caddy's `--watch` reloads it within a poll tick. Caddy terminates per-host TLS with on-demand certificates ask-gated at `/v1/edge/tls-ask`, and it does the compression celld does not: the generated config carries `encode zstd gzip` on every site (measured through the edge, the control UI's JS bundle drops 462 KB → 144 KB gzip and CSS 129 KB → 22 KB, while `text/event-stream` responses stay uncompressed). Content-hashed `/assets/*` chunks are cached immutably (`apps/noite/public/_headers`, `max-age=31536000, immutable`) because celld serves an asset with `max-age=0, must-revalidate` and no `Last-Modified`.

Tenant subdomains are automatic: `{slug}.{BASE_DOMAIN}` routes to that app's celld listen port (8100+) through the runner, decided by the Caddyfile the runner writes. `app`/`api`/`git` slugs are reserved.

Custom hostnames are opt-in per app: add one in the app's settings (or `POST /v1/apps/{id}/domains`), point its DNS at the server, and the first visit mints the certificate — the runner routes a registered hostname to its app's port only while the app is deployed and running, and the on-demand TLS gate only issues for a live app. Platform hostnames and a hostname another app already holds are refused. There is no DNS/TXT control check yet — treat that as later hardening.

## LAN access (dev)

Phones can't do passkeys over `http://<lan-ip>:9080` (not a secure context — the browser hides WebAuthn entirely), and `*.localhost` resolves to the phone itself. Serve the dev stack as `https://noite.local` via [portless](https://github.com/vercel-labs/portless) LAN mode instead.

One-time setup (your terminal — `:443` needs sudo):

```bash
npm install -g portless
portless alias noite 9080 # route lives in ~/.portless, survives restarts
sudo firewall-cmd --permanent --add-service=https && sudo firewall-cmd --reload
```

Auth also needs a secret — without it every `/api/auth/*` call 500s, on all origins. Create `apps/noite/.dev.vars` with:

```
BETTER_AUTH_SECRET=<long-random-string>
RUNNER_TOKEN=dev-runner-token
```

Leave `BETTER_AUTH_URL` **unset** so the passkey rpID follows each origin (`localhost` on the laptop, `noite.local` on the phone). The vite dev process reads `.dev.vars` at startup, so write it before `make dev`.

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

Point a Docker Compose resource at `docker/compose.yaml` (repo root, branch `main`) — the same universal file as `make up`, driven by env. In Environment Variables, set `BASE_DOMAIN` to your domain (defaults to `localhost`); `BETTER_AUTH_URL` / `GIT_PUBLIC_BASE` derive from it unless overridden. Set the four secrets (`BETTER_AUTH_SECRET`, `RUNNER_TOKEN`, `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`) and optionally `NOITE_RUNNER_IMAGE` / `NOITE_CONTROL_IMAGE` (`ghcr.io/<owner>/noite:latest` and `ghcr.io/<owner>/noite-control:latest`; pin a SHA for reproducibility) to pull release images instead of building. Nothing generates secrets here; dev-default secrets are refused on real domains. Coolify auto-provisions a generated domain for the `caddy` service (boot check via `SERVICE_URL_CADDY_80`), then paste the real hostnames once on that service's Domains field (Coolify can't take custom hostnames from Compose): `https://app.<domain>:80,https://api.<domain>:80,https://git.<domain>:80`. Behind a terminating proxy set `CADDY_AUTO_HTTPS=off`; our Caddy still mints per-host certs on demand. The apex stays on your marketing site.

Runtime changes round-trip through the images (`NOITE_RUNNER_IMAGE` / `NOITE_CONTROL_IMAGE`); `docker compose up` stops a service before starting its replacement, so batch control-plane changes and deploy off-peak.

Tenant subdomains (`<slug>.<domain>`) are fully automatic: a Traefik TCP router forwards every `*.<domain>` SNI straight to our Caddy on `:443`, and our Caddy mints a per-slug cert on demand (ask-gated at `/v1/edge/tls-ask` — only live tenant/platform hosts get certs, no wildcard cert or DNS provider involved). Two one-time prerequisites: `*.<domain>` DNS → the server, and this file saved under `Servers > server > Proxy > Dynamic Configurations` (dashboard-pasted file config is static text — unlike compose labels, Coolify can't mangle it — and `noite-tenants@docker` resolves the TCP service the `caddy` service label defines):

```yaml
tcp:
  routers:
    noite-tenants:
      entryPoints: [https]
      rule: 'HostSNIRegexp(`^.+\.<domain>$`)'
      service: noite-tenants@docker
      tls: { passthrough: true }
```

Then redeploy once and confirm the `noite-tenants` router in the Traefik dashboard. First visit to a new slug pauses a few seconds for issuance; certs persist in `caddy-data`. Fallback if passthrough misbehaves: add `https://<slug>.<domain>:80` per app (exact hostnames use the plain HTTP challenge). Full guide: [apps/website/docs/deployment.mdx](apps/website/docs/deployment.mdx).
