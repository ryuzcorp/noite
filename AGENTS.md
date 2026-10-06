# AGENTS.md

Ground truth for working on Noite. Read this before touching code — the rules below are the lessons learned the hard way, and the generic Ultracite standards (see [`.claude/CLAUDE.md`](.claude/CLAUDE.md)) are not enough for this repo.

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
- `apps/noite` — Oxide/ilha control UI (passkeys, actions, source-preview, metrics card). Web root is `apps/noite/src`. Layout: `src/http/` is the plain-HTTP layer (`router.ts` + `routes/*` for better-auth, SSE, ingest, R2, internal and health, over `body.ts`/`config.ts`/`sse.ts`/`session.ts`); `src/lib/server/*.server.ts(x)` holds every server-only module (the `.server.` suffix marks an oxidejs action module, and nothing there may import browser code); `src/lib/ui/` holds the shared primitives (dialog, icons, skeletons, load-error, copy-button, avatar); feature folders `src/lib/{admin,account,auth,apps,source,app-detail,storage}/` hold the components; and `src/lib/` at the root is the shared data/pure layer (`resources.ts`, `feeds.ts`, `swr-store.ts`, `runner.ts`, `db.ts`, roles/collaborators).
- `apps/runner` — the Rust runner (deploy, fleets, Caddyfile, metrics). Layering: `src/service/*` is the one implementation behind both transports; the REST handlers in `src/api/*` (route table `src/api/router.rs`, with `src/api/rpc.rs` as the JSON-RPC mirror) decode a request, call a service function and encode its result, and `src/api_error.rs` maps that error onto HTTP or a JSON-RPC error. REST modules never import the RPC module. `src/db/` is the SQLite layer split into cohesive submodules (`apps`, `deploys`, `metrics`, `errors`, `events`, `env`, `credentials`, `compaction`, `alloc`) re-exported through `db/mod.rs`; `src/host/` is the OS/process work — `host/exec.rs` runs sandboxed children (builds, releases, runner-owned tools), `host/s3.rs` is the object store, and `host/metrics/` is the telemetry substrate. Its SQLite shape lives in two idempotent files — `apps/runner/schema.sql` (main DB) and `apps/runner/schema.metrics.sql` (the ATTACHed `metrics` DB) — with installs upgraded by the numbered steps in `schema_version.rs` (see [SPEC: Runner schema evolution](SPEC.md#runner-schema-evolution)). Do not reintroduce `apps/runner/migrations/` or `sqlx::migrate!`.
- `apps/website` — docs site (blume), not part of the runtime.
- `packages/cli` — `@noitenow/cli` (Effect CLI `noite deploy`: CI-built dist over Git smart-HTTP).
- `apps/noite/test` — sample app + `deploy.sh`; also a nested git repo.
- `docker/` — **every Docker artifact lives here**: the one `Dockerfile` (targets `noite` = the release image, the default, and `dev`), its context guard `Dockerfile.dockerignore` (`<Dockerfile>.dockerignore` wins over a context-root `.dockerignore`, and patterns are relative to the repo-root context, so nested paths need `**/`), `install-sidecars.sh`, `dev.sh` (the dev target's command), Compose files (`compose.yaml` = the whole install, pull-only, every variable defaulted, Compose + Coolify via env; `compose.build.yaml` builds it from the tree; `compose.dev.yaml` dev overlay; `compose.e2e.yaml` raw-port test lane), `doctor.sh`, `e2e-local.sh`, `backup.sh`, `restore.sh`, `check-versions.ts` (pin drift guard), and `lib.sh` (the shared helper sourced by the other `docker/*.sh` scripts; `install.sh`/`uninstall.sh` stay self-contained because `run.sh` curls each of them standalone). No `Dockerfile*`/`.dockerignore`/`compose*` may sit outside this directory. `Makefile` at the root.
- `.github/workflows/` — `check.yml` is the reusable gate (`workflow_call`) consumed by `ci.yml` (pull requests) and `images.yml` (before a release image): lint/format, version-pin drift, every compose variant, script parsing, schema idempotency, the CLI bundle. `ci.yml` adds the Rust crate and the worker bundle; `e2e.yml` holds the manual/`v*` container lanes. The `types` job (in `check.yml`, so both callers get it) regenerates the runner→UI bindings and fails on any diff.
- **Runner → UI types are generated** ([ts-rs](https://github.com/Aleph-Alpha/ts-rs)): every Rust struct/enum on the REST boundary carries `#[derive(ts_rs::TS)] #[ts(export)]`, and `cd apps/runner && ~/.cargo/bin/cargo test --locked export_bindings` writes them to `apps/noite/src/lib/runner-types`. `apps/runner/.cargo/config.toml` sets `TS_RS_EXPORT_DIR` (that directory, relative) and `TS_RS_LARGE_INT = "number"` (i64/u64 stay TypeScript `number`), and `apps/noite/src/lib/runner.ts` imports and re-exports the files under the UI's long-standing `Runner*` aliases — UI-only derived shapes (the D1 caps extensions, `D1Cell`/`D1Key`/`D1RowsQuery`, error status, admin stats) stay hand-written there. The directory is generated (never edit it by hand; oxlint/oxfmt ignore it), and CI's `types` job (in `check.yml`) regenerates it and fails on any diff.
- URLs: control UI `http://localhost:9080` (prod `https://app.noite.now` via `CONTROL_SUBDOMAIN=app`; bare `localhost` is the only non-https hostname Bitwarden accepts), runner REST `http://api.localhost:9080`, Git HTTP `http://git.localhost:9080/{slug}`, rustfs S3 `:9000`, console `:9001`, deployed apps `http://{slug}.localhost:9080` (prod `https://{slug}.noite.now`; `app`/`api`/`git` slugs reserved).

| Piece | Role | Owner of what |
| --- | --- | --- |
| rustfs (service) | S3 bucket `noite` (`git/` bundles, `fleets/` tenant celld, `control/` UI worker + its D1, `runner/state/` runner snapshots); optional (`--scale rustfs=0` for your own bucket) | storage |
| runner (PID 1) | bearer-gated REST on `:8080` (`RUNNER_TOKEN`), deploy pipeline, fleet supervisor, child supervisor, `/v1/edge/tls-ask`, Git smart-HTTP, `/ready`; SQLite on `/data`, snapshotted into the bucket | deploy pipeline, tenant fleets, host→port routing and the Caddyfile |
| control (child) | Oxide/ilha UI as celld fleet #0 on `127.0.0.1:8090`; the runner deploys the baked bundle and runs it with the tenant telemetry env (`control/telemetry/...`, ingested as `_control`); every `action` in `lib/server/apps.server.ts` runs **server-side** as RPC — the browser never sees the token | control plane |
| caddy (child) | Caddy 2.10.0 built with `caddy-ratelimit` (xcaddy stage in the Dockerfile) on `:80`/`:443`, admin on `127.0.0.1:2019`, `--watch`; routes platform hosts → control, `api.`/`git.` → runner, `{slug}.` → the tenant port; access logs exist but metrics do **not** come from them | edge (Caddyfile written by the runner) |
| tenant fleets (children) | one celld per app, as uid `fleet` (10020); each app's builds/release commands as its own uid from the reserved build range (10030+); in `multi` an nft egress policy keeps both off loopback and private ranges | tenant code |

## Subsystem contracts (read SPEC first)

SPEC.md is the design record; this file keeps only the operational rules and the lessons that are not in it. Read the linked section before touching that code.

- **Observability / telemetry substrate** — [SPEC: Observability](SPEC.md#observability-the-pricing-substrate): the flush/retention knobs, the `_control` source, compaction, ingest idempotency and error tracking. Never run DuckDB on a request path, and never make an ingest writer additive (a failed pass must not advance the watermark).
- **celld alignment** — [SPEC: celld alignment](SPEC.md#celld-alignment), with the control node in [SPEC: Control UI](SPEC.md#control-ui-fleet-0), the edge in [SPEC: Edge](SPEC.md#edge), isolation in [SPEC: Tenant isolation](SPEC.md#tenant-isolation), runner state in [SPEC: Runner state](SPEC.md#runner-state), limits in [SPEC: Limits](SPEC.md#limits), tenancy in [SPEC: Tenancy mode](SPEC.md#tenancy-mode), boot/stop order in [SPEC: Boot order](SPEC.md#boot-order-the-upgrade-window), releases in [SPEC: Install targets](SPEC.md#install-targets) and operator recovery in [SPEC: Operator recovery](SPEC.md#operator-recovery).
- **Worker code rules** — [SPEC: Worker code rules](SPEC.md#worker-code-rules): nothing crosses requests; isolate-level setup runs once, concurrently-safe; actions are bounded; the control D1 editor is in-process.

Operational do-nots and gotchas not carried by SPEC:

- **Run `make e2e-isolation`** after touching `host/exec.rs`, `deploy.rs`, `netisolation.rs`, `isolation.rs`, `db/alloc.rs` (uid allocation) or the Dockerfile.
- **Testing jup by hand** inside this monorepo walks up to `apps/noite/package.json` (pinned to bun) and refuses other managers: set `JUP_ENABLE_STRICT=0`.
- **Verify a new build shape** with `celld deploy <dir> --bucket s3://x --dry-run` in the image (it lists every refused key) before trusting it; `make e2e` covers Vite through `vite.spec.ts`.
- **Instance telemetry:** never add or rename a field in the `instance_heartbeat` payload without updating [the telemetry docs page](apps/website/docs/self-hosting/telemetry.mdx) in the same change, and never let a test send a real event to PostHog — inject the sender and assert on the built payload.
- **Cutting a release:** move CHANGELOG `Unreleased` under `## [x.y.z] - date` with an `### Operator action required` section, tag `vx.y.z`, try it with `install --pre`, then mark it as a release (which moves the channels).

## Build & verify BEFORE saying done (mandatory)

1. **Runner is the "ryu" dialect** — proc-macro Rust (`impl`, `let … else`, `anyhow::`, `tracing!`, `format!`, `pub async fn`). The lens ryu analyzer accepts a **superset** of what cargo compiles — several builds shipped broken despite "Rust clean". After any change under `apps/runner/src/` run: `cd apps/runner && ~/.cargo/bin/cargo build --release` (cargo lives there, **not** on PATH). Zero errors/warnings = done.
2. **JSX tag balance is NOT validated by the lens** — vite/oxc fails on orphaned/adjacent tags. Re-read the changed block manually after editing `*.tsx`.
3. **Oxide actions**: adding an action without importing its runner helper fails at runtime as `runnerX is not defined`; a plain throw is masked to the client as the generic "Internal error" — throw `fail(message)` (oxidejs `ActionFailure`, always in the generated error schema; `failUnknown` in `lib/auth.ts` maps an unknown catch value) or a declared `Schema.TaggedError` to surface the real message.
4. **Makefile**: keep conditionals in quoted form and avoid `$(if …)` — the repo linter parses Makefile as bash; the inline `# pi-lens-ignore: …` markers and `.pi-lens.json` `rules.*.disable` exist deliberately, do not remove.
5. **The live stack is reachable from this machine**: probe the runner via `curl -H "Host: api.localhost" -H "Authorization: Bearer $RUNNER_TOKEN" http://127.0.0.1:9080/...` (token from `.env`). Local `duckdb` can query fleet telemetry directly (secret setup mirrors `apps/runner/src/host/metrics/plan.rs`).
6. **Baked image**: tools like `duckdb` (1.5.5 on amd64 and arm64; arm64 moved from 1.2.1 on 2026-10-02 — newer tags dropped the aarch64 CLI), `esbuild`, `bun` arrive via `docker/install-sidecars.sh` (takes component args — `esbuild`, `duckdb`, or both); celld and Caddy are `ARG`s in `docker/Dockerfile`, pinned exactly once (`check-versions.ts`). Adding a new binary requires an **image rebuild**, and a `bun add`-less dependency edit requires a manual `bun install` to refresh the lockfile. Do not bump these pins casually.
7. `make dev` rebuild: image changes need `make dev` again (`--force-recreate`); source changes reload by themselves (cargo-watch, vite), except **mount path** changes, which need the container recreated.
8. **Actions are bounded, and must stay that way.** `actions.timeout: 15_000` in `apps/noite/vite.config.ts` answers a stuck action with a JSON-RPC error before the edge's 30 s timeout. The app-detail and admin-page stalls were oxidejs defects on celld, fixed in oxidejs 0.5.6 ([ROADMAP: Design history](ROADMAP.md#design-history), 2026-09-27); those panels still have no UI-level e2e coverage.

## Style expectations from this codebase

### TS / TSX (apps/noite)

- Explicit types; `SAFETY:` comment before any `as unknown as T`.
- Wrap `new URL(...)` (throws on bad input).
- Lowercase `onclick`-style event props (ilha).
- Dynamic `import()` for heavy libs to code-split (Pierre stays dynamic for bundle size; `scule` is static).
- Control UI house rules: icons as JSX components from `lib/ui/icons.tsx`; controlled inputs only (`value`/`checked` + `oninput`/`onchange`, resets via atom writes); shared async data via the SWR hooks in `lib/resources.ts` and live panels via `liveFeed()` in `lib/feeds.ts` (both paint the last snapshot from `lib/swr-store.ts` across remounts and reloads, so skeletons only show on a cold key — gate them on `data() === undefined`, never on `loading()`; persist only what the UI renders, never credentials); URL state through `searchParam`; `ref` callbacks for vanilla libraries; `<Dialog>` (`lib/ui/dialog.tsx`) for modals.
- ilha pitfalls (each shipped as a bug once): (1) components re-run on every parent render, `watch` runs the _latest_ render's callback, `ref` fires only on mount, and `watch.once` runs during render before refs attach — keep DOM handles and other per-instance mutable state in `atom.lazy(makeBox)()`, never in body `let`s, and await refs before touching them; (2) `resource()`/`fromEventSource()` stay bound to their first key/URL in a reused fiber — render route bodies keyed by their params (`<Body key={id} …/>`); (3) the layout never remounts, so every auth change (sign-in, sign-out, impersonation) must call `invalidateSession()` — after the auth call completes — to drop all user-scoped caches and snapshots; (4) never write atoms during render (e.g. seeding form fields from loaded data) — it races ilha's patching; derive the displayed value instead (`draft() ?? loaded`). (5) never let a vanilla library append into an ilha-rendered element — the morph deletes children and attributes the JSX doesn't declare; mount it inside a shadow root you own (`paneIn` in `lib/source/browser.tsx`); (6) a parent re-render detaches and re-attaches reused child subtrees, blurring focus inside them, and ilha can't restore focus inside shadow roots — keep fast-changing state (e.g. a dirty count) out of any ancestor of a focused imperative widget by reading it in a small leaf component.
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

See [`.claude/CLAUDE.md`](.claude/CLAUDE.md) for the Ultracite code standards (formatting, linting, style). The repo commands are `bun run check` (check) and `bun x ultracite fix` (auto-fix).
