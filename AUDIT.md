# Migration & upgrade safety audit — 2026-11-17

Scope: every persistent store and how its schema evolves, from `origin/main` (`fdd345de`, release 0.1.0-beta.3). Ratings assume "we keep shipping beta changes": append-only discipline, transactional apply, generation sync, downgrade guards, and lane coverage.

Peer boundary: tenant D1 `migrations_dir` application on deploy (`deploy.rs`, `void_migrate.rs`, `build_output.rs`) belongs to **D1MigrationsApply** — audited here, not edited. Messaged separately about the seed worker having no `db/migrations`.

## 1. Control UI D1 (drizzle)

**Files.** `apps/noite/src/db/schema.ts` (source of truth), migrations `apps/noite/src/db/migrations/*.sql` (3 files) + `meta/{_journal.json, *_snapshot.json}` (drizzle-kit shape: journal `version: 7`, every entry `breakpoints: true`), behaviour contract `apps/noite/src/db/migrations.test.ts`.

**How applied.** Not at request time and not by the UI itself: the runner drives the worker's in-worker migration endpoints once per boot, after the control fleet is supervised — `host/control.rs:233-341` (`migrate` / `migrate_control`: collects `db/migrations/*.sql` from the image bundle, refuses on dialect or `migration_list_hash` mismatch at `:311-316`, applies app migrations then `auth` at `:327-329`), retried 3× at `main.rs:739-753`. Persistent failure does not refuse boot: it records `control_boot` (`main.rs:152-155, 750-753`) and the UI errors loudly; `/ready` reports the cause beside fleet health.

