# Noite

Tiny self-hostable PaaS for [celld](https://celld.dev/). Spec: [SPEC.md](SPEC.md).

```bash
cp .env.example .env
make up      # production stack (release images)
make dev     # same topology, dev processes (cargo-watch + vite dev)
make logs
```

| Path |  |
| --- | --- |
| `apps/runner` | Rust runner (deploy, fleets, caddy) |
| `apps/noite` | Oxide control UI (passkeys, workflow/queue/schedule → runner) |
| `apps/noite/test` | sample app + `deploy.sh` |
| `docker/compose.yaml` | stack |
| `docker/compose.coolify.yaml` | production stack for Coolify (automatic generated domain, generated secrets, healthchecks) |
| `docker/compose.byob.yaml` | external-S3 overlay (compose `-f` flag), bundled RustFS excluded |

| URL                            |                       |
| ------------------------------ | --------------------- |
| http://localhost:9080          | control UI (passkeys) |
| http://api.localhost:9080      | runner API            |
| `http://{slug}.localhost:9080` | deployed apps         |

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

Leave `BETTER_AUTH_URL` **unset** so the passkey rpID follows each origin (`localhost` on the laptop, `noite.local` on the phone). Then `podman restart noite-control`.

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

Point a Docker Compose resource at `docker/compose.coolify.yaml` (repo root, branch `main`). In Environment Variables, set the required `BASE_DOMAIN` (secrets auto-generate — just save); `BETTER_AUTH_URL` / `GIT_PUBLIC_BASE` derive from it unless overridden. Deploy: Coolify auto-provisions a generated domain for the `caddy` service and the runner serves the control UI on it (boot check). Traefik routes `app.`/`api.`/`git.` to `caddy:80` and TCP-forwards `*.<domain>` SNI to `caddy:443`, where our Caddy terminates per-host TLS itself; tenant subdomains need zero per-app steps (full guide in `apps/website/docs/deployment.mdx`). Then paste the real hostnames once on the `caddy` service Domains field (Coolify can't take custom hostnames from Compose): `https://app.<domain>:80,https://api.<domain>:80,https://git.<domain>:80`. The apex stays on your marketing site.

Tenant subdomains (`<slug>.<domain>`) are fully automatic: a Traefik TCP router forwards every `*.<domain>` SNI straight to our Caddy on `:443`, and our Caddy mints a per-slug cert on demand (ask-gated by the runner — only live tenant/platform hosts get certs, no wildcard cert or DNS provider involved). Two one-time prerequisites: `*.<domain>` DNS → the server, and this file saved under `Servers > server > Proxy > Dynamic Configurations` (dashboard-pasted file config is static text — unlike compose labels, Coolify can't mangle it — and `noite-tenants@docker` resolves the TCP service the compose file defines):

```yaml
tcp:
  routers:
    noite-tenants:
      entryPoints: [https]
      rule: 'HostSNIRegexp(`^.+\.<domain>$`)'
      service: noite-tenants@docker
      tls: { passthrough: true }
```

Then redeploy once and confirm the `noite-tenants` router in the Traefik dashboard. First visit to a new slug pauses a few seconds for issuance; certs persist in `caddy-data`. Fallback if passthrough misbehaves: add `https://<slug>.<domain>:80` per app (exact hostnames use the plain HTTP challenge).
