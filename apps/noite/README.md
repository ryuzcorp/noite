# apps/noite — Oxide control plane (passkeys + actions).

Compose runs this app as the `ui` service. Deploy/runtime ops live in `apps/runner`.

- Passkeys via Better Auth (`/api/auth`)
- App mutations: Oxide `queue` → `workflow` → Rust runner
- Status refresh: Oxide `schedule` (`* * * * *`) → `sync-apps` workflow
- Bun fetch mode uses `src/lib/bun-durable.ts` bindings (same APIs as celld/CF)

```bash
# from repo root
make up    # or make dev
```
