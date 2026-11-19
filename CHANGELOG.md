# Changelog

Noite installs follow releases, not `main`. Pick a channel with `NOITE_IMAGE` (or `NOITE_VERSION` for the installer): `alpha` gets every promoted release, `stable` only final ones, and a version tag (`0.2.0-beta.1`) holds an install in place. A release starts as a GitHub pre-release that only `run.sh | bash -s install --pre` installs; marking it as a full release moves the channels. `edge` and short-SHA tags are for CI and rollbacks.

Every release has an **Operator action required** section, even when it is "None". Read it before moving versions: within a lineage, re-running the installer upgrades in place (`.env` and the volumes stay) and every tenant fleet cold-boots behind the edge. Across the 0.2.0 beta reset there is no upgrade: reinstall (see below).

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Operator action required

- **Reinstall: there is no upgrade from any 0.1.0 release (alpha or beta).** The runner refuses a database written before the reset (`refusing to start: this database was written by a Noite release before the 0.2.0 beta reset and cannot be upgraded` — back it up if you need it, wipe the data volume and the bucket prefix, or point at an empty bucket, then install fresh); the control baseline refuses a pre-reset ledger the same way. The installer refuses a `.env` carrying `CELLD_*` or a `NOITE_IMAGE` pinned to `0.1.0-*` with the wipe steps instead of upgrading. Re-create apps after reinstalling. The old history stays in git and in the GitHub releases.
- **`CELLD_*` spellings are gone: the runtime reads `CELLO_*` only.** Any `CELLD_*` left in the environment refuses the boot, naming the `CELLO_*` spelling. `RUNNER_FLEET_LOG`'s default is `error,cello=warn` — an explicit `error,celld=warn` override still boots but matches nothing, so update it to see fleet warnings.

### Changed

- Tenant fleets, the control fleet and every `cello` CLI call run Cello 0.2.0 (image `ghcr.io/ryuzcorp/cello:0.2.0`, pinned by digest). Cello-owned identifiers follow the new spellings throughout (`cello-image:` tags, `cello.*` labels, `cello-r2` metadata, `cello.*` spans, `cello_span` telemetry): error grouping unwraps `cello.*` only, with no `celld.*` fallback. Fleet health stays at `/.well-known/cello/health`.
- The sandbox plane, relay, gateway and engine proxy share one source of truth for Cello's `cello`/`cello-internal` bridges (`cello0`/`cello1`).
- The instance heartbeat payload field is `cello_version`. Dashboards or alerts keyed on the old `celld_version` field name need the new spelling.
