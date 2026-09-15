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
| `compose.yaml` | stack |
| `compose.coolify.yaml` | production stack for Coolify (no published edge ports, generated secrets, healthchecks) |
| `compose.byob.yaml` | external-S3 overlay (`make up-byob`), bundled RustFS excluded |

| URL                            |                       |
| ------------------------------ | --------------------- |
| http://localhost:9080          | control UI (passkeys) |
| http://api.localhost:9080      | runner API            |
| `http://{slug}.localhost:9080` | deployed apps         |

## Deploy to Coolify

Point a Docker Compose resource at `compose.coolify.yaml` (repo root, branch `main`). Fill Environment Variables (secrets auto-generate on first parse — just save), attach a wildcard domain (`*.noite.now`) to the `caddy` service (port 80), Deploy. Coolify terminates TLS; Caddy routes `app.`/`api.`/`git.` plus every tenant slug internally. The apex stays on your marketing site.
