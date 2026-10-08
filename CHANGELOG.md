# Changelog

Noite installs follow releases, not `main`. Pick a channel with `NOITE_IMAGE` (or `NOITE_VERSION` for the installer): `alpha` gets every promoted release, `stable` only final ones, and a version tag (`0.1.0-alpha.1`) holds an install in place. A release starts as a GitHub pre-release that only `run.sh | bash -s install --pre` installs; marking it as a full release moves the channels. `edge` and short-SHA tags are for CI and rollbacks.

Every release has an **Operator action required** section, even when it is "None". Read it before upgrading: an upgrade restarts the runner and every tenant fleet cold-boots, so batch upgrades.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Operator action required

- The runner SQLite upgrades itself to schema version 7 (the import source on `app`, plus the pull request and branch protection tables). As before, an older image refuses newer data, so back up before upgrading.
- **GitHub imports and templates need outbound HTTPS from the runner to `github.com`.** Only `https://github.com/<owner>/<repo>` is ever fetched, redirects are not followed, and each import is capped at 500 MiB and 10 minutes. Instances without internet access can still create blank apps and push.
- **Runner REST API callers:** `POST /v1/apps/{id}/source/commit` takes `actor` (`{ userId, name }`) instead of an `author` email, and `GET /v1/apps/{id}/diff` (RPC `source.diff`) is removed; see Changed and Removed.

### Added

- New app creator (`/apps/new`), with three ways to start:
  - **Blank:** as before.
  - **Import from GitHub:** a public repository URL and an optional branch. The repo is copied once, full history included, as `main`, and Noite's copy is the source of truth from then on. The app shows "Importing" while it clones, then deploys. A failed import shows the error, with Retry and Delete.
  - **Template:** "Oxide + Ilha" and "TanStack Start" start from a single "Initial commit from …" commit. Both deploy and serve on Noite (TanStack Start with SSR and hydration).
  - The slug is prefilled from the repo or template name.
- Push to create: `git push` to a slug that doesn't exist yet creates the app, with you as admin and counted against your app limit, then deploys it. The push prints the app's URL. Reserved or invalid slugs answer "repository not found", and an account at its limit gets a clear refusal. Fetching an unknown slug is still a 404.
- Branches and history on the Source page, which now has a single bar: the back link and branch picker on the left; History and Changes on the right. Each opens a side panel that takes a third of the width (`?panel=history|changes`).
  - **Branch picker:** a dropdown that lists every branch, with how far each is ahead of or behind `main` and a compare link. Admins can delete branches from it. A branch creator at the bottom branches off the browsed ref and switches to the new branch. Any branch, tag or commit can be browsed via `?ref=`.
  - **History panel:** the commits of the browsed ref, or only those of the open file.
  - **Commit page:** metadata, changed files with line counts, and the diff.
  - **Compare:** two refs, with their commits, files, diff and whether they merge cleanly. Deploys link to their commit.
  - **Browser edits** work on an empty repository. Other branches are read-only in the browser. The Changes button counts the edited files, and its panel shows each edit as a diff, with a form to push them all as one commit: a message (default `Web edit: <paths>`), the target (`main`, or a new branch, after which the panel links to a pull request) and Push. When `main` is protected, only a new branch is offered (see below).
- Pull requests, for same-repo branches:
  - **Pages:** pull requests are called "pulls" in the UI and have their own pages, opened from the app's **Pulls** item in the sidebar, which shows the open count. The list (`/apps/{id}/pulls`) filters open, closed and merged pulls; its title repeats the open count and carries "New pull" (`/apps/{id}/pulls/new`). Each pull is at `/apps/{id}/pulls/{number}`. Open one from the Compare page or after pushing browser edits to a new branch. The pull page has a Conversation tab (description, comments, reviews) and a Files tab where you comment on a diff line. When later commits change that line, the comment is marked "Outdated" and stays in the conversation.
  - **Reviews:** anyone with push access, except the author, can approve or request changes. A new push to the branch dismisses approvals given on older commits.
  - **Squash merge:** one commit on the base branch, authored by the PR's author, which deploys when the base is `main`. You can delete the branch afterwards. A PR with conflicts can't be merged and lists the conflicting files; fix them locally and push.
  - **Branch protection** (Settings, admin only, off by default): "Require a pull" keeps the push role off `main` (git push, browser edits and branch deletes), and "Required approvals" (0–2) gates merging. Admins bypass both. With protection on, the Changes panel only pushes to a new branch.
  - Commits Noite makes (merges, browser edits, templates) use `<user id>@users.noreply.<domain>`, never your email.
