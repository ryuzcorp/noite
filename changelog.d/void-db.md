### Changed

- The control UI's data layer runs on Void's Drizzle stack: the schema lives in `apps/noite/src/db/schema.ts` (`void/schema-d1`), migrations in `apps/noite/src/db/migrations/`, every query uses `void/db`'s `createDb`, and better-auth uses its Drizzle adapter over the same connection. paranorm, `@effect/sql-d1`, Kysely and the worker's boot-time migrator/ledger are gone. The runner applies the control migrations through the worker's Void migration endpoints after the bundle is live (the same protocol as an app deploy), hashing the image's migration list first. The baseline migration is idempotent, so every existing control database (TEXT timestamps and all) is adopted without a wipe; a fresh install gets the full schema before the UI serves.

### Fixed

- The UI image installs from `apps/noite/bun.lock` (the Docker stage cannot use the workspace lock); the lock is pinned to the versions `bun.lock` resolves and `docker/check-versions.ts` fails on drift. A fresh regeneration had pulled `void` 1.7.0, whose build emits no root `dist/wrangler.json`: `bundle_present` saw nothing and the control deploy was skipped entirely, leaving `/ready` at "control: fleet not healthy yet". The runner now finds the wrangler config at `dist/` or `dist/ssr/` and names an unreadable bundle in `/ready`.

### Operator action required

- None beyond the upgrade itself: re-run the installer (or let the runner restart) and the control database is migrated in place. `NOITE_KEEP_DATA=1` on `uninstall.sh` still keeps the volumes.
