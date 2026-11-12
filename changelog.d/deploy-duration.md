### Added

- A finished deploy in the Deployments tab says how long it took (`took 1m 42s`), computed from the row's start and its last write (`created_at` → `updated_at`).
- A failed, stopped or timed-out deploy shows its own one-line reason in its row (`build failed: …`, `cancelled by the operator`, `deploy stalled …`). Runner schema version 105 adds `deploy.error`.

### Changed

- **A deploy's failure is no longer repeated in a second alert above the app.** The reason lives on the deploy's own row; the app and environment `lastError` alerts now carry only operational failures the deploy history cannot show (a fleet that never spawned, a failed import), and those stay visible. Existing per-deploy alerts are not duplicated, and nothing the deploy history shows becomes invisible.

### Operator action required

- Booting this image on a schema-104 database migrates to 105 in the boot transaction: `ALTER TABLE deploy ADD COLUMN error TEXT`. No backfill: deploys finished before the upgrade have no row-level reason (their log still holds the `ERROR:` line) and their duration reads from the same `updated_at` as new rows.
