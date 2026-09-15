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

| URL                            |                       |
| ------------------------------ | --------------------- |
| http://localhost:9080          | control UI (passkeys) |
| http://api.localhost:9080      | runner API            |
| `http://{slug}.localhost:9080` | deployed apps         |
