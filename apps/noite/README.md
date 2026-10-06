# apps/noite — control plane

The Oxide app behind the Noite UI: sign-in, app management, and the dashboards for each app. It holds no deploy logic of its own — everything that touches an app (create, deploy, logs, env, storage) is a call to the Rust runner in `apps/runner`, made server-side with `RUNNER_TOKEN` (the browser never sees it).

## What lives where

- **D1 (this app):** better-auth tables, app collaborator grants, invitation codes, and pending collaborator invitations. Nothing else.
- **Runner:** apps, deploys, env vars, domains, events, metrics, storage. `app_collaborator.appId` is a plain key into the runner's store.

## Layout

- `src/pages/` — file-routed UI (`@ilha/router`): apps, app detail, storage browser, account, and the admin home (`/apps`) for instance admins.
- `src/lib/server/` — every server-only module (`*.server.ts(x)`; the `.server.` suffix marks an oxidejs action module): session check, role gate (`requireAppRole`: view < push < admin), then a runner call.
- `src/http/` — plain HTTP layer: `router.ts` and `routes/*` for `/api/auth/*` (better-auth), SSE proxies (apps, logs, deploys, events, metrics), machine ingest (`/api/apps/:id/ingest/:kind`, API-key auth), `/internal/git-auth` (runner → UI key check for `git push`), R2 downloads and `/health`; `config.ts`, `body.ts`, `sse.ts` and `session.ts` are its building blocks.
- `src/lib/` (root) — the shared data/pure layer: `resources.ts` and `feeds.ts` (SWR + SSE), `swr-store.ts`, `live-ref.ts`, `runner.ts`, `auth.ts`/`auth-client.ts`/`db.ts`, `roles.ts`, `collaborators.ts`, `control-app.ts`/`control-env.ts`, `dates.ts`, `errors.ts`, `sleep.ts`, `rate-limit.ts`, `shiki-langs.ts`.
- `src/lib/ui/` — shared primitives: `dialog.tsx`, `icons.tsx`, `skeletons.tsx`, `load-error.tsx`, `copy-button.tsx`, `avatar.tsx`.
- `src/lib/{admin,account,auth,apps,source,app-detail,storage}/` — feature components: `admin/` (the instance-admin Users/Apps/Invites tabs), `account/panel.tsx`, `auth/` (login, onboarding, the `Authed` gate, client session helpers), `apps/` (list + create form, `identity.ts` helpers, control-plane panel), `source/browser.tsx`, `app-detail/` (Overview/Metrics/Errors/Logs/Deploys tabs and `settings/` panels), `storage/` (D1 editor, R2 browser, DO viewer).
- `src/worker.ts` / `src/server.ts` / `src/client.ts` — Wrangler entry (middleware → actions → server entry → assets), the Oxide server entry, and the client mount.
- `src/lib/auth.ts` — better-auth wiring: passkeys, email-code recovery (sign-in only, never creates accounts), API keys, admin plugin. Registration is invite-only after the first account.

## Access model

- Sign-up: the first account bootstraps the instance (and is its admin); every later one needs an invitation code.
- Per app: `view`, `push`, `admin` grants. Creators get an `admin` grant and can be removed like anyone else while another admin remains. Instance admins can manage every app from the admin home.
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
