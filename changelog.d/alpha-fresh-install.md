### Operator action required

- **This alpha does not upgrade from any earlier alpha.** All schema migrations were compacted into one baseline per store, and the upgrade paths were removed: the runner refuses a SQLite database with a different `user_version`, the control D1 refuses a `paranorm_migrations` ledger from another alpha, and `install.sh` refuses an existing `/opt/noite/.env` instead of acting as an upgrade. Moving to this release means `uninstall` (which deletes the volumes) and a fresh install. A bucket of your own is never deleted: empty it or set a new `NOITE_S3_BUCKET` to start clean.

### Changed

- The shipped history is compacted to one baseline: `MIGRATIONS` is empty above `SCHEMA_VERSION` 100, `schemaHistory` holds the single control `defineSchema`, and `schema.metrics.sql` carries the final metrics shape. Both migration runners are retained (append a step above the baseline to change the shape forward). The metrics `ensure_environment_telemetry` rebuild, the tolerant `app_error_event` ALTERs, and the installer upgrade confirmation is gone.
