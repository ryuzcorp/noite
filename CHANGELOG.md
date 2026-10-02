# Changelog

Noite installs follow releases, not `main`. Pick a channel with `NOITE_IMAGE` (or `NOITE_VERSION` for the installer): `alpha` gets every release, `stable` only final ones, and a version tag (`0.1.0-alpha.1`) holds an install in place. `edge` and short-SHA tags are for CI and rollbacks.

Every release has an **Operator action required** section, even when it is "None". Read it before upgrading: an upgrade restarts the runner and every tenant fleet cold-boots, so batch upgrades.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Operator action required

- None. Tenant fleets and the control node restart on celld 0.6.1 with the upgrade (a rolling update from 0.6.0).

### Changed

- celld 0.6.1: `kv.list()` iterators no longer block later writes, WebSocket messages on one socket no longer wait for the previous handler, and Durable Object facets keep `ctx.id.name`.

### Fixed

- Errors kept tracking `console.error(err)` and rejected `waitUntil` work: celld 0.6.1 moved the log level out of the message into a severity column, and the ingest now reads it.
- Metrics, logs and errors are no longer dropped when any running app had no requests or no log lines in the hour being read. One such app made the whole telemetry pass fail for every app, and the pass was skipped as if there were nothing to read. Rows already skipped are not recovered.
- arm64 images: metrics, logs and errors were never ingested. The image shipped DuckDB 1.2.1, which could not run the ingest query; arm64 now uses 1.5.5 like amd64.

## [0.1.0-alpha.1] - 2026-10-01

First alpha: self-hosted only. There is no cloud version.

### Operator action required

- **Installs that pulled `:latest` must change tag.** `latest` is no longer published; it stops at the last build from `main`. Re-run the installer (it rewrites `NOITE_IMAGE` and keeps your `.env`), or set `NOITE_IMAGE=ghcr.io/ryuzcorp/noite:alpha` yourself (Compose, Coolify, Railway).
- **No database migration needed.** The runner stamps its SQLite with a schema version and the control D1 keeps a migration ledger; both start here. A database written by a newer release is refused at boot with a message, so a downgrade fails loudly instead of corrupting data.
- **Lost-passkey email is now actually sent.** Before this release the `NOITE_EMAIL_WEBHOOK_URL` was not read on the sign-in path, so on a real domain the code was logged by the control UI instead of delivered. If you set a webhook, it starts receiving codes now. With no webhook, recover with `docker exec noite noite-runner recover`.

### Added

- `noite-runner recover [--email <address>]`: prints a one-time sign-in code for the "Lost passkey?" screen, for operators with no email webhook.
- Schema versioning for upgrades without a wipe: `PRAGMA user_version` plus numbered migrations for the runner, a downgrade guard on the control D1 ledger.
- Release channels (`alpha`, `stable`) and version tags; the e2e lanes (`make e2e`, `make e2e-isolation`) gate every release tag.
- `SECURITY.md` and a known-limits page.

### Changed

- God mode: Users, Apps and Invites share one layout and the same search (input and Search button, kept in the URL), so tabs no longer shift.
- Changing an app's slug moved from the Identity card to its Danger Zone.

- Multi-tenant mode is documented as **semi-trusted tenants** for the alpha: see Self-hosting → Known limits.
