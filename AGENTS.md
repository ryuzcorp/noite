# AGENTS.md

Ground truth for working on Noite. Read this before touching code — the rules below are the lessons learned the hard way, and the generic Ultracite standards at the bottom are not enough for this repo.

## Project overview

- Noite is a tiny, self-hostable PaaS for [celld](https://celld.dev/) — user accounts, apps, subdomains, and thin deploy/build logs + status. Spec: [SPEC.md](SPEC.md).
- It is a Bun monorepo with two real apps — `apps/runner` (Rust control plane) and `apps/noite` (Oxide/ilha control UI) — plus one disposable sample app under `apps/noite/test/`.
- The control plane is **Oxide Worker UI on a celld node** (`apps/noite`, `preset: worker`) + **Rust runner as a plain compose service** (`apps/runner`, image from `Dockerfile.runner-container`). The UI image bakes the built worker bundle (`apps/noite/dist`) and its entrypoint deploys it into `s3://<bucket>/control` on first boot (revision-gated, vars patched from the container env); the edge is stock upstream Caddy with a Caddyfile the runner writes. Every tenant app runs as its own celld fleet (prefix + keys); storage is a RustFS S3 bucket `s3://noite` with prefixes `git/`, `fleets/` and `control/`.
- Source flows through the runner’s Git smart-HTTP adapter (`http://git.{BASE_DOMAIN}/{slug}`, Basic `git` + profile API key; collaborator-gated) into the same `s3://noite/git/{slug}` tip-bundle layout; deploys are tip `.bundle` → bare mirror + worktree → optional build → deploy into the app's celld fleet → reload. Clients do not need git-remote-s3.

## Build and run

- Install / manage deps with Bun: `bun add <dependency>`. A `bun add`-less dependency edit requires a manual `bun install` to refresh the lockfile (`bun.lock`) — see the pinned-tools warning below. Two lockfiles are load-bearing: root `bun.lock` (lint tooling) + `apps/noite/bun.lock` (UI image + dev `bun install` run inside `apps/noite`) — keep both.
- Run checks before calling a change done:
  - Lint + format: `bun run check` (this is `ultracite check`)
  - Auto-fix: `bun x ultracite fix`
  - UI changes: `cd apps/noite && bun run build` (worker build — proves workerd compat; `check` alone doesn't catch Node/Bun-only imports)
- The stack runs via **rootless podman**:
  - `make up` — production stack (builds both images from the tree: `rustfs`, `runner`, `control`, `caddy`); `make up-prod` — same file, pulls the release images; `make dev` — dev processes on the same 4-service layout (bind-mounts, cargo-watch, `vite dev`)
  - `make logs`, `make doctor` (stack up, runner healthy + reconciled, API auth, rustfs live, control UI serving), `make down` (keeps volumes), `make nuke` (every local database: the project's volumes + local `.wrangler` D1/SQLite). `nuke` removes the volumes by name as well as via `down -v` because podman-compose's `down -v` aborts on the first missing container and then never removes named volumes — which left the runner's SQLite (every app row) in place and the next `apps.create` answered `409 slug already taken`. External-S3 installs (BYOB overlay) keep their objects outside compose: delete them at the provider.
  - `make up`/`make dev` pass `--force-recreate` on purpose: podman-compose does **not** recreate a container whose image changed (`docker compose` does), so an image rebuild would otherwise silently keep the old bytes running.
  - E2E (manual pre-release, no CI): `make e2e` — boots the full prod topology in its own compose project (`-p noite-e2e`), raw localhost:ports, no Caddy: rustfs :9000, runner API/git :8080 (+ tenants 81xx), control UI :8090; then runs doctor + Playwright (passkey signup, git push, deploy, tenant serve). Builds both images from the tree by default; `TAG=<short-sha> make e2e` pulls those release images from GHCR instead (the only path that needs GHCR). Always fresh: the lane's own project owns its named volumes and its `noite-e2e` bucket, and `down -v` at lane start can only remove those — dev/prod storage lives in a different project. Stop the prod/dev stack first (same host ports).
  - `up`/`dev` build with cache every run, so no separate build targets

## Map and architecture in one breath

- **Monorepo, single git repo at the root** — run `git status` / `git diff` at root. Only `apps/noite/test` has a nested repo (sample-app remote).
- `apps/noite` — Oxide/ilha control UI (passkeys, actions, source-preview, metrics card). Web root is `apps/noite/src`.
- `apps/runner` — the Rust runner (deploy, fleets, Caddyfile, metrics). Its SQLite shape lives in ONE idempotent file, `apps/runner/schema.sql`: `include_str!`-embedded in the binary and applied on every boot (`db::connect`), so there is no migration ledger, no ordering, and no checksums. Add tables/changes there with `CREATE ... IF NOT EXISTS`; retire a table with `DROP TABLE IF EXISTS` in the same file. Do not reintroduce `apps/runner/migrations/` or `sqlx::migrate!`.
- `apps/website` — docs site (blume), not part of the runtime.
- `packages/cli` — `@noitenow/cli` (Effect CLI `noite deploy`: CI-built dist over Git smart-HTTP).
- `apps/noite/test` — sample app + `deploy.sh`; also a nested git repo.
- `docker/` — image definitions + entrypoints + Compose files: `compose.yaml` (the whole install, compose + Coolify via env), `compose.dev.yaml` (dev overlay), `compose.byob.yaml` (external-S3 overlay), `compose.e2e.yaml` (raw-port test lane), `doctor.sh`, `e2e-local.sh`, `control-dev.sh`, `runner-dev.sh`, `noite-entrypoint.sh`, `install-sidecars.sh`, `check-versions.ts` (pin drift guard), `Dockerfile.runner-dev`, `Dockerfile.tools`, `Dockerfile.ui` (the runner image builds from `Dockerfile.runner-container` at the repo root). `standalone.ts`, `compose.standalone.yaml`, `Dockerfile.caddy`, `Caddyfile.static` and `railpack.json` are deleted. `Makefile` at the root.
- URLs: control UI `http://localhost:9080` (prod `https://app.noite.now` via `CONTROL_SUBDOMAIN=app`; bare `localhost` is the only non-https hostname Bitwarden accepts), runner REST `http://api.localhost:9080`, Git HTTP `http://git.localhost:9080/{slug}`, rustfs S3 `:9000`, console `:9001`, deployed apps `http://{slug}.localhost:9080` (prod `https://{slug}.noite.now`; `app`/`api`/`git` slugs reserved).

| Piece | Role | Owner of what |
| --- | --- | --- |
| rustfs | S3 bucket `noite` (`git/` bundles, `fleets/` tenant celld, `control/` UI worker + its D1) | storage |
| runner | bearer-gated REST (`RUNNER_TOKEN`, in `.env`), deploy pipeline, fleet supervisor, `/v1/edge/tls-ask`, Git smart-HTTP; talks straight to `S3_ENDPOINT` (`rustfs:9000`) | deploy pipeline, tenant fleets, host→port routing and the Caddyfile |
| control | Oxide/ilha UI on a celld node; the image bakes `apps/noite/dist` and the entrypoint self-deploys it; every `action` in `apps.server.tsx` runs **server-side** as RPC — the browser never sees the token | control plane |
| caddy | stock `caddy:2.10.0-alpine`, config reloaded by `--watch`; routes platform hosts → control, `api.`/`git.` → runner, `{slug}.` → the tenant port; access logs exist but metrics do **not** come from them | edge (Caddyfile written by the runner) |

## Observability (the pricing substrate)

- Fleets run `CELLD_OTEL=1` → celld writes Parquet traces (and logs) to `s3://noite/fleets/{slug}/telemetry/{traces,logs}/...` (bucket sink, no collector), with `CELLD_OTEL_FLUSH_MS=5000` (the docs' near-live value) and `CELLD_OTEL_RETENTION=14d`.
- A short flush REQUIRES the docs' compaction job ("Turn on the compaction job first, then shorten the flush, or queries grow slow within hours"; "celld does not compact its own files"). The runner runs it: `metrics::compact_fleet` (hourly, tick step 3b), for the hour that just ended, per node directory — one DuckDB `COPY (...) TO .../compacted.parquet (FORMAT parquet, COMPRESSION zstd)` ordered by `start_unix_us`, then the source files are deleted. Sources are deleted only after `head-object` proves the compacted file exists, so a failed copy can never lose spans; `union_by_name=true` merges an hour that spans a schema change (the docs call the schema `v0-unstable`). The current hour is never compacted.
- The runner aggregates with the **duckdb CLI** → minute buckets in `app_metric` → `GET /v1/apps/{id}/metrics|spans`.
- Aggregation lags the flush by 10 s (`AGG_LAG_US`): the window stops at `now - 10 s`, past the 5 s flush, so every minute bucket it names has closed and nothing is counted twice across ticks.
- Query globs are day-scoped: the window names only the day directories it spans (`telemetry/{kind}/<node>/<yyyy>/<mm>/<dd>/…`, node left a wildcard so an earlier node's history still aggregates), never the whole retention — the docs' "a query that reads one day therefore touches only that day's files", and DuckDB opens every file a glob names.
- Reality checks: requests = span `name='celld.fetch'`; errors = `ok` flag; latency/queue = `duration_us`/`queue_wait_us`; CPU = `/proc` process sampling (OTel has no CPU signal).
- Runner restarts resume telemetry aggregation from the persisted watermark (`metric_watermark` in the runner SQLite on `runner-data`) — history counts from the last flushed metrics tick, not the last restart, so restarting never double-counts and loses at most the spans written since the tick (~10 s).
- Never spawn celld for undeployed apps (crash-loops on missing `deploy/current.json` — guard lives in `app/loop_.rs`).
- Keep responses lean: on-demand DuckDB reads in endpoints (e.g. `/spans`) instead of persisted aggregates when data is cheap to recompute; only persist what pricing needs (`app_metric` minute buckets).

### celld alignment

The docs are the source of truth for every celld surface: https://celld.dev/docs/. What Noite relies on:

- **Control node** — started with `--bucket s3://<bucket>/control --endpoint <endpoint> --region <region> --listen 0.0.0.0:8090 --internal-listen 0.0.0.0:8091 --advertise 127.0.0.1:8091`, plus `CELLD_TRUST_FORWARDED_HEADERS=1` (Caddy forwards the original Host/scheme; without it every link/redirect is wrong) and `CELLD_WATCH=/data/control`. An explicit `--advertise` requires an explicit `--internal-listen` — the docs mandate the pair.
- **Tenant fleets** (spawned by the runner) — the same bucket/endpoint/region form with `--listen 0.0.0.0:<port> --internal-listen 0.0.0.0:<port> --advertise 127.0.0.1:<port>`, `CELLD_WATCH` in the runner's data volume, `CELLD_DURABILITY=bucket` (a single-node fleet has nobody to send to, so the documented `fleet` default would wait for the bucket anyway), `CELLD_DEPLOY_POLL_S=5` (the documented 30 s default shortened so a push goes live faster — a node adopts a new deployment in place, and `POST /reload` on the internal listener is what the runner calls after `celld deploy`), `CELLD_ESBUILD`, and the telemetry settings above.
- **Removed variables** — celld rejects removed variables at startup (`CELLD_OTEL_SINK`, `CELLD_OUTPUT_GATE`, `CELLD_STORAGE_PROBE`, `CELLD_PACED_HANDOFF`, `CELLD_SHUTDOWN_DRAIN_MS`, …). Noite sets none of them.
- **Compaction** — celld never compacts its own files; the runner does (hourly, the hour just ended, per node directory).
- **Compression** — celld does not compress assets; Caddy does (`encode zstd gzip` on every generated site).
- **Assets** — the `assets` block keys we use are `directory`, `binding` (`ASSETS` — celld does not auto-inject it) and `not_found_handling: single-page-application`; only the accepted top-level `wrangler` keys are allowed, and an unknown key fails the deploy.
- **Asset cache** — `CELLD_ASSET_CACHE_BYTES` bounds each fleet's asset cache (512 MiB default), per fleet on the runner's data volume.
- **`celld dev`** — documented as the local loop, but it bundles the project with raw esbuild and cannot resolve the Oxide plugin's `virtual:oxide/worker` entry, so the control UI is served by `vite dev` in `make dev` and the runner runs as a normal process. This is the one deliberate divergence from the documented dev flow.
- **Fleet check** — `celld diagnose --read-only` is the documented fleet check (node leases, peer probes, advertised addresses); `make doctor` runs it inside the control container, next to `celld node health`.
- **Stop contract** — the docs require the orchestrator's stop grace to exceed the node's shutdown bound, so the control service sets `CELLD_SHUTDOWN_TOTAL_MS=25000` and a compose `stop_grace_period: 30s` (verified: SIGTERM stops the node in ~10 s, no SIGKILL).
- **Fleet stops** — `supervisor::stop_fleet` sends SIGTERM (the documented signal `docker stop`/`systemctl stop` send, which lets celld cancel in-flight work, prove durability, release its leases and seal its node log) and waits 15 s before a SIGKILL fallback. The image has no `/bin/kill`, so the signal goes through `/bin/sh -c`.
- **Invite-only registration** — the worker D1 gains an `invite` table (code, `createdBy`, `usedBy`, `usedAt`, `revoked`, `note`, `createdAt`); `lib/invites.server.ts` owns mint/redeem/list. The first account to register bootstraps the instance — no code, promoted to `admin` — and every later registration needs a single-use code (`INVITES_PER_USER = 2` codes are minted for each new account on registration). Claiming is one atomic `UPDATE ... WHERE usedBy IS NULL`, so one code admits exactly one account. Members read their own codes on `/profile`; admins mint/revoke in `/god-mode`; the signup form only shows the field once `GET /api/invite/status` says the instance is past its first account.
- **Custom domains** — the runner's `app_domain` table (hostname as PRIMARY KEY: one app per hostname) plus `GET/POST /v1/apps/{id}/domains`, `DELETE /v1/apps/{id}/domains/{hostname}` and RPC `domains.list|add|remove`. Validation is `lifecycle.rs::hostname_ok` (lowercase DNS shape, ≥2 labels, no wildcard/IP/port/path); the API refuses platform hostnames (base domain + subdomains + `CONTROL_EXTRA_HOSTS`) and returns 409 when another app holds the name. The Caddyfile writer routes a registered hostname to the app's port only while the app is deployed and running; the on-demand TLS gate (`/v1/edge/tls-ask`) mints a cert only when the hostname exists _and_ its app is live, and the wildcard fallback page resolves custom hosts too. No DNS/TXT verification yet (later hardening).
- **Fleet limits** — one host, many fleets, so memory is metered per tenant fleet: `RUNNER_FLEET_MAX_RSS_MB` (default 512) becomes celld's `CELLD_MAX_RSS_MB` (at the ceiling celld sheds cells with 503 + `Retry-After` instead of the runner container OOM-ing every other app), `RUNNER_FLEET_IDLE_EVICT_S` (300) becomes `CELLD_IDLE_EVICT_S` (idle cells hibernate and give memory back), and `RUNNER_FLEET_LOG` (`error,celld=warn`) is the fleet's own `RUST_LOG`, so celld's runtime warnings/errors reach the per-app log view. Per-account quota is `RUNNER_MAX_APPS_PER_USER` (10), enforced in the runner on `apps.create` so an API key cannot bypass it. Rate limiting ships in two layers: better-auth's per-client budget for `/api/auth/*` (`NOITE_AUTH_RATE_LIMIT`, 600/min, keyed on the proxy-forwarded client address) and a worker-side platform limiter (`NOITE_RATE_LIMIT_RPM`, 600/min per route class `auth`/`invite`) that answers 429 + `Retry-After` before the request reaches better-auth or D1 (`0` disables either). The raw-port e2e lane has no proxy, so every request shares one bucket and the lane raises both budgets.
- **Backup / restore** — `make backup` (`docker/backup.sh`) takes a `VACUUM INTO` snapshot of the runner SQLite (`POST /v1/admin/snapshot`, beside the live file in the data volume), stops the stack for a quiesced copy, tars every data volume (`rustfs-data`, `runner-data`, `control-state`, `caddy-config`, `caddy-data`) into `backups/<UTC stamp>/` (or `DEST=`), writes a `MANIFEST`, and starts again — downtime is the tar time. `make restore FROM=<dir>` (`docker/restore.sh`) is destructive: stop, remove the backed-up volumes, unpack, start, then `make doctor`. Both need an image with `tar` (`NOITE_BACKUP_IMAGE`, else the runner image).
- **Runner schema evolution** — the runner SQLite is one idempotent `schema.sql` applied every boot, so a new **table** just goes in it with `CREATE ... IF NOT EXISTS`. SQLite has no `ADD COLUMN IF NOT EXISTS`, so a new **column** on an existing table must go through `db::ensure_column` (guarded by `pragma_table_info`, a no-op once applied) — columns are _not_ covered by `schema.sql`.

## Build & verify BEFORE saying done (mandatory)

1. **Runner is the "ryu" dialect** — proc-macro Rust (`impl`, `let … else`, `anyhow::`, `tracing!`, `format!`, `pub async fn`). The lens ryu analyzer accepts a **superset** of what cargo compiles — several builds shipped broken despite "Rust clean". After any change under `apps/runner/src/` run: `cd apps/runner && ~/.cargo/bin/cargo build --release` (cargo lives there, **not** on PATH). Zero errors/warnings = done.
2. **JSX tag balance is NOT validated by the lens** — vite/oxc fails on orphaned/adjacent tags. Re-read the changed block manually after editing `*.tsx`.
3. **Oxide actions**: adding an action without importing its runner helper fails at runtime as `runnerX is not defined`; unmapped action exceptions surface to the client as the generic "Internal error" — wrap failures in `failAction(...)` (mapped `ActionError`) to surface the real message.
4. **Makefile**: keep conditionals in quoted form and avoid `$(if …)` — the repo linter parses Makefile as bash; the inline `# pi-lens-ignore: …` markers and `.pi-lens.json` `rules.*.disable` exist deliberately, do not remove.
5. **The live stack is reachable from this machine**: probe the runner via `curl -H "Host: api.localhost" -H "Authorization: Bearer $RUNNER_TOKEN" http://127.0.0.1:9080/...` (token from `.env`). Local `duckdb` can query fleet telemetry directly (secret setup mirrors `app/runner/src/host/metrics.rs`).
6. **Baked images**: tools like `duckdb` (and its per-arch pins: 1.5.5 amd64 / 1.2.1 arm64 — newer tags dropped the aarch64 CLI), `esbuild`, `bun` arrive via `docker/install-sidecars.sh` (takes component args — `esbuild`, `duckdb`, or both — and is shared by three Dockerfiles; celld stays a per-file ARG). Adding a new binary requires an **image rebuild**, and a `bun add`-less dependency edit requires a manual `bun install` to refresh the lockfile. Do not bump these pins casually.
7. `make dev` rebuild: image changes need `up -d --force-recreate runner control`; source-only changes still need the runner container recreated when **mount paths** change.
8. **KNOWN ISSUE — the celld control node stalls app-detail and `/god-mode` actions.** Under the celld deployment, the app-detail pages and `/god-mode` never finish loading: their server actions never return, so the Settings/Overview panels and the admin panel stay on their loading skeleton. Measured on the e2e lane: the worker isolate is idle while the browser waits; the routes (`/api/auth/get-session`, `/api/invite/status`, the document) answer in ~3 ms; the action layer starts executing (`findApp` reads the app from the runner, the raw-SQL admin check completes) and then a _second_ D1 read inside the same action never resolves — e.g. `withDb(orm.app_collaborator.findFirst(...))` after `withDb(isUserAdminById(...))`. Restarting the control node clears it until the next page load. It reproduces on pages the previous e2e suite never visited, i.e. it is **pre-existing**, not introduced by the invite/domain work; the same code paths work in `make dev` (vite/workerd). Consequences: those panels are **uncovered by tests** — do not claim they work — and the e2e lane pins their features (invites, domains, env, lifecycle) at the API/DB layer instead. Working hypotheses: a D1 session/layer per `withDb` call, or the builder-vs-raw-SQL split. Full entry with the diagnosis is in [SPEC.md](SPEC.md).

## Style expectations from this codebase

### TS / TSX (apps/noite)

- Explicit types; `SAFETY:` comment before any `as unknown as T`.
- Wrap `new URL(...)` (throws on bad input).
- Lowercase `onclick`-style event props (ilha).
- Dynamic `import()` for non-ilha libs so SSR stays safe.
- `for…of` over `.forEach()`; `i += 1` over `i++`; arrows over `function` forms; prefer early `return` and non-nested ternaries.
- Buttons: `btn-sm` everywhere — no other size modifiers (`btn-xs`/`btn-md`/`btn-lg`/`btn-xl`).

### Runner (ryu, apps/runner)

- Positional `format!("...{}")`; prefer `let … else` over `?` in expressions; untyped closures in iterator chains (`.filter(|a| …)`; serde `rename_all = "camelCase"` for JSON.

### Runner REST responses (the `runnerFetch` contract)

- The runner returns **raw JSON objects, never a `{ body }` envelope**. `GET /v1/apps/{id}` → `{"id":…,"slug":…}`; `git-remote`, `{tree,blob,diff}`, `metrics|spans` all follow the same direct shape. Do not unwrap `.body` — that yields `undefined`, and the calling action throws an unmapped error the client shows as the generic "Internal error" (a classic silent regression when refactoring for lint). `runnerFetch<T>` casts the parsed JSON straight to `T`.

## Agent behavior

- Prefer small, focused changes. When a PR-like diff is large this repo expects the work to be split into reviewable steps.
- Run `bun run check` and (for runner code) the cargo build before declaring done — automatic formatting/lint is not a substitute for the ryuer build.
- If an instruction would change a locked decision in `SPEC.md`, remove a deliberate ignore marker, or alter a baked-image pin, pause and ask for explicit confirmation first.
- If you are unsure how a change affects the deploy pipeline, fleet isolation, the Caddyfile owner invariant, or the metrics substrate, ask rather than guessing — these are the subsystems that break silently.

## Tips

For UI tasks refer to: https://ilha.build/llms.txt and https://context7.com/websites/daisyui/llms.txt?tokens=10000. For back end and API tasks refer to: https://oxide.build/llms.txt

---

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun x ultracite fix`
- **Check for issues**: `bun run check` (alias for `bun x ultracite check`)
- **Diagnose setup**: `bun x ultracite doctor`

Oxlint + Oxfmt (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers — extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions — don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully — don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**

- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**

- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**

- Use `class` and `for` attributes (not `className` or `htmlFor`)

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests — use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat — avoid excessive `describe` nesting

## When Oxlint + Oxfmt Can't Help

Oxlint + Oxfmt's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** — Oxlint + Oxfmt can't validate your algorithms
2. **Meaningful naming** — Use descriptive names for functions, variables, and types
3. **Architecture decisions** — Component structure, data flow, and API design
4. **Edge cases** — Handle boundary conditions and error states
5. **User experience** — Accessibility, performance, and usability considerations
6. **Documentation** — Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Oxlint + Oxfmt. Run `bun x ultracite fix` before committing to ensure compliance.
