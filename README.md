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

Point a Docker Compose resource at `docker/compose.coolify.yaml` (repo root, branch `main`). In Environment Variables, set the required `BASE_DOMAIN` (secrets auto-generate — just save); `BETTER_AUTH_URL` / `GIT_PUBLIC_BASE` derive from it unless overridden. Deploy: Coolify auto-provisions a generated domain for the `caddy` service and the runner serves the control UI on it. Coolify terminates TLS; Caddy routes `app.`/`api.`/`git.` plus every tenant slug internally. Add real domains later; the apex stays on your marketing site.
