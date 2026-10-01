# Changelog

Noite installs follow releases, not `main`. Pick a channel with `NOITE_IMAGE` (or `NOITE_VERSION` for the installer): `alpha` gets every release, `stable` only final ones, and a version tag (`0.1.0-alpha.1`) holds an install in place. `edge` and short-SHA tags are for CI and rollbacks.

Every release has an **Operator action required** section, even when it is "None". Read it before upgrading: an upgrade restarts the runner and every tenant fleet cold-boots, so batch upgrades.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