**Journal / ordering / idempotency.** The journal is the in-worker Void migration tables — **not in this repo**, so ordering, locking and per-file atomicity of the control plane are inherited from the Void runtime, unaudited here. What this repo proves: `migrations.test.ts:169-194` simulates journal-tracked once-only apply with a TEMP table; `:247-274` asserts fresh-create plus second-apply idempotency and the **exact final table list** (11 tables). Statement-level idempotency is uneven: every `CREATE` is `IF NOT EXISTS`, but `ALTER TABLE user ADD status` has no `IF NOT EXISTS` equivalent (re-apply would fail — only the journal saves it) and `20261116120000` ends in `DROP TABLE invite` (destructive, data-losing by design: outstanding invite codes die on upgrade — correctly noted under beta.1's "Operator action required").

**Adoption of old data.** `:197-245` replays alpha.29's paranorm DDL through all three migrations and asserts row preservation plus `status='active'` defaulting. This is the oldest-release coverage for the control plane.

**Down-migrations / rollback.** None, forward-only. Downgrade (newer D1 under older image) has no guard at this layer: the worker hash check compares image-vs-worker lists, not history.

### Findings

- **H1 (High) — migrations not append-only enforced.** Nothing stops editing `20261109…sql` after it shipped. The journal marks it applied, so a fix silently never reaches upgraded installs (fresh installs get it, upgraded ones don't — the worst divergence). **Fixed:** hash-manifest test (§7 F1).
- **H2 (High) — no schema↔migrations sync check.** `schema.ts` and the migration chain can drift (fresh installs diverge from upgraded ones) with no CI signal; generation is unwired (no `drizzle.config`, drizzle-kit only a transitive dep via `void`). The table lists match today by inspection. **Fixed:** sync test (§7 F2).
- **M3 (Med) — control migration failure is fail-open.** Boot retries 3× then serves an erroring UI until the next restart; no automatic retry afterwards. `/ready` surfaces the cause, and the upgrade lane fails on it indirectly, so this stays a conscious availability trade-off, **left as is** (Candidate: retry with backoff in `supervise` instead of only at boot).
- **L4 (Low) — crash mid-migration atomicity is the runtime's.** A crash between files leaves the in-worker journal to decide resume/partial state; out of repo. Shipped files are small; the waitlist file mixes `ALTER` + `CREATE`s + `DROP` — a partial apply there needs the runtime's per-file atomicity to hold. **Left** (documented; Candidate: split destructive statements into their own file).

## 2. Runner SQLite

**Files.** `apps/runner/schema.sql` (full fresh shape), `apps/runner/src/schema_version.rs` (versioning), `apps/runner/schema.metrics.sql` (telemetry sibling), `apps/runner/src/db/mod.rs:115-165` (`connect`).

**Mechanism — sound.** `FIRST_COMPACTED_VERSION = 100`, `SCHEMA_VERSION = 107` (`schema_version.rs:15-18`); 7 steps at `:29-107`, each commented. `plan()` (`:122-143`) refuses pre-compaction alphas (`Legacy`) and newer-than-binary DBs (`TooNew` with a clear message naming restore-or-rerun-image, `:173-177`). `apply()` (`:148-205`) runs inside the caller's transaction — `connect()` opens one tx, applies, stamps `user_version`, commits (`db/mod.rs:155-163`) — so a refusal or mid-chain failure leaves the file untouched. Tests cover fresh stamp, reboot, refusal-untouched (`:a-pre-compaction-alpha-is-refused-untouched` asserts version still 16 and shape unchanged), and the 106 tombstone step. CI applies `schema.sql` twice and diffs the table list against an exact allowlist (`check.yml`, "runner schema applies twice").

**Concurrency.** One runner per install (compose); pool of 5 with `busy_timeout`, WAL, per-connection metrics ATTACH. Two containers sharing a volume would serialize on SQLite locks — no cross-instance migration lock, but no deployment runs two runners either. **Low, left.**

**Metrics DB.** `metrics.sqlite` has no version stamp; `schema.metrics.sql` only ever creates, `DEAD_METRICS_TABLES` drops idempotently (`db/mod.rs:184-193`), attached on every connection (`:195-229`). An older binary against a newer metrics file is harmless (`CREATE IF NOT EXISTS`). **Low, left as is.**

### Findings

- **M1 (Med) — step list append-only/contiguous by convention only.** Nothing enforces ascending contiguity from 101, or that a step's objects exist in `schema.sql` (fresh installs take `schema.sql` only; a step forgotten there diverges fresh vs upgraded). **Fixed:** contiguity test plus the v100-baseline replay equivalence test (§7 F3).
- **(No downgrade gap.)** `TooNew` refusal already exists — the model for F-guardrails elsewhere.

## 3. Tenant / celld data formats (audit only)

Driver (`void_migrate.rs`, `deploy.rs:1600-1811`) reviewed, not changed. Ordering has two deliveries: redeploy migrates the **staged** generation before `activate` (old version keeps serving; failed migration fails the deploy with nothing activated); first deploy — or unreachable staged fleet — migrates **after activation**, so new code briefly serves the old schema ("keep migrations backward-compatible (expand before contract)"). Applied migrations are never rolled back (forward-only); Postgres/MySQL (hyperdrive) is refused loudly; capability/list-hash negotiation refuses a worker whose list differs from the pushed tree.

Bucket layouts: `git/{slug}/` bundles and `fleets/{slug}` celld state (`config.rs:1986-2030`), `control/` revision-gated worker, `runner/state/` snapshots; LTX chains are append-only with epoch files (`host/s3.rs:306`, `deploy.rs:67` ghost-LTX guard, `purge.rs:518,551,1016` kill-vs-wipe races). A format change to any of these strands tenants — no version markers found on `git/` bundles or `fleets/` trees.

### Findings (for D1MigrationsApply)

- **H3 (High) — the upgrade lane never exercises tenant D1 migrations.** The seed worker (`apps/noite/test`: D1 `demo` in `cloudflare.config.ts:16`) ships **no `db/migrations`**, so the staged-migrate path, the hash negotiation and the post-activation window run zero times in the lane. Messaged to D1MigrationsApply (add a migrations dir + seed rows to the sample worker; assert them in verify).
- **M4 (Med) — first-deploy compat window has no mechanical check.** "Keep backward-compatible" is a doc comment. Suggested (theirs): expand/ contract lint or a deploy-shape assertion; at minimum a second deploy in the lane touching the migrated tables.

## 4. Snapshots, backup, restore

`VACUUM INTO` beside the live file (`db/mod.rs:232-253`), `POST` snapshot endpoint (`api/admin.rs:16-52`, also pushes to the bucket per `backup.sh` header: per-minute `runner/state/` + quiesced volume tars; BYO-S3 covers the bucket at the provider). `make restore` replaces volumes (`restore.sh`, EXIT-trap restart per beta.3 changelog). Restore of an older snapshot into a newer binary replays the §2 forward path; restore of a newer snapshot into an older binary hits the `TooNew` refusal at boot with an actionable message. **No gap found** — snapshot/restore inherits the guardrails rather than needing its own.

## 5. Config/env renames, installer upgrade path

`config.rs` reads ~30 vars (`NOITE_DB`, `BASE_DOMAIN`, `NOITE_TENANCY`, `…`) with defaults and no compat-shim layer found — no renames shipped in beta so far, so no shim debt yet. Installer (`docker/install.sh`): re-run is the upgrade; `.env` values survive re-runs (`env_set` keeps), image moves via `NOITE_IMAGE`, container recreated only when the pulled image differs, with an explicit upgrade confirmation (`confirm_upgrade`, `:528-556`). Channels (`alpha`/`stable`/pins, rollback tags) documented in `CHANGELOG.md` head. **No gap:** renames must add shims when they happen — recorded as a rule in the upgrade docs (§7 F5), not code.

## 6. CI upgrade lane — what it proves and misses

**Proves** (`upgrade.yml`, `docker/e2e-upgrade.sh`, `apps/noite/upgrade/*`): previous `v*` tag → tree, same volumes+bucket; seeds through the public surface (app, env var, deploy of the sample worker, verified domain, collaborator via code-or-email `inviteMode`, worker-written D1 `visits` rows + R2 object) and asserts every seed reads back and the app serves. Runs nightly on main, on release tags (release gate in `images.yml`), and on PRs touching schema/migration paths (path filter `schema` in `ci.yml` `:202-277`). No retries anywhere.

**Misses (rated for beta velocity):**

- **M2 (Med) — previous-release only.** A beta.1→beta.3 jump never runs; anything the N-1 image already migrated is never exercised as a migration. Partly mitigated by the replay tests (§1 alpha.29, §2 refusal+step tests). **Fixed (cheap half):** `E2E_FROM_OLDEST=1` knob + monthly oldest-beta lane (§7 F4). Full per-PR oldest coverage costs a second 40-min lane — **left** (Candidate).
- **M5 (Med) — seeded-but-unasserted stores.** The seed mints an API key (scoped-credential store) and pushes git (mirror store) but verify never touches the key again; runner-internal tables (`instance_setting`, `bootstrap_setup`) and the invite-code→email-invite transition have no post-upgrade assertion. **Fixed (key half):** verify proves the pre-upgrade key still pushes (`git ls-remote`) (§7 F4). Invite-transition and second-deploy-after-upgrade stay **Candidates** (latter costs lane minutes per run).
- **(No downgrade assertion.)** Deliberate: downgrades are unsupported and refused (runner) — docs now say so (§7 F5).

## 7. Fixed vs left

**Fixed on this branch** (each with a fail-before test, §8):

- F1 — `migrations.test.ts`: `APPEND_ONLY_MANIFEST` (sha256 per shipped file). Editing/deleting a shipped migration fails; adding one fails with instructions to register its hash. Covers H1.
- F2 — `migrations.test.ts`: every `*Table` in `schema.ts` must exist in the migrated shape with the same columns and index names (via `void/schema-d1`'s `getTableConfig` vs `PRAGMA table_info` / `sqlite_master`). Covers H2.
- F3 — `schema_version.rs` tests: steps strictly ascending/contiguous from 101 to `SCHEMA_VERSION`; a failing mid-chain step inside a transaction rolls back with stamp and shape untouched; and the v100-baseline replay (fixture: verbatim v100 `CREATE TABLE`s from the compaction commit for the five touched tables) has the same tables, columns, indexes and triggers as fresh `schema.sql` — the step-without-schema (or reverse) mistake fails here. Column order is compared order-insensitively (SQLite appends `ADD COLUMN`; all readers name their columns). Covers M1 + M1-full + the every-migration-transactional guarantee.
- F4 — lane: seed persists the minted API key in `upgrade-state.json`; verify proves `git ls-remote` with the pre-upgrade key (credential + mirror survival). `E2E_FROM_OLDEST=1` resolves the oldest beta tag; `upgrade-oldest.yml` runs the lane monthly from it; `upgrade.yml` takes a `from_oldest` dispatch input. Covers M5-key-half, M2-cheap-half.
- F5 — docs (`apps/website/docs/self-hosting/operations.mdx` or nearest): supported upgrade path (N-1 within beta, replay-tested from alpha.29 / compacted baseline; alphas need fresh installs), downgrades unsupported (runner refuses `TooNew`; control has no down-migrations), renames-ship- shims rule. Plus `changelog.d/ops-migration-safety.md`.

**Left (Candidates for the board):** M3 boot-retry backoff; L4 destructive-statement file split (accepted column-order divergence between migrated and fresh is documented in the equivalence test); M2-full per-PR oldest lane; M5 second-deploy-after-upgrade + invite-transition assertions; H3/M4 with D1MigrationsApply; format version markers for `git/` bundles / `fleets/` trees (§3).

## 8. Verification

- `bun test src/db/migrations.test.ts` (control, incl. F1/F2; fail-before shown by reverting each guard).
- `cargo test -p noite-runner schema_version` (F3; fail-before by breaking contiguity / removing the tx).
- `bun run check` (anti-slop), `cargo fmt`, `cargo clippy -p noite-runner --all-targets`.
- Lane changes proved by `E2E_SLOT=8` local run only if timeboxed ( two full stacks); otherwise `sh -n` + `upgrade.config.ts` typecheck via the existing `tsc` path and review.
