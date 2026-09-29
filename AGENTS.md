# AGENTS.md

Ground truth for working on Noite. Read this before touching code — the rules below are the lessons learned the hard way, and the generic Ultracite standards at the bottom are not enough for this repo.

## Project overview

- Noite is a tiny, self-hostable PaaS for [celld](https://celld.dev/) — user accounts, apps, subdomains, and thin deploy/build logs + status. Spec: [SPEC.md](SPEC.md).
- It is a Bun monorepo with two real apps — `apps/runner` (Rust control plane) and `apps/noite` (Oxide/ilha control UI) — plus one disposable sample app under `apps/noite/test/`.
- **One image, one service** (`ghcr.io/<owner>/noite`, `docker/Dockerfile` target `noite`; design in [SPEC.md](SPEC.md)). `tini` → the **Rust runner** (`apps/runner`) as PID 1, which supervises every other process in the container: **Caddy** (the edge; the runner writes its Caddyfile and loads it through the admin API on `127.0.0.1:2019`), the **control UI** (`apps/noite`, Oxide `preset: worker`) as celld fleet #0 on `127.0.0.1:8090` — the image bakes `apps/noite/dist` and the runner deploys it into `s3://<bucket>/control` (revision-gated, vars from the runner's env, `host/control.rs`) — and one celld fleet per tenant app. Storage is one S3 bucket (bundled RustFS or your own) with prefixes `git/`, `fleets/`, `control/` and `runner/state/`. There is no v1 compatibility anywhere: no env aliases, no legacy tables, no migration path.
- Source flows through the runner’s Git smart-HTTP adapter (`http://git.{BASE_DOMAIN}/{slug}`, Basic `git` + profile API key; collaborator-gated) into the same `s3://noite/git/{slug}` tip-bundle layout; deploys are tip `.bundle` → bare mirror + worktree → optional build → deploy into the app's celld fleet → reload. Clients do not need git-remote-s3.

## Build and run

- Install / manage deps with Bun: `bun add <dependency>`. A `bun add`-less dependency edit requires a manual `bun install` to refresh the lockfile (`bun.lock`) — see the pinned-tools warning below. Two lockfiles are load-bearing: root `bun.lock` (lint tooling) + `apps/noite/bun.lock` (UI image + dev `bun install` run inside `apps/noite`) — keep both.
- Run checks before calling a change done:
  - Lint + format: `bun run check` (this is `ultracite check`)
  - Auto-fix: `bun x ultracite fix`
  - UI changes: `cd apps/noite && bun run build` (worker build — proves workerd compat; `check` alone doesn't catch Node/Bun-only imports)
- The stack runs via **rootless podman**:
  - `make up` — the `noite` service built from the tree (`compose.build.yaml`) + `rustfs`; `make up-prod` — same file, pulls the release image; `make dev` — the same service from the Dockerfile's `dev` target with the sources bind-mounted (`docker/dev.sh`: cargo-watch runner + `vite dev` on `127.0.0.1:8090`, where the control fleet would be)
  - `make logs`, `make doctor` (`/ready` and its failing gates, API auth, edge, control auth, celld control node), `make down` (keeps volumes), `make nuke` (every local database: the project's volumes + local `.wrangler` D1/SQLite). `nuke` removes containers by project label and volumes by name as well as via `down -v` because podman-compose's `down -v` aborts on the first missing container and then never removes named volumes — which left the runner's SQLite (every app row) in place and the next `apps.create` answered `409 slug already taken`. BYO S3 installs (`--scale rustfs=0`) keep their objects outside compose: delete them at the provider.
  - `make up`/`make dev` pass `--force-recreate` on purpose: podman-compose does **not** recreate a container whose image changed (`docker compose` does), so an image rebuild would otherwise silently keep the old bytes running.
  - E2E: `make e2e` — boots the prod image in its own compose project (`-p noite-e2e`): control UI through Caddy on :8090, runner API/git :8080, tenants 20000+, rustfs :19000 (`E2E_RUSTFS_PORT`); then runs doctor + Playwright (passkey signup, git push, deploy, tenant serve). Builds the image from the tree by default; `TAG=<short-sha> make e2e` pulls that release from GHCR instead. `make e2e-isolation` is the same lane in `NOITE_TENANCY=multi` plus the hostile-tenant spec (`E2E_HOSTILE=1`). `E2E_KEEP=1` leaves the stack up for debugging. Always fresh: the lane removes its own project's containers and volumes (by label and name) and uses its own `noite-e2e` bucket. Stop the prod/dev stack first (same host ports).
  - `up`/`dev` build with cache every run, so no separate build targets

## Map and architecture in one breath

- **Monorepo, single git repo at the root** — run `git status` / `git diff` at root. Only `apps/noite/test` has a nested repo (sample-app remote).
- `apps/noite` — Oxide/ilha control UI (passkeys, actions, source-preview, metrics card). Web root is `apps/noite/src`.
- `apps/runner` — the Rust runner (deploy, fleets, Caddyfile, metrics). Its SQLite shape lives in ONE idempotent file, `apps/runner/schema.sql`: `include_str!`-embedded in the binary and applied on every boot (`db::connect`), so there is no migration ledger, no ordering, and no checksums. Add tables/changes there with `CREATE ... IF NOT EXISTS`; retire a table with `DROP TABLE IF EXISTS` in the same file. Do not reintroduce `apps/runner/migrations/` or `sqlx::migrate!`.
- `apps/website` — docs site (blume), not part of the runtime.
- `packages/cli` — `@noitenow/cli` (Effect CLI `noite deploy`: CI-built dist over Git smart-HTTP).
- `apps/noite/test` — sample app + `deploy.sh`; also a nested git repo.
- `docker/` — **every Docker artifact lives here**: the one `Dockerfile` (targets `noite` = the release image, the default, and `dev`), its context guard `Dockerfile.dockerignore` (`<Dockerfile>.dockerignore` wins over a context-root `.dockerignore`, and patterns are relative to the repo-root context, so nested paths need `**/`), `install-sidecars.sh`, `dev.sh` (the dev target's command), Compose files (`compose.yaml` = the whole install, pull-only, every variable defaulted, Compose + Coolify via env; `compose.build.yaml` builds it from the tree; `compose.dev.yaml` dev overlay; `compose.e2e.yaml` raw-port test lane), `doctor.sh`, `e2e-local.sh`, `backup.sh`, `restore.sh`, `check-versions.ts` (pin drift guard). No `Dockerfile*`/`.dockerignore`/`compose*` may sit outside this directory. `Makefile` at the root.
- URLs: control UI `http://localhost:9080` (prod `https://app.noite.now` via `CONTROL_SUBDOMAIN=app`; bare `localhost` is the only non-https hostname Bitwarden accepts), runner REST `http://api.localhost:9080`, Git HTTP `http://git.localhost:9080/{slug}`, rustfs S3 `:9000`, console `:9001`, deployed apps `http://{slug}.localhost:9080` (prod `https://{slug}.noite.now`; `app`/`api`/`git` slugs reserved).

| Piece | Role | Owner of what |
| --- | --- | --- |
| rustfs (service) | S3 bucket `noite` (`git/` bundles, `fleets/` tenant celld, `control/` UI worker + its D1, `runner/state/` runner snapshots); optional (`--scale rustfs=0` for your own bucket) | storage |
| runner (PID 1) | bearer-gated REST on `:8080` (`RUNNER_TOKEN`), deploy pipeline, fleet supervisor, child supervisor, `/v1/edge/tls-ask`, Git smart-HTTP, `/ready`; SQLite on `/data`, snapshotted into the bucket | deploy pipeline, tenant fleets, host→port routing and the Caddyfile |
| control (child) | Oxide/ilha UI as celld fleet #0 on `127.0.0.1:8090`; the runner deploys the baked bundle; every `action` in `apps.server.tsx` runs **server-side** as RPC — the browser never sees the token | control plane |
| caddy (child) | Caddy 2.10.0 on `:80`/`:443`, admin on `127.0.0.1:2019`, `--watch`; routes platform hosts → control, `api.`/`git.` → runner, `{slug}.` → the tenant port; access logs exist but metrics do **not** come from them | edge (Caddyfile written by the runner) |
| tenant fleets (children) | one celld per app, as uid `fleet` (10020); builds as uid `build` (10010); in `multi` an nft egress policy keeps both off loopback and private ranges | tenant code |

## Observability (the pricing substrate)

- Fleets run `CELLD_OTEL=1` → celld writes Parquet traces (and logs) to `s3://noite/fleets/{slug}/telemetry/{traces,logs}/...` (bucket sink, no collector), with `CELLD_OTEL_FLUSH_MS` from `RUNNER_OTEL_FLUSH_MS` (30000 — dashboards lag live traffic by up to ~40 s) and `CELLD_OTEL_RETENTION` from `RUNNER_TELEMETRY_RETENTION_DAYS` (14 — one knob driving the fleet prune, the metric-table prune and the query glob floor; small installs can choose 7).
- A short flush REQUIRES the docs' compaction job ("Turn on the compaction job first, then shorten the flush, or queries grow slow within hours"; "celld does not compact its own files"). The runner runs it: `metrics::compact_fleet` (hourly, tick step 3b), for the hour that just ended, per node directory — one DuckDB `COPY (...) TO .../compacted.parquet (FORMAT parquet, COMPRESSION zstd)` ordered by `start_unix_us`, then the source files are deleted. Sources are deleted only after `head-object` proves the compacted file exists, so a failed copy can never lose spans; `union_by_name=true` merges an hour that spans a schema change (the docs call the schema `v0-unstable`). The current hour is never compacted.
- The runner ingests with one **duckdb CLI** invocation per tick over every live fleet: minute buckets in `app_metric`, hourly span stats in `app_span_stat`, new log lines in the `app_log` ring — all in `metrics.sqlite` (attached, not snapshotted). Dashboards (`/metrics`, `/spans`, `/logs`) are SQLite reads; no DuckDB runs on any request path.
- Aggregation lags the flush by 10 s (`AGG_LAG_US` = flush + 10 s): the window stops past the flush interval, so every minute bucket it names has closed and nothing is counted twice across ticks.
- Query globs are hour-scoped: the window names only the hour directories it spans (`telemetry/{kind}/<node>/<yyyy>/<mm>/<dd>/<hh>/…`, node left a wildcard so an earlier node's history still aggregates), never the whole retention — the docs' "a query that reads one day therefore touches only that day's files", and DuckDB opens every file a glob names.
- Reality checks: requests = span `name='celld.fetch'`; errors = `ok` flag; latency/queue = `duration_us`/`queue_wait_us`; CPU = `/proc` process sampling (OTel has no CPU signal).
- Runner restarts resume telemetry aggregation from the persisted watermark (`metric_watermark` in `metrics.sqlite` on `/data`) — history counts from the last flushed metrics tick, not the last restart, so restarting never double-counts and loses at most the spans written since the tick (~one flush interval).
- Never spawn celld for undeployed apps (crash-loops on missing `deploy/current.json` — guard lives in `app/loop_.rs`).
- Keep responses lean: dashboards read persisted aggregates (minute buckets, span stats, log ring) instead of recomputing DuckDB per viewer; only persist what pricing needs plus the bounded log ring.

### celld alignment

The docs are the source of truth for every celld surface: https://celld.dev/docs/. What Noite relies on:

- **Control node** — a runner child (`host/control.rs::spawn_args`, `main.rs::supervise_control`) started with `--bucket s3://<bucket>/control --endpoint <endpoint> --region <region> --listen 127.0.0.1:8090 --internal-listen 0.0.0.0:8091 --advertise <CELLD_ADVERTISE | RAILWAY_PRIVATE_DOMAIN | /etc/hostname>:8091` (the advertise has to be an address a _peer_ can dial: during an overlapping redeploy the new node takes cells over from the old one through it, and a loopback advertise makes it dial itself), plus `CELLD_TRUST_FORWARDED_HEADERS=1` (Caddy forwards the original Host/scheme; without it every link/redirect is wrong), `CELLD_WATCH=/data/control`, `CELLD_DURABILITY=bucket` and `CELLD_SHUTDOWN_TOTAL_MS` inside the runner's stop budget. The operator API on `:8091` is closed to tenant code by the `multi` egress policy, not by the bind. An explicit `--advertise` requires an explicit `--internal-listen` — the docs mandate the pair.
- **Tenant fleets** (spawned by the runner as uid `fleet`) — the same bucket/endpoint/region form with `--listen 0.0.0.0:<port> --internal-listen 127.0.0.1:<port> --advertise 127.0.0.1:<port>`, `CELLD_WATCH` under `/data/fleets` (owned by the fleet uid), `CELLD_DURABILITY=bucket` (a single-node fleet has nobody to send to, so the documented `fleet` default would wait for the bucket anyway), `CELLD_DEPLOY_POLL_S=5` (the documented 30 s default shortened so a push goes live faster — a node adopts a new deployment in place, and `POST /reload` on the internal listener is what the runner calls after `celld deploy`), `CELLD_ESBUILD`, and the telemetry settings above.
- **Removed variables** — celld rejects removed variables at startup (`CELLD_OTEL_SINK`, `CELLD_OUTPUT_GATE`, `CELLD_STORAGE_PROBE`, `CELLD_PACED_HANDOFF`, `CELLD_SHUTDOWN_DRAIN_MS`, …). Noite sets none of them.
- **Isolate-level setup runs once, concurrently-safe.** `ensureDb`'s pass (migrations + schema heal + one-time backfills) is memoized behind an in-flight-aware promise (`apps/noite/src/lib/db.ts`). A `done` flag set _after_ the work is not a guard: every request already in flight on a cold isolate replays the plan — tens of statements each — and celld serves a cell on one thread, so the passes contend for storage instead of overlapping. Measured on a local 0.6.0 node with a cold isolate, 64 concurrent requests: 0.64 s pre-fix vs 0.49 s post-fix. A request waits at most 5 s on a pass another request started, then runs its own: celld drops a request's pending work when the request ends or its client goes away, so a shared pass can be orphaned without ever failing. D1 work is time-bounded (setup 15 s, `withDb` 10 s).
- **Nothing crosses requests in worker code.** No promise, timer or Effect runtime may be shared between requests unless it is registered with `ctx.waitUntil` or its waiters are time-bounded. celld cancels a finished request's pending work, and anything still waiting on it hangs forever with no error. This is what stalled `/__oxide/action` (SPEC, "Control-node request stalls").
- **Compaction** — celld never compacts its own files; the runner does (hourly, the hour just ended, per node directory).
- **Compression** — celld does not compress assets; Caddy does (`encode zstd gzip` on every generated site).
- **Assets** — the `assets` block keys we use are `directory`, `binding` (`ASSETS` — celld does not auto-inject it) and `not_found_handling: single-page-application`; only the accepted top-level `wrangler` keys are allowed, and an unknown key fails the deploy.
- **Asset cache** — `CELLD_ASSET_CACHE_BYTES` bounds each fleet's asset cache (512 MiB default), per fleet on the runner's data volume.
- **`celld dev`** — documented as the local loop, but it bundles the project with raw esbuild and cannot resolve the Oxide plugin's `virtual:oxide/worker` entry, so the control UI is served by `vite dev` in `make dev` and the runner runs as a normal process. This is the one deliberate divergence from the documented dev flow.
- **Fleet check** — `celld diagnose --read-only` is the documented fleet check (node leases, peer probes, advertised addresses); `make doctor` runs it inside the `noite` container (with `--listen 127.0.0.1:0`: diagnose bind-checks a listener of its own, and its default `:8080` is the runner's port), next to `celld node health`.
- **Stop contract** — the docs require the orchestrator's stop grace to exceed the node's shutdown bound. On SIGTERM the runner signals every fleet and the control node at once and waits inside `NOITE_STOP_BUDGET_MS` (25 s; each celld gets a `CELLD_SHUTDOWN_TOTAL_MS` below it), SIGKILLs survivors, stops Caddy (5 s), then writes the final state snapshot. Compose's `stop_grace_period` is 35 s; on Railway set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=35`.
- **Fleet stops** — `supervisor::stop_fleet` sends SIGTERM (`libc::kill`; the documented signal, which lets celld cancel in-flight work, prove durability, release its leases and seal its node log) and waits 15 s before a SIGKILL fallback.
- **Invite-only registration** — the worker D1 gains an `invite` table (code, `createdBy`, `usedBy`, `usedAt`, `revoked`, `note`, `createdAt`); `lib/invites.server.ts` owns mint/redeem/list. The first account to register bootstraps the instance — no code, promoted to `admin` — and every later registration needs a single-use code (`INVITES_PER_USER = 2` codes are minted for each new account on registration). Claiming is one atomic `UPDATE ... WHERE usedBy IS NULL`, so one code admits exactly one account. Members read their own codes on `/account`; admins mint/revoke in `/god-mode`; the signup form only shows the field once `GET /api/invite/status` says the instance is past its first account.
- **Custom domains** — the runner's `app_domain` table (hostname as PRIMARY KEY: one app per hostname) plus `GET/POST /v1/apps/{id}/domains`, `DELETE /v1/apps/{id}/domains/{hostname}` and RPC `domains.list|add|remove`. Validation is `lifecycle.rs::hostname_ok` (lowercase DNS shape, ≥2 labels, no wildcard/IP/port/path); the API refuses platform hostnames (base domain + subdomains + `CONTROL_EXTRA_HOSTS`) and returns 409 when another app holds the name. The Caddyfile writer routes a registered hostname to the app's port only while the app is deployed and running; the on-demand TLS gate (`/v1/edge/tls-ask`) mints a cert only when the hostname exists _and_ its app is live, and the wildcard fallback page resolves custom hosts too. No DNS/TXT verification yet (later hardening).
- **Fleet limits** — one host, many fleets in one cgroup: `RUNNER_FLEET_MAX_RSS_MB` (default 0 = celld's 80% of the container) becomes celld's `CELLD_MAX_RSS_MB`, a container-wide shed threshold because every fleet shares the container's cgroup (never set it per app: 512 closed every fleet's admission once the container passed 512 MB), `RUNNER_FLEET_IDLE_EVICT_S` (120) becomes `CELLD_IDLE_EVICT_S` (idle cells hibernate and give memory back), `RUNNER_FLEET_DEPLOY_POLL_S` (300) becomes `CELLD_DEPLOY_POLL_S` (the runner POSTs /reload after every deploy, so the fleet poll only covers a missed reload), `RUNNER_FLEET_ASSET_CACHE_MB` (64) becomes `CELLD_ASSET_CACHE_BYTES` (per-fleet on-disk asset cache bound; celld's 512 MiB default is unbounded across fleets), `RUNNER_TELEMETRY_RETENTION_DAYS` (14) becomes `CELLD_OTEL_RETENTION` plus the runner-side metric prune and glob floor, `RUNNER_BUILD_CACHE_MB` (512) caps the persistent per-app bun cache at `/data/runner/cache/<slug>/bun` (survives deploys, pruned oldest-first after each deploy, chowned to the build uid, deleted with the app), and `RUNNER_FLEET_LOG` (`error,celld=warn`) is the fleet's own `RUST_LOG`, so celld's runtime warnings/errors reach the per-app log view. **Scale to zero** (SPEC, Scale to zero; `host/sleep.rs`): a sweep every `RUNNER_SLEEP_SWEEP_S` (3600) parks apps with no request for `RUNNER_SLEEP_AFTER_H` (24; 0 disables) — flag `app.asleep_since`, status `sleeping`, `desired_state` untouched — and an asleep app's sites carry a `forward_auth` hop to the public `/v1/edge/wake`, which spawns the fleet and answers only once celld's health route is 200 (≤ `RUNNER_WAKE_TIMEOUT_S`, 120), so Caddy serves the held request (body included) as if the app never slept. The wake route has no active health checks on purpose (their stale "down" state turned the released request into the starting page). `POST /v1/apps/{id}/sleep` parks an app now. Deploys and owner start/stop clear sleep. Per-account quota is `RUNNER_MAX_APPS_PER_USER` (10), enforced in the runner on `apps.create` so an API key cannot bypass it. Rate limiting ships in two layers: better-auth's per-clien…
- **Runner state in the bucket** — `host/state.rs`: the runner SQLite is snapshotted to `runner/state/noite.sqlite.zst` (zstd level 3, skipped when the hash matches the last upload) after changes (`PRAGMA data_version` polling, 10 s debounce, at most once a minute) and on graceful stop, fenced by `runner/state/owner.json` so two runners never overwrite each other. High-churn metric tables live in the attached `metrics.sqlite`, which is never snapshotted (rebuilt from bucket telemetry). On boot with no local database it restores the snapshot (`.zst` first, then the legacy raw key); a not-found starts fresh, any other error fails the boot (an empty database would overwrite the good snapshot).
- **Backup / restore** — `make backup` (`docker/backup.sh`) takes a fresh snapshot (`POST /v1/admin/snapshot`, local + bucket), stops the stack for a quiesced copy, tars `noite-data` and `rustfs-data` into `backups/<UTC stamp>/` (or `DEST=`), writes a `MANIFEST`, and starts again — downtime is the tar time. `make restore FROM=<dir>` (`docker/restore.sh`) is destructive: stop, remove the backed-up volumes, unpack, start, then `make doctor`. Both need an image with `tar` (`NOITE_BACKUP_IMAGE`, else the Noite image on the host).
- **Tenancy** — `NOITE_TENANCY=single|multi` (unset: `multi` off localhost). `multi` = builds as uid `build` with a cleared env, fleets as uid `fleet`, the `host/netisolation.rs` nft table (established/related, DNS, the storage endpoint, then reject loopback/private/metadata for those uids), `/data` private (`isolation::harden_data_dir`), release only with scoped keys. A failed self-check keeps `/ready` at 503 and refuses builds. `make e2e-isolation` is the proof; run it after touching `host/cmd.rs`, `deploy.rs`, `netisolation.rs`, `isolation.rs` or the Dockerfile.
- **Runner schema evolution** — the runner SQLite is one idempotent `schema.sql` applied every boot, so a new **table** just goes in it with `CREATE ... IF NOT EXISTS`. SQLite has no `ADD COLUMN IF NOT EXISTS`, so a new **column** on an existing table must go through `db::ensure_column` (guarded by `pragma_table_info`, a no-op once applied) — columns are _not_ covered by `schema.sql`.

## Build & verify BEFORE saying done (mandatory)

1. **Runner is the "ryu" dialect** — proc-macro Rust (`impl`, `let … else`, `anyhow::`, `tracing!`, `format!`, `pub async fn`). The lens ryu analyzer accepts a **superset** of what cargo compiles — several builds shipped broken despite "Rust clean". After any change under `apps/runner/src/` run: `cd apps/runner && ~/.cargo/bin/cargo build --release` (cargo lives there, **not** on PATH). Zero errors/warnings = done.
2. **JSX tag balance is NOT validated by the lens** — vite/oxc fails on orphaned/adjacent tags. Re-read the changed block manually after editing `*.tsx`.
3. **Oxide actions**: adding an action without importing its runner helper fails at runtime as `runnerX is not defined`; unmapped action exceptions surface to the client as the generic "Internal error" — wrap failures in `failAction(...)` (mapped `ActionError`) to surface the real message.
4. **Makefile**: keep conditionals in quoted form and avoid `$(if …)` — the repo linter parses Makefile as bash; the inline `# pi-lens-ignore: …` markers and `.pi-lens.json` `rules.*.disable` exist deliberately, do not remove.
5. **The live stack is reachable from this machine**: probe the runner via `curl -H "Host: api.localhost" -H "Authorization: Bearer $RUNNER_TOKEN" http://127.0.0.1:9080/...` (token from `.env`). Local `duckdb` can query fleet telemetry directly (secret setup mirrors `app/runner/src/host/metrics.rs`).
6. **Baked image**: tools like `duckdb` (and its per-arch pins: 1.5.5 amd64 / 1.2.1 arm64 — newer tags dropped the aarch64 CLI), `esbuild`, `bun` arrive via `docker/install-sidecars.sh` (takes component args — `esbuild`, `duckdb`, or both); celld and Caddy are `ARG`s in `docker/Dockerfile`, pinned exactly once (`check-versions.ts`). Adding a new binary requires an **image rebuild**, and a `bun add`-less dependency edit requires a manual `bun install` to refresh the lockfile. Do not bump these pins casually.
7. `make dev` rebuild: image changes need `make dev` again (`--force-recreate`); source changes reload by themselves (cargo-watch, vite), except **mount path** changes, which need the container recreated.
8. **Actions are bounded, and must stay that way.** `actions.timeout: 15_000` in `apps/noite/vite.config.ts` answers a stuck action with a JSON-RPC error before the edge's 30 s timeout. The app-detail and `/god-mode` stalls were oxidejs defects on celld, fixed in oxidejs 0.5.6 (SPEC, "Control-node request stalls"); those panels still have no UI-level e2e coverage.

## Style expectations from this codebase

### TS / TSX (apps/noite)

- Explicit types; `SAFETY:` comment before any `as unknown as T`.
- Wrap `new URL(...)` (throws on bad input).
- Lowercase `onclick`-style event props (ilha).
- Dynamic `import()` for heavy libs to code-split (Pierre stays dynamic for bundle size; `scule` is static).
- Control UI house rules: icons as JSX components from `lib/icons.tsx`; controlled inputs only (`value`/`checked` + `oninput`/`onchange`, resets via atom writes); shared async data via the SWR hooks in `lib/resources.ts` and live panels via `liveFeed()` in `lib/feeds.ts` (both paint the last snapshot from `lib/swr-store.ts` across remounts and reloads, so skeletons only show on a cold key — gate them on `data() === undefined`, never on `loading()`; persist only what the UI renders, never credentials); URL state through `searchParam`; `ref` callbacks for vanilla libraries; `<Dialog>` (`lib/dialog.tsx`) for modals.
- ilha pitfalls (each shipped as a bug once): (1) components re-run on every parent render, `watch` runs the _latest_ render's callback, `ref` fires only on mount, and `watch.once` runs during render before refs attach — keep DOM handles and other per-instance mutable state in `atom.lazy(makeBox)()`, never in body `let`s, and await refs before touching them; (2) `resource()`/`fromEventSource()` stay bound to their first key/URL in a reused fiber — render route bodies keyed by their params (`<Body key={id} …/>`); (3) the layout never remounts, so every auth change (sign-in, sign-out, impersonation) must call `invalidateSession()` — after the auth call completes — to drop all user-scoped caches and snapshots; (4) never write atoms during render (e.g. seeding form fields from loaded data) — it races ilha's patching; derive the displayed value instead (`draft() ?? loaded`). (5) never let a vanilla library append into an ilha-rendered element — the morph deletes children and attributes the JSX doesn't declare; mount it inside a shadow root you own (`paneIn` in `lib/source-browser.tsx`); (6) a parent re-render detaches and re-attaches reused child subtrees, blurring focus inside them, and ilha can't restore focus inside shadow roots — keep fast-changing state (e.g. a dirty count) out of any ancestor of a focused imperative widget by reading it in a small leaf component.
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