- MCP server for agents at `POST /mcp` (stateless Streamable HTTP). Agents authenticate with a `noite_` API key as a Bearer token and act as that account with its permissions.
  - **Tools:**
    - apps: `list_apps`, `get_app`, `list_templates`, `create_app` (blank, GitHub or template; same app limit as the UI)
    - deploys and runtime: `deploy_status`, `deploy_log`, `app_logs`, `app_errors`
    - env vars: `env_list` (secrets masked), `env_set`, `env_unset`
    - repo: `repo_branches`, `repo_tree`, `repo_file`, `repo_log`, `repo_commit`
  - **Setup:** `/account` has a "Connect an agent" block with copyable setup for Claude Code, Cursor and Codex.
- Sidebar app list: on the apps pages (`/apps`, an app's pages, its storage editors, the create page), your apps (and the Noite admin home, for instance admins) are listed below **Apps** at the same level, each with a status dot where an icon would be, live as apps are created, renamed or deleted. The app you are on expands into **App** (its overview, tabs and storage), **Code** (Code mode) and **Pulls** (with the open count), and the one you are in is highlighted; the Noite admin home has neither and is highlighted itself. The **Code** button left the app header.
- Runner API:
  - `apps.create` takes a `source` (`blank`, or `git` with `url`, `ref` and `squash`); new `apps.retry_import` / `POST /v1/apps/{id}/retry-import`.
  - Forge: `git.refs`, `git.log`, `git.commit`, `git.compare`, `git.branch_create`, `git.branch_delete`, under `/v1/apps/{id}/git/…`. `source.tree` and `source.blob` take `ref`.
  - Pull requests: `prs.*` and `branch_rules.*`, under `/v1/apps/{id}/pull_requests` and `/v1/apps/{id}/branch_rules`.
- **Code intelligence in the browser editor.** Opening a TypeScript or JavaScript file in Code mode now runs a real TypeScript language service in a web worker (started on first use, so the editor's main bundle never carries the compiler) over the repo's own sources at the ref you are browsing plus the declarations captured from the app's last successful build:
  - Errors and warnings appear as inline markers, re-checked shortly after you stop typing, using the repo's `tsconfig.json` (ESNext/bundler defaults when it has none).
  - Resting the pointer on a symbol for 0.3 s shows its type, highlighted like the editor, with its JSDoc underneath. Diagnostic popovers wait the same 0.3 s. **Cmd/Ctrl+click** jumps to its definition in the repo, and a definition that lives in `node_modules` shows its highlighted declaration in place, read-only.
  - Inline prediction offers the completion TypeScript ranks first at the cursor. Read-only refs keep hover and navigation, and never predict.

### Changed

- `source.commit` takes `actor` instead of an `author` email, plus optional `branch` and `fromSha`, and its commits use the noreply identity.
- Every new app gets its repository at creation, with `main` as the default branch; before, it appeared on the first push with no default branch. Source browsing reads the mirror that holds every pushed branch, not only the deployed one.
- The app detail page uses the full width, like Code mode and storage, and drops the "← Apps" link above the header (the sidebar lists the apps). The name, actions and tabs stay put while the tab body scrolls. Settings is no longer a tab: the **Settings** button at the end of the tab row opens it as a panel on the right, a third of the width (`?panel=settings`), whose sections now sit between dividers instead of a card each. The panel stays open while you switch tabs. `?t=settings` links now open Overview. The Noite admin page (`_control`) uses the same layout.
- Code mode's and the app page's side panels cover the page below the `lg` breakpoint instead of squeezing a second column next to it. Code mode also draws a divider between the file tree and the editor, like the ones around its bar and panels.
- Code mode opens on the default branch (`main`) instead of the deployed commit, so what you see is what browser edits build on and History lists the same branch. The deployed commit stays the first entry of the branch picker. The bar drops its back link to the app (the sidebar lists the apps); the branch picker has a branch icon, and History and Changes have icons too.
- The app Overview shows the Metrics and Errors cards side by side when the page is wide enough (they stack while the Settings panel is open), the Settings button has a cog icon, and the sidebar's profile menu items (Account, Docs, Sign out) have icons.
- `/account` uses the same full-width layout as the app pages: your avatar, name and email at the top, then an **Account** tab (profile, passkeys, API keys, invitations, agent setup) and, for instance admins, an **Admin** tab with the telemetry opt-out and a link to the Noite admin page (`?t=admin`).
- Switching tabs on the app detail page no longer remounts the whole page, so the settings you are editing and the open panels keep their state.
- The Deployments tab opens only the deploy serving traffic (the newest successful deploy of the live commit), instead of every deploy of that commit.
- The Events tab label shows how many events the app's feed holds, like the Errors tab's open count (hidden at 0; the feed keeps the newest 200).
- Rolling back to the commit that is already live (`deploys.rollback`) rebuilds and redeploys it instead of silently doing nothing. Apps deployed before this release have no captured package types for the editor until their next deploy; a push or a rollback to the live commit captures them.
- `make dev` turns off the per-client edge rate limit (`NOITE_EDGE_RPM=0`): vite dev serves every module as its own request, and the editor's TypeScript worker alone loads about a hundred, so dev pages hit 429s and the worker died.

### Removed

- The Source page's "Last push diff" view, with the runner's `source.diff` RPC and `GET /v1/apps/{id}/diff`. History covers it: open any commit, the deployed one included, to see its changes.

### Fixed

- A deploy failed with "parse wrangler config: trailing comma" when a `wrangler.jsonc` member ended with a comma followed by a comment.
- Push rules failed open: a push whose commands the runner couldn't parse skipped every check, so a push-role collaborator could force-push or delete `main`. Such a push is now refused, and git also enforces "no force-push, no delete" for every non-admin.
- Creating apps in parallel could go past the per-account app limit, and a losing create of the same slug could wipe the winner's repository. Creates are now serialized.
- The UI's git-auth reply no longer defaults to the push role when it names no role.
- Opening another file in the source browser threw away the unpushed edits of the file before, so a web commit could only ever change one file. Each change of `?file=` remounted the browser. Edits to any number of files now stay until you push them together.
- A boolean (`FLAG_…`) env var's toggle in Settings could keep showing on after it was turned off, until a reload: the control UI's ilha didn't write `checked={false}` back to a live checkbox. Bumped ilha to 0.15.2 and @ilha/router to 0.11.16, which also keep controlled `<select>` and `<textarea>` values in sync.
- The same bump made an in-place navigation leave a stale view behind: ilha reuses a keyed component without re-running it when its props are unchanged, and a `?query` read is not a reactive read, so a control that writes one (`?size=`, `?page=`, `?view=`, `?f=`, `?q=`, `?t=`, `?e=`, …) changed the URL while the grid, list or filter kept the old state — the storage editors, the admin searches and Code mode's panels among them. The control UI now reads search params through a wrapper whose reads subscribe the reading component to navigation, whether it reads the param itself or receives the handle as a prop.

## [0.1.0-alpha.3] - 2026-10-06

Opt-out instance telemetry, storage editors, the admin home, and a pre-release flow for releases.

### Operator action required

- **`RUNNER_BUILD_UID` and `RUNNER_BUILD_GID` are removed** and ignored if still set: delete them from your environment. Builds and release commands now run as one uid per app from a reserved range, `RUNNER_BUILD_UID_BASE` (default `10030`) and `RUNNER_BUILD_UID_RANGE` (default `1024`). The image pre-creates the default range in `/etc/passwd`; a custom range needs matching `/etc/passwd` and `/etc/group` entries, must stay below 65534 and must not contain `RUNNER_FLEET_UID` (10020).
- **Expect a one-time telemetry replay after the upgrade.** The runner re-reads the stored telemetry for the whole retention window (`RUNNER_TELEMETRY_RETENTION_DAYS`, 30 by default) for every app, to recover the rows the pre-alpha.2 ingest bug skipped. It runs in the background with no downtime; the cost is extra bucket reads and DuckDB CPU in proportion to window × apps. The runner logs `telemetry replay started` and `telemetry replay complete`. Telemetry older than retention was already pruned and cannot be recovered.
- Both databases upgrade themselves: the runner SQLite goes to schema version 5, the control D1 to 1.4.0. As before, an older image refuses newer data, so back up before upgrading.
- **This release adds anonymous instance telemetry, and it is on by default.** Once a day the instance sends one count-only heartbeat: the version, platform, storage kind, numbers of apps, deploys and users (users bucketed), install age and uptime. It is keyed by a random install id; no domains, names, emails or IPs are sent, and nothing at all is sent from a local domain. To turn it off, untick it in the Admin section of `/account`, or set `NOITE_TELEMETRY=0` (or `DO_NOT_TRACK=1`) in `.env`, which also locks the checkbox. The full list of fields is on [Telemetry](https://noite.now/self-hosting/telemetry).
- **A malformed `RUNNER_TELEMETRY_RETENTION_DAYS` now stops the runner at boot** with a config error. Before, it silently fell back to 14 days, though the documented default is 30. Unset still means 30.
- **Runner REST API callers:** status codes and one response changed; see Changed. Scripts that matched on 409 for storage or source errors, sent extra fields to `PATCH /v1/apps/{id}`, or read `remote` from the git-remote response need updating.

### Added

- Anonymous instance telemetry. The runner sends PostHog EU one `instance_heartbeat` event a day: no SDK, GeoIP lookup disabled, no person profiles. An Admin section on `/account`, shown to instance admins only and never while impersonating, turns it on or off and shows the exact payload. The runner API has `GET`/`PUT /v1/admin/telemetry` and RPC `telemetry.get`/`telemetry.set`. The installer prints a notice and accepts `NOITE_TELEMETRY`. Dev and e2e stacks never report.
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

- Re-running the installer fills in any required `.env` setting that is missing or still at a dev default, instead of leaving the runner to refuse its config: the domain settings, ports, runner token, auth secret and RustFS keys. Values that are set are never changed, and the installer lists what it added. A missing `BASE_DOMAIN` is now asked for (or taken from `NOITE_DOMAIN`). Before, the installer stopped with "fix it or move it away".
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
- Runner API status codes. Storage and source failures used to answer 409 Conflict whatever went wrong. Now a missing object, table, deployed source or Git mirror is 404, an invalid path is 400, and an internal failure is 500. 409 is kept for real conflicts: a taken slug or hostname, a deploy in flight, or a web commit that lost the race against a push. RPC `events.*` returns 500 for a database error instead of 404.
- `PATCH /v1/apps/{id}` rejects unknown keys with 422, as RPC `apps.patch` already did, instead of ignoring them.
- The git-remote response (`GET /v1/apps/{id}/git-remote`, RPC `git.remote`) returns the URL once, as `url`. The duplicate `remote` field is gone.
- `/profile` is removed. Use `/account`.
- Invite codes on the account page and in the admin Invites tab stay visible, with a Copy button next to them. Before, the code itself switched to "copied" when clicked. Every copy button in the UI now behaves the same way.
- Codebase reorganization, no behavior change beyond the entries above:
  - **Runner API:** one service layer (`src/service/`) now implements both the REST and RPC APIs, replacing two copies that had drifted apart. New handler tests check that both give the same results.
  - **Large files split:** in the runner, `db.rs`, `host/metrics.rs`, `host/cmd.rs` and `main.rs`; in the control UI, the action modules, HTTP routes and the largest panels. The control UI's server-only code now lives in `lib/server/`.
  - **Generated types:** the runner's API types are generated for the UI, and CI fails when they are out of date.
  - **CI:** pull requests and release tags run the same reusable check workflow. Release tags were skipping the shell-script and schema checks.
  - **Docs:** the roadmap and design history moved from `SPEC.md` to `ROADMAP.md`.

### Fixed

- Deleting an app over RPC (what the control UI does) did not revoke its stored credentials; only the REST route did. Both now share one code path.
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
