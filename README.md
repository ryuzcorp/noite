# Noite

Tiny self-hostable PaaS for [celld](https://celld.dev/). Spec: [SPEC.md](SPEC.md).

```bash
cp .env.example .env
make up      # release runner + Oxide UI
make dev     # cargo-watch runner + Oxide Vite HMR
make logs
```

| Path |  |
| --- | --- |
| `apps/runner` | Rust runner (deploy, fleets, caddy) |
| `apps/noite` | Oxide control UI (passkeys, workflow/queue/schedule → runner) |
| `apps/noite/test` | sample app + `deploy.sh` |
| `docker/compose.yaml` | stack |
| `docker/compose.coolify.yaml` | production stack for Coolify (automatic generated domain, generated secrets, healthchecks) |
| `docker/compose.byob.yaml` | external-S3 overlay (`make up-byob`), bundled RustFS excluded |

| URL                            |                       |
| ------------------------------ | --------------------- |
| http://localhost:9080          | control UI (passkeys) |
| http://api.localhost:9080      | runner API            |
| `http://{slug}.localhost:9080` | deployed apps         |

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
