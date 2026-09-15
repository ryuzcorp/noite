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

Point a Docker Compose resource at `docker/compose.coolify.yaml` (repo root, branch `main`). In Environment Variables, set the required `BASE_DOMAIN` (secrets auto-generate — just save); `BETTER_AUTH_URL` / `GIT_PUBLIC_BASE` derive from it unless overridden. Deploy: Coolify auto-provisions a generated domain for the `caddy` service and the runner serves the control UI on it (boot check). Coolify terminates TLS; Caddy routes `app.`/`api.`/`git.` plus every tenant slug internally. Then paste the real hostnames once on the `caddy` service Domains field (Coolify can't take custom hostnames from Compose): `https://app.<domain>:80,https://api.<domain>:80,https://git.<domain>:80`. The apex stays on your marketing site.

Tenant subdomains (`<slug>.<domain>`) are fully automatic: the compose file labels a Traefik TCP router that forwards every `*.<domain>` SNI straight to our Caddy on `:443`, and our Caddy mints a per-slug cert on demand (ask-gated by the runner — only live tenant/platform hosts get certs, no wildcard cert or DNS provider involved). One-time prerequisites: `*.<domain>` DNS → the server, and the `traefik.*` labels present on the `caddy` service (verify the `noite-tenants` router in the Traefik dashboard; if Coolify ever drops custom labels, move them to a Raw Compose Deployment). First visit to a new slug pauses a few seconds for issuance; certs persist in `caddy-data`. Fallback if passthrough misbehaves: add `https://<slug>.<domain>:80` per app (exact hostnames use the plain HTTP challenge).
