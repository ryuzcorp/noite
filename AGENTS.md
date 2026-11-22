# AGENTS.md

Ground truth for working on Noite. Read this before touching code — the rules below are the lessons learned the hard way, and the generic Ultracite standards ([`.claude/CLAUDE.md`](.claude/CLAUDE.md)) are not enough.

This file holds only what every session needs. Everything else is a page, read on demand:

| Before touching | Read |
| --- | --- |
| anything — what lives where, the pieces, URLs | [docs/agents/architecture.md](docs/agents/architecture.md) |
| the local stack, `make` targets, probing the runner | [docs/agents/local-stack.md](docs/agents/local-stack.md) |
| e2e lanes, suites, isolation coverage | [docs/agents/e2e.md](docs/agents/e2e.md) |
| PRs, review, merge queue, stacks | [docs/agents/merging.md](docs/agents/merging.md) |
| a release, tags, npm publish | [docs/agents/release.md](docs/agents/release.md) |
| image pins, baked tools | [docs/agents/pins.md](docs/agents/pins.md) |
| TS/TSX, ilha, islands, Void actions | [docs/agents/frontend-style.md](docs/agents/frontend-style.md) |
| runner Rust, REST shapes, schema | [docs/agents/runner.md](docs/agents/runner.md) |
| state machines, transitions | [docs/agents/state-machines.md](docs/agents/state-machines.md) |
| tests, changelog fragments | [docs/agents/testing.md](docs/agents/testing.md) |
| telemetry, preview environments, SPEC contracts | [docs/agents/subsystems.md](docs/agents/subsystems.md) |

## Project overview

