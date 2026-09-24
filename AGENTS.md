# AGENTS.md

Ground truth for working on Noite. Read this before touching code — the rules below are the lessons learned the hard way, and the generic Ultracite standards at the bottom are not enough for this repo.

## Project overview

- Noite is a tiny, self-hostable PaaS for [celld](https://celld.dev/) — user accounts, apps, subdomains, and thin deploy/build logs + status. Spec: [SPEC.md](SPEC.md).
- It is a Bun monorepo with two real apps — `apps/runner` (Rust control plane) and `apps/noite` (Oxide/ilha control UI) — plus one disposable sample app under `apps/noite/test/`.
- The control plane is **Oxide Worker UI on a celld fleet** (`apps/noite`, `preset: worker`) + **Rust runner as the `noite-control` container cell** (a Rust binary can't be a worker; worker `RunnerContainer` DO owns host→port routing; Caddyfile is static). Every tenant app runs as its own celld fleet (prefix + keys); storage is a RustFS S3 bucket `s3://noite` with prefixes `git/`, `fleets/` and `control/`; edge is Caddy.
- Source flows through the runner’s Git smart-HTTP adapter (`http://git.{BASE_DOMAIN}/{slug}`, Basic `git` + profile API key; collaborator-gated) into the same `s3://noite/git/{slug}` tip-bundle layout; deploys are tip `.bundle` → bare mirror + worktree → optional build → `celld deploy` → reload. Clients do not need git-remote-s3.

## Build and run

- Install / manage deps with Bun: `bun add <dependency>`. A `bun add`-less dependency edit requires a manual `bun install` to refresh the lockfile (`bun.lock`) — see the pinned-tools warning below. Two lockfiles are load-bearing: root `bun.lock` (lint tooling) + `apps/noite/bun.lock` (UI image + dev `bun install` run inside `apps/noite`) — keep both.
- Run checks before calling a change done:
  - Lint + format: `bun run check` (this is `ultracite check`)
  - Auto-fix: `bun x ultracite fix`
  - UI changes: `cd apps/noite && bun run build` (worker build — proves workerd compat; `check` alone doesn't catch Node/Bun-only imports)
- The stack runs via **rootless podman**:
  - `make up` — production stack (release images: rustfs, control, caddy; runner is a container cell); `make dev` — dev processes on the 4-service layout (bind-mounts, cargo-watch, `vite dev`)
  - `make logs`, `make down` (keeps volumes), `make nuke` (volumes + local `.wrangler` D1/SQLite)
  - E2E (manual pre-release, no CI): `TAG=<short-sha> make e2e` — boots the prod stack from those exact GHCR bytes (images workflow tags; control service + runner cell both pull, nothing builds), deploys the worker (`celld deploy dist` from inside control), `make doctor` (5 min), then Playwright. Needs `127.0.0.1 api.localhost git.localhost e2e.localhost` in /etc/hosts. No test-only app code: passkeys use a CDP virtual authenticator, fixed slug `e2e`.
  - `up`/`dev` build with cache every run, so no separate build targets

## Map and architecture in one breath

- **Monorepo, single git repo at the root** — run `git status` / `git diff` at root. Only `apps/noite/test` has a nested repo (sample-app remote).
- `apps/noite` — Oxide/ilha control UI (passkeys, actions, source-preview, metrics card). Web root is `apps/noite/src`.
- `apps/runner` — the Rust runner (deploy, fleets, Caddyfile, metrics).
- `apps/website` — docs site (blume), not part of the runtime.
- `packages/cli` — `@noitenow/cli` (Effect CLI `noite deploy`: CI-built dist over Git smart-HTTP).
- `apps/noite/test` — sample app + `deploy.sh`; also a nested git repo.
- `docker/` — image definitions + entrypoints + Compose files (`docker/compose.yaml` universal for compose + Coolify via env, `docker/compose.dev.yaml`, `docker/compose.byob.yaml`; `docker/standalone.ts` single-file generator, `docker/check-versions.ts` pin drift guard); release compose ships as the `compose-standalone` CI artifact. `Makefile` at the root.
- URLs: control UI `http://localhost:9080` (prod `https://app.noite.now` via `CONTROL_SUBDOMAIN=app`; bare `localhost` is the only non-https hostname Bitwarden accepts), runner REST `http://api.localhost:9080`, Git HTTP `http://git.localhost:9080/{slug}`, rustfs S3 `:9000`, console `:9001`, deployed apps `http://{slug}.localhost:9080` (prod `https://{slug}.noite.now`; `app`/`api`/`git` slugs reserved).

| Piece | Role | Owner of what |
| --- | --- | --- |
| rustfs | S3 bucket `noite` (`git/` bundles, `fleets/` tenant celld, `control/` snapshot) + webhook → runner | storage |
| runner | bearer-gated REST (`RUNNER_TOKEN`, in `.env`; current `dev-agent-token`), deploy pipeline, fleet supervisor, `/v1/edge/routes` table, `/v1/sync/*` relay API (`:18080`) + loopback S3 sidecar in container mode | container cell; host→port routing owned by the worker DO; durability relayed into R2 (`RUNNER_SNAP`), telemetry stays sidecar-local |
| ui | Oxide/ilha; every `action` in `apps.server.tsx` runs **server-side** as RPC — the browser never sees the token | control plane |
| caddy | static wildcard edge → `control:8090` for every vhost (worker Host-dispatches); access logs exist but metrics do **not** come from them | edge |

## Observability (the pricing substrate)

- Fleets run `CELLD_OTEL=1` → celld writes Parquet traces to `s3://noite/fleets/{slug}/telemetry/traces/...` (bucket sink, no collector).
- The runner aggregates with the **duckdb CLI** → minute buckets in `app_metric` → `GET /v1/apps/{id}/metrics|spans`.
- Reality checks: requests = span `name='celld.fetch'`; errors = `ok` flag; latency/queue = `duration_us`/`queue_wait_us`; CPU = `/proc` process sampling (OTel has no CPU signal).
- Runner restarts resume telemetry aggregation from the persisted watermark (`metric_watermark` in the relayed SQLite snapshot) — history counts from the last relay export, not the last restart. (Fresh sidecars still lose spans written since the last metrics tick; the tick runs every ~10 s so the gap is seconds.)
- Never spawn celld for undeployed apps (crash-loops on missing `deploy/current.json` — guard lives in `app/loop_.rs`).
- Keep responses lean: on-demand DuckDB reads in endpoints (e.g. `/spans`) instead of persisted aggregates when data is cheap to recompute; only persist what pricing needs (`app_metric` minute buckets).

## Build & verify BEFORE saying done (mandatory)

1. **Runner is the "ryu" dialect** — proc-macro Rust (`impl`, `let … else`, `anyhow::`, `tracing!`, `format!`, `pub async fn`). The lens ryu analyzer accepts a **superset** of what cargo compiles — several builds shipped broken despite "Rust clean". After any change under `apps/runner/src/` run: `cd apps/runner && ~/.cargo/bin/cargo build --release` (cargo lives there, **not** on PATH). Zero errors/warnings = done.
2. **JSX tag balance is NOT validated by the lens** — vite/oxc fails on orphaned/adjacent tags. Re-read the changed block manually after editing `*.tsx`.
3. **Oxide actions**: adding an action without importing its runner helper fails at runtime as `runnerX is not defined`; unmapped action exceptions surface to the client as the generic "Internal error" — wrap failures in `failAction(...)` (mapped `ActionError`) to surface the real message.
4. **Makefile**: keep conditionals in quoted form and avoid `$(if …)` — the repo linter parses Makefile as bash; the inline `# pi-lens-ignore: …` markers and `.pi-lens.json` `rules.*.disable` exist deliberately, do not remove.
5. **The live stack is reachable from this machine**: probe the runner via `curl -H "Host: api.localhost" -H "Authorization: Bearer $RUNNER_TOKEN" http://127.0.0.1:9080/...` (token from `.env`). Local `duckdb` can query fleet telemetry directly (secret setup mirrors `app/runner/src/host/metrics.rs`).
6. **Baked images**: tools like `duckdb` (and its per-arch pins: 1.5.5 amd64 / 1.2.1 arm64 — newer tags dropped the aarch64 CLI), `esbuild`, `bun` arrive via `docker/install-sidecars.sh` (shared by both Dockerfiles + railpack; celld stays a per-file ARG). Adding a new binary requires an **image rebuild**, and a `bun add`-less dependency edit requires a manual `bun install` to refresh the lockfile. Do not bump these pins casually.
7. `make dev` rebuild: image changes need `up -d --force-recreate runner ui`; source-only changes still need the runner container recreated when **mount paths** change.

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
