# Changelog

Noite installs follow releases, not `main`. Pick a channel with `NOITE_IMAGE` (or `NOITE_VERSION` for the installer): `alpha` gets every promoted release, `stable` only final ones, and a version tag (`0.2.0-beta.1`) holds an install in place. A release starts as a GitHub pre-release that only `run.sh | bash -s install --pre` installs; marking it as a full release moves the channels. `edge` and short-SHA tags are for CI and rollbacks.

Every release has an **Operator action required** section, even when it is "None". Read it before moving versions: within a lineage, re-running the installer upgrades in place (`.env` and the volumes stay) and every tenant fleet cold-boots behind the edge. Across the 0.2.0 beta reset there is no upgrade: reinstall (see below).

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

<!-- Pending release notes live in ## [Unreleased] directly; new notes go in changelog.d/<topic>.md and the release PR assembles both with `bun docker/changelog-release.ts`. -->

## [0.2.0-beta.1] - 2026-11-20

### Operator action required

- **Reinstall: there is no upgrade from any 0.1.0 release (alpha or beta).** The runner refuses a database written before the reset (`refusing to start: this database was written by a Noite release before the 0.2.0 beta reset and cannot be upgraded` — back it up if you need it, wipe the data volume and the bucket prefix, or point at an empty bucket, then install fresh); the control baseline refuses a pre-reset ledger the same way. The installer refuses a `.env` carrying `CELLD_*` or a `NOITE_IMAGE` pinned to `0.1.0-*` with the wipe steps instead of upgrading. Re-create apps after reinstalling. The old history stays in git and in the GitHub releases.
- **`CELLD_*` spellings are gone: the runtime reads `CELLO_*` only.** A `.env` carrying `CELLD_*` is refused by the installer; a stale `CELLD_*` left in the runner env is ignored. `RUNNER_FLEET_LOG`'s default is `error,cello=warn` — an explicit `error,celld=warn` override still boots but matches nothing, so update it to see fleet warnings.

### Changed

- Tenant fleets, the control fleet and every `cello` CLI call run Cello 0.2.3 (image `ghcr.io/ryuzcorp/cello:0.2.3`, pinned by digest). Cello-owned identifiers follow the new spellings throughout (`cello-image:` tags, `cello.*` labels, `cello-r2` metadata, `cello.*` spans, `cello_span` telemetry): error grouping unwraps `cello.*` only, with no `celld.*` fallback. Fleet health stays at `/.well-known/cello/health`.
- The sandbox plane, relay, gateway and engine proxy share one source of truth for Cello's `cello`/`cello-internal` bridges (`cello0`/`cello1`).
- The instance heartbeat payload field is `cello_version`. Dashboards or alerts keyed on the old `celld_version` field name need the new spelling.
- Cello 0.2.0 → 0.2.3 makes app WebSockets and streamed bodies memory-safe:
  - App WebSockets are now backpressure-safe. When a peer or app stops reading, the socket ends with close code 1011 at a 16 MiB backlog per direction, instead of growing host memory.
  - A WebSocket message is capped at 32 MiB, Cloudflare's limit. Past it, the socket closes with 1009. A single message up to the cap still passes.
  - A peer close that cuts a send short reports `wasClean: false`.
  - An app that reads one `tee()` copy of a fetched, RPC, Durable Object or R2 body to the end before the other no longer hangs. The copies buffer for each other up to 32 MiB per request. Past that, the lagging copy's read fails instead of growing host memory.

### Fixed

- Live views stay live: the app page's status badge, logs, events and every other streamed feed kept their connection open but stopped receiving updates about 30 seconds after the page loaded, so a Stop or Start only showed after a reload. Cello 0.2.3 no longer charges a streamed response to the post-response background budget. A stream that makes no progress for 60 seconds now ends instead of hanging; Noite's feeds send a keepalive every 15 seconds.
- The app page's status badge no longer wedges on a stale Stop/Start transition. A superseded app-row fetch used to overwrite the shared snapshot while its paint was dropped, so the next state-stream frame matched the stale snapshot and invalidated nothing; and a failed row refetch kept the old value with no recovery. The snapshot now moves with its paint (only the latest reload writes it), and the app row and environments refetch with a bounded retry, so every delivered frame converges the badge without polling.
- The runner's reconcile tick spawns due fleets before stopping parked ones in the same pass. Stops still complete within the pass, but a start no longer waits behind an unrelated fleet's full SIGTERM drain: under parallel Stop/Start churn the start spawned a whole slow drain late and its health gate never opened inside the UI's budget.
- The runner's reconcile tick stops all desired-stopped fleets concurrently instead of awaiting each SIGTERM drain one by one. Under load, several draining fleets used to serialize the whole tick, so an unrelated fleet's start waited behind stops it had nothing to do with and its health gate never opened in time.