- Noite is a tiny, self-hostable PaaS for [Cello](https://cello.ryuz.eu/) — user accounts, apps, subdomains, and thin deploy/build logs + status. Spec: [SPEC.md](SPEC.md).
- Bun monorepo, one image, one service: `tini` → the Rust runner (`apps/runner`) as PID 1, supervising Caddy (edge), the control UI (`apps/noite`, Cello fleet #0) and one Cello fleet per tenant app; one S3 bucket holds `git/`, `fleets/`, `envs/`, `control/`, `runner/state/`. There is no v1 compatibility anywhere: no env aliases, no legacy tables, no migration path.
- Deploys: tip `.bundle` → bare mirror + worktree → optional build → the app's Cello fleet → reload.
- Layout: [architecture.md](docs/agents/architecture.md). Design: [SPEC.md](SPEC.md).

## Build and verify BEFORE saying done (mandatory)

- Install / manage deps with Bun: `bun add <dependency>`. A `bun add`-less dependency edit requires a manual `bun install` to refresh the lockfile (`bun.lock`) — see the pinned-tools warning below. Two lockfiles are load-bearing: root `bun.lock` (lint tooling) + `apps/noite/bun.lock` (UI image + dev `bun install` run inside `apps/noite`) — keep both.
- Run checks before calling a change done:
  - Lint + format: `bun run check` (this is `ultracite check`)
  - Auto-fix: `bun x ultracite fix`
  - UI changes: `cd apps/noite && bun run build` (worker build — proves workerd compat; `check` alone doesn't catch Node/Bun-only imports).
  - Pre-push gate: `bun docker/pr-ready.ts` (runs every local gate for the changed areas — lint, runner/UI builds and tests, changelog + version pins, `merge-tree` conflict check — then prints a summary table; `--skip-build` skips the UI bundle build)
- **Runner is the "ryu" dialect**: after any change under `apps/runner/src/` run `cd apps/runner && ~/.cargo/bin/cargo fmt && ~/.cargo/bin/cargo build --release` (cargo lives there, **not** on PATH). Zero errors/warnings = done. Details: [runner.md](docs/agents/runner.md).
- **JSX tag balance is NOT validated by the lens** — re-read the changed block manually after editing `*.tsx`.
- **Void JSON actions**: import the runner helper for every action; throw `fail(message)` or a declared `Schema.TaggedError`, never a plain throw (masked as the generic 500 "Internal error"). Details: [frontend-style.md](docs/agents/frontend-style.md).
- **Makefile**: keep conditionals in quoted form and avoid `$(if …)` — the repo linter parses Makefile as bash; the inline `# pi-lens-ignore: …` markers and `.pi-lens.json` `rules.*.disable` exist deliberately, do not remove.
- `make dev` rebuild: image changes need `make dev` again (`--force-recreate`); source changes reload themselves (cargo-watch, vite), except **mount path** changes, which need the container recreated.
- **Actions are bounded, and must stay that way**: `src/middleware/01-timeout.ts` (15 s JSON 504; `*/stream`, `/storage/*`, `*/archive` exempt) bounds a stuck action before the edge's 30 s timeout. Never remove it.
- Never import a Node builtin (`node:` or bare) in page-reachable code — server-only work lives behind a server-only module (`bun docker/check-client-node-imports.ts` enforces it).
- Do not bump baked-image pins casually; adding a tool means an image rebuild. Procedure: [pins.md](docs/agents/pins.md).
- Runner↔UI: the runner returns raw JSON objects, never a `{ body }` envelope — do not unwrap `.body`. Schema changes go through `schema.sql`/`schema.metrics.sql` and `schema_version.rs`; do not reintroduce `apps/runner/migrations/` or `sqlx::migrate!`. Details: [runner.md](docs/agents/runner.md).

## Merging

- **One push per review round.** Each push restarts CI (~5 min) and strips `security-reviewed`; collect every finding (CodeRabbit, security review, CI), fix them all, push once. CodeRabbit reviews once at ready; ask `@coderabbitai review` only after a substantial change.
- **Order:** CI green and every thread answered or resolved → independent security review and `security-reviewed` (when the gate asks) → merge queue. Never start the security review against a red or still-moving PR.
- **CodeRabbit is advisory**: don't wait for it (the free tier stops at "Review limit reached"). A late valid finding is a roadmap candidate, unless release-blocking — a security, isolation or data-integrity defect is fixed before it ships.
- Open PRs as drafts; mark ready only when the report is written. Merge only on green (`ci-ok` + `security-gate`), through a squash merge queue.
- **~800 changed lines per PR**, excluding lockfiles, generated bindings and `changelog.d/`. Split bigger items: dependent layers as a GitHub stack, independent items as parallel PRs. Never stack unrelated items.
- Local e2e only reproduces a failure; don't pre-flight PRs with it. The one local run CI cannot replace is the release-image smoke test (`TAG=<short-sha> make e2e`). Details: [e2e.md](docs/agents/e2e.md), [merging.md](docs/agents/merging.md).
- If a push starts no `pull_request` run within two minutes, close/reopen the PR or `gh workflow run ci.yml --ref <branch> -f suite=release`.
- `merge_group` runs never skip by paths and never cancel each other or a PR's run.
- `.github/security-paths.yml`: touching a listed path fails `security-gate` until a reviewer, never the change's author, adds `security-reviewed`; every push strips it. Relabel after a pure rebase only once `git range-diff` shows the PR's own commits unchanged. Details: [merging.md](docs/agents/merging.md).

## Subsystem invariants

Read the linked SPEC section before touching that code ([subsystems.md](docs/agents/subsystems.md) has the full index):

- Telemetry: never read Parquet on a request path, and never make an ingest writer additive.
- Preview environments: an environment deploy must never write the app's fleet columns, bucket or `last_deploy_sha`; an environment's storage starts empty — never seed it from production. Never add or rename an `instance_heartbeat` field without updating the telemetry docs page, and never let a test send a real event to PostHog.
- If you are unsure how a change affects the deploy pipeline, fleet isolation, the Caddyfile owner invariant, or the metrics substrate, ask rather than guessing — these are the subsystems that break silently.

## State machines

Every lifecycle is one closed type with one transition point. Never compare status strings or combine flags to infer a state: read the type and branch exhaustively. Adding a variant updates its transition table/diagram and its table test in the same change. Persisted state is written only by guarded writers that report `Applied`/`Refused`, never by an unconditional `SET status`. A stale async answer is refused by a token, epoch or generation in the state, never by a "still mounted" flag. Table: [state-machines.md](docs/agents/state-machines.md).

## Agent behavior

- Tests must catch real, consumer-visible bugs: no retries, no wall-clock sleeps — flakes are bugs, fix them at the root. Every fix gets a fail-before test where a test can express it. Details: [testing.md](docs/agents/testing.md).
- Prefer small, focused changes; split a large diff into reviewable steps.
- Release notes go in `changelog.d/<unique-topic>.md`, one file per PR, never under `## [Unreleased]`; add an `### Operator action required` bullet when an operator must act. `bun docker/check-changelog.ts` enforces it.
- Run `bun run check` and (for runner code) the cargo build before declaring done — automatic formatting/lint is not a substitute for the ryu build.
- If an instruction would change a locked decision in `SPEC.md`, remove a deliberate ignore marker, or alter a baked-image pin, pause and ask for explicit confirmation first.

---

See [`.claude/CLAUDE.md`](.claude/CLAUDE.md) for the Ultracite standards; `bun run check` checks, `bun x ultracite fix` fixes.
