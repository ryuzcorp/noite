# apps/noite — control plane

The Void app behind the Noite UI (`void` + `@ilha/void`): sign-in, app management, and the dashboards for each app. It holds no deploy logic of its own — everything that touches an app (create, deploy, logs, env, storage) is a call to the Rust runner in `apps/runner`, made server-side with `RUNNER_TOKEN` (the browser never sees it).

## What lives where

- **D1 (this app):** better-auth tables, app collaborator grants, invitation codes, and pending collaborator invitations. Nothing else.
- **Runner:** apps, deploys, env vars, domains, events, metrics, storage. `app_collaborator.appId` is a plain key into the runner's store.

## Layout

- `src/pages/` — file-routed UI (Void pages + `defineHead` in `*.server.ts`): apps, app detail, storage browser, account, and the admin home (`/apps`) for instance admins.
- `src/lib/server/` — every server-only module (`*.server.ts(x)`; the `.server.` suffix means server-only): session check, role gate (`requireAppRole`: view < push < admin), then a runner call, exposed to the browser as `POST /api/…` JSON endpoints through `lib/server/api.ts` (`fail` → 422 `{errors}`, plain throws → 500 `Internal error`).
- `src/http/` — plain HTTP layer: `routes/*` for `/api/auth/*` (better-auth), SSE proxies (apps, logs, deploys, events, metrics), machine ingest (`/api/apps/:id/ingest/:kind`, API-key auth), `/internal/git-auth` (runner → UI key check for `git push`), R2 downloads and `/health`; `config.ts`, `body.ts`, `sse.ts` and `session.ts` are its building blocks. `src/routes/` maps the URL space onto it (one file per path, via `routes/_adapter.ts`) and `src/middleware/` holds the route middleware (15 s timeout, pod-host gate, D1 stamp, rate limit).
- `src/lib/` (root) — the shared data/pure layer: `resources.ts` and `feeds.ts` (SWR + SSE), `swr-store.ts`, `live-ref.ts`, `runner.ts`, `auth.ts`/`auth-client.ts`/`db.ts`, `roles.ts`, `collaborators.ts`, `control-app.ts`/`control-env.ts`, `dates.ts`, `errors.ts`, `sleep.ts`, `rate-limit.ts`, `shiki-langs.ts`.
- `src/lib/ui/` — shared primitives: `dialog.tsx`, `icons.tsx`, `skeletons.tsx`, `load-error.tsx`, `copy-button.tsx`, `avatar.tsx`.
- `src/lib/{admin,account,auth,apps,source,app-detail,storage}/` — feature components: `admin/` (the instance-admin Users/Apps/Invites tabs), `account/panel.tsx`, `auth/` (login, onboarding, the `Authed` gate, client session helpers), `apps/` (list + create form, `identity.ts` helpers, control-plane panel), `source/browser.tsx`, `app-detail/` (Overview/Metrics/Errors/Logs/Deploys tabs and `settings/` panels), `storage/` (D1 editor, R2 browser, DO viewer).
- `void.config.ts` / `vite.config.ts` — Void owns the worker entry (`voidPlugin()` builds middleware → routes → pages → assets from `src/`; `voidIlha()` renders pages with ilha) and the post-build `emitCelldConfig` writes the deploy-root `dist/wrangler.json` the runner deploys with celld.
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
