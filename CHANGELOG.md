# Changelog

Noite installs follow releases, not `main`. Pick a channel with `NOITE_IMAGE` (or `NOITE_VERSION` for the installer): `alpha` gets every promoted release, `stable` only final ones, and a version tag (`0.1.0-alpha.1`) holds an install in place. A release starts as a GitHub pre-release that only `run.sh | bash -s install --pre` installs; marking it as a full release moves the channels. `edge` and short-SHA tags are for CI and rollbacks.

Every release has an **Operator action required** section, even when it is "None". Read it before upgrading: an upgrade restarts the runner and every tenant fleet cold-boots, so batch upgrades.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Operator action required

- **`RUNNER_BUILD_UID` and `RUNNER_BUILD_GID` are removed** and ignored if still set: delete them from your environment. Builds and release commands now run as one uid per app from a reserved range, `RUNNER_BUILD_UID_BASE` (default `10030`) and `RUNNER_BUILD_UID_RANGE` (default `1024`). The image pre-creates the default range in `/etc/passwd`; a custom range needs matching `/etc/passwd` and `/etc/group` entries, must stay below 65534 and must not contain `RUNNER_FLEET_UID` (10020).
- **Expect a one-time telemetry replay after the upgrade.** The runner re-reads the stored telemetry for the whole retention window (`RUNNER_TELEMETRY_RETENTION_DAYS`, 30 by default) for every app, to recover the rows the pre-alpha.2 ingest bug skipped. It runs in the background with no downtime; the cost is extra bucket reads and DuckDB CPU in proportion to window × apps. The runner logs `telemetry replay started` and `telemetry replay complete`. Telemetry older than retention was already pruned and cannot be recovered.
- Both databases upgrade themselves: the runner SQLite goes to schema version 4, the control D1 to 1.4.0. As before, an older image refuses newer data, so back up before upgrading.

### Added

- New login page: a product panel ("Push code. Get a URL.", three benefits, a deploy preview) next to a clean sign-in form, in light and dark, with a mobile layout. Sign in is the default tab; a fresh instance opens on "Set up Noite" and says the first account becomes the admin. Lost-passkey recovery is a separate view.
- First-run onboarding: a three-step tour after sign-in (push to deploy, one API key for Git and the CLI, stay in the loop: GitHub releases, Discord, GitHub Sponsors). Story-style progress bars, Back from the second step, arrow keys to move between steps, and a bottom sheet on mobile. The tour never navigates away: steps 1 and 2 spotlight the sidebar's Apps item and your avatar instead (skipped on mobile, where the sidebar is hidden). "Get started", × or Esc ends it for good. Accounts created before this release see it once.
- Admin home: `/apps` lists the control plane ("Noite · admin") for instance admins, and its page holds every admin tool: Overview, Metrics, Errors, Logs, Users, Apps and Invites tabs. Users, Apps and Invites are the panels god mode used, with the same actions and URL-kept searches. `/god-mode` and the account menu's "God Mode" item are removed. The whole page, and every admin action behind it, is refused while impersonating.
- D1 table editor (Storage → D1, and the control database on the Noite admin page):
  - **Layout:** a table list with row counts, a toolbar with search, filters, sort, refresh and Insert, Data and Definition views, and a side panel for editing rows. Paging, sorting, filtering and search run in SQL on the server, so they cover the whole table, not just the first rows.
  - **Row editor:** shows each column's type, primary key, NOT NULL, default and foreign key. NULL and the empty string are separate values, and an insert leaves untouched columns to their defaults. Helpers fill in "Now" timestamps, format JSON and toggle 0/1 columns; a foreign key opens the referenced row.
  - **Editing:** changed fields are highlighted and only they are saved. Delete asks for confirmation inside the panel, rows can be deleted in bulk (1–100 at a time, in one transaction), and a toast confirms every write.
  - **Control database:** read in-process by the control worker, never through `celld d1 execute`.
    - **Masked:** secret columns never leave the worker (session tokens, account passwords and OAuth tokens, verification codes, passkey keys, API keys). They can't be filtered, sorted or searched, so a secret can't be guessed piece by piece.
    - **Read-only:** the auth tables, except that deleting a `session` row revokes it. `user.role` and the ban columns are managed in the Users tab. Tables not explicitly allowed are read-only too.
    - **Your own row:** you can edit it but not delete it.
    - **Links:** a `user` row links to "Manage in Users", an `invite` row to "Manage in Invites".
- R2 browser (Storage → R2):
  - **Browsing:** breadcrumb navigation, folders, search within the current folder, list and column views, and pages of 100.
  - **Details panel:** an image or text preview, type, size, last modified and ETag, plus Download, Copy URL and Delete.
  - **Uploads and folders:** upload files (up to 64 MiB each) and create folders through `celld r2 put`, so an object carries the same record a Worker's `env.BUCKET.put()` writes, and the Worker reads uploads back as-is. Deletes go through `celld r2 delete`, including bulk deletes of up to 100 objects.
  - **Safe previews:** downloads use the object's own content type with `nosniff`, and SVG, HTML and XML are sandboxed.
