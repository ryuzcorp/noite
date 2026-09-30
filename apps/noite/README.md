# apps/noite — control plane

The Oxide app behind the Noite UI: sign-in, app management, and the dashboards for each app. It holds no deploy logic of its own — everything that touches an app (create, deploy, logs, env, storage) is a call to the Rust runner in `apps/runner`, made server-side with `RUNNER_TOKEN` (the browser never sees it).

## What lives where

- **D1 (this app):** better-auth tables, app collaborator grants, invitation codes, and pending collaborator invitations. Nothing else.
- **Runner:** apps, deploys, env vars, domains, events, metrics, storage. `app_collaborator.appId` is a plain key into the runner's store.

## Layout

- `src/pages/` — file-routed UI (`@ilha/router`): apps, app detail, storage browser, account, god mode (instance admin).
- `src/lib/*.server.ts(x)` — Oxide actions: session check, role gate (`requireAppRole`: view < push < admin), then a runner call.
- `src/worker.ts` — thin Wrangler entry re-exporting `virtual:oxide/worker` (middleware → actions → server entry → assets).
- `src/server.ts` — Oxide server entry; serves the routes in `src/http/routes.ts`.
- `src/http/routes.ts` — plain HTTP routes: `/api/auth/*` (better-auth), SSE proxies (apps, logs, deploys, events, metrics), machine ingest (`/api/apps/:id/ingest/:kind`, API-key auth), `/internal/git-auth` (runner → UI key check for `git push`), R2 downloads, `/health`.
- `src/lib/auth.ts` — better-auth: passkeys, email-code recovery (sign-in only, never creates accounts), API keys, admin plugin. Registration is invite-only after the first account.

## Access model

- Sign-up: the first account bootstraps the instance (and is its admin); every later one needs an invitation code.
- Per app: `view`, `push`, `admin` grants. Creators get an `admin` grant and can be removed like anyone else while another admin remains. Instance admins can manage every app from god mode.
- Env var values are write-only for everyone except app admins (`.dev.vars` download); `FLAG_*` toggles are the one non-secret exception.

## Develop

```bash
# from the repo root
make up    # or make dev
```

```bash
bun run test        # unit tests (bun test)
bun run test:e2e    # Playwright against a running stack (see e2e/)
```

`/health` reports the build id (git sha, stamped by `vite build`).
