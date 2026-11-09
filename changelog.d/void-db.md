### Changed

- The control UI's data layer runs on Void's Drizzle stack: the schema lives in `apps/noite/src/db/schema.ts` (`void/schema-d1`), migrations in `apps/noite/src/db/migrations/`, every query uses `void/db`'s `createDb`, and better-auth uses its Drizzle adapter over the same connection. paranorm, `@effect/sql-d1`, Kysely and the worker's boot-time migrator/ledger are gone. The runner applies the control migrations through the worker's Void migration endpoints after the bundle is live (the same protocol as an app deploy), hashing the image's migration list first. The baseline migration is idempotent, so every existing control database (TEXT timestamps and all) is adopted without a wipe; a fresh install gets the full schema before the UI serves.

### Operator action required

- None beyond the upgrade itself: re-run the installer (or let the runner restart) and the control database is migrated in place. `NOITE_KEEP_DATA=1` on `uninstall.sh` still keeps the volumes.