- Durable Object view in the same style: instance search and a read-only panel showing the state each instance's handler reports, as a key/value table.
- Control-plane insights: the control fleet now writes celld telemetry under `s3://<bucket>/control/telemetry/`, and the runner compacts, ingests, prunes and error-groups it like a tenant app's. Rows are keyed on the reserved `_control` slug with no `app` row, so reconcile, Caddy, scale-to-zero, purge and `GET /v1/apps` never see it. The Noite app page gains Overview, Metrics, Errors and Logs tabs (Logs include the control node's own output); instance admins only, never while impersonating. The numbers include the dashboard's own polling. `noite-runner telemetry reingest --slug _control` replays its window. `make dev` serves the UI from vite, not celld, so the page says telemetry needs the release image instead of showing empty charts.
- Per-app build uid: builds and release commands run as the app's own uid (`app.build_uid`, allocated on its first build), and its worktree and build cache are `0700`. The hostile-tenant e2e suite now checks that a build cannot read a sibling app's worktree or cache.
- `noite-runner telemetry reingest [--since <RFC3339|duration>] [--slug <slug>] [--no-wait] [--timeout <seconds>]`: replay a telemetry window into `metrics.sqlite`, bounded by retention. Safe to repeat.
- `install.sh` warns before an upgrade that recreates the container, and asks once when it has a terminal. `--yes`, `NOITE_YES=1` or `NOITE_CONFIRM=1` skip the prompt; a fresh install, or a re-run whose image did not change, asks nothing.
- Boot-phase log lines with elapsed milliseconds (`tenant fleets booting; control UI deploys next`, `control bundle ready`).
- Docs link in the account menu.
- GitHub Sponsors button on the repository (`.github/FUNDING.yml`).

### Changed

- Telemetry ingest is idempotent and resumable. It works in hour-aligned chunks and replaces each window's minute buckets, span stats, log lines and error buckets instead of adding to them, so a retry, a catch-up after downtime or a replay never counts twice. After downtime the gap is read hour by hour, oldest first, bounded by retention.
- Telemetry ingest isolates a failing app: healthy apps keep aggregating while the broken one retries after a backoff. Apps that stopped (scale-to-zero, crash, runner shutdown) still get their remaining complete hours aggregated.
- Error issue counts are derived from the retained hour buckets, and logged-error capture is capped per app per hour (200) instead of per ingest pass.
- Boot order: signal handling, then Caddy, then every tenant fleet, then the REST listener, and only then the control UI deploy. A release that changes the UI bundle no longer delays tenant apps. Measured locally, 1, 5 and 15 apps all serve again within 5.1 s of the new container starting, and requests during that window are held at the edge, not refused.
- The nft egress policy matches the whole build uid range instead of a single build uid. The image no longer has a shared `build` user. `single` tenancy uses the same per-app uid path.
- Runner D1 API: `storage.d1.get` and its REST route are removed. `storage.d1.{tables,schema,rows,write,delete_rows}` and their REST equivalents under `/v1/apps/{id}/storage/d1/{database_id}/` replace them. Rows are read as JSON (`celld d1 execute --json`), and a write now treats `null` as SQL NULL and `""` as an empty string.
- Runner R2 API: listing takes `prefix` and `cursor` and returns folders plus content types. `PUT …/storage/r2/{bucket}/object?key=` uploads, and `storage.r2.delete` takes 1–100 `keys`.
- `oxidejs` 0.5.10 → 0.6.0, which drops the control UI's workarounds for the old behavior:
  - **Action typing:** the `checkedSchema` cast is gone; the server modules use `withSchema` directly, and the casts around awaited action results are removed.
  - **Errors:** user-facing action errors use oxide's `fail(message)` instead of the in-house `failAction`/`ActionError`, and error display no longer special-cases plain `{ message }` rejections, since action errors now arrive as `Error` objects.
  - **Database setup:** the once-per-isolate setup pass uses oxidejs `isolateOnce` (15 s timeout, 5 s wait) instead of a hand-written promise cache. On the release image it ran once per isolate, 3 passes across about 340 requests.
- Releases go through a pre-release. A `v*` tag publishes the version image and a GitHub pre-release with its CHANGELOG notes, but no longer moves `alpha` or `stable`. `curl -fsSL https://noite.now/run.sh | bash -s install --pre` installs the newest release, pre-releases included, pinned to its version. Marking the pre-release as a full release points `alpha` (and `stable` for a final version) at the same image, so plain installs and upgrades pick it up.
- Docs: the measured upgrade window replaces "about a minute for many apps".

### Fixed

- Two builds running at once could read each other's worktree and build cache, because both ran as uid 10010.
- Rows skipped by the pre-alpha.2 ingest bug are recovered within retention by the one-time replay.
- A failed or partial telemetry pass no longer advances the watermark, one app's failing telemetry no longer stalls every other app, and compaction can no longer double count an hour whose source delete was interrupted.
- The app page's Stop button did nothing. The control UI sent `desired_state` to the runner's `apps.patch`, which reads `desiredState`, so the field was dropped and the patch changed nothing. It now sends the right key, and `apps.patch` refuses unknown parameters, so a mismatch shows an error instead of silently doing nothing.
- Dropdowns stayed open: after clicking an item that navigates, on a click outside them, and on Esc (the D1 Filter and Sort popovers only closed when their own button was clicked again). Every dropdown now closes on an item click, an outside click or Esc.
- A SIGTERM during boot killed the runner outright: fleets were SIGKILLed and the final state snapshot was lost. A stop now stops every fleet inside the stop budget and writes the snapshot at any point in boot.

## [0.1.0-alpha.2] - 2026-10-02

celld 0.6.1 and telemetry ingest fixes.

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
