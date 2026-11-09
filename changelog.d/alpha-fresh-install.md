### Operator action required

- **This alpha does not upgrade from any earlier alpha.** All schema migrations were compacted into one baseline per store, and the upgrade paths were removed: the runner refuses a SQLite database with a different `user_version`, the control D1 refuses a `paranorm_migrations` ledger from another alpha, and `install.sh` refuses an existing `/opt/noite/.env` instead of acting as an upgrade. Moving to this release means `uninstall` (which deletes the volumes) and a fresh install. A bucket of your own is never deleted: empty it or set a new `NOITE_S3_BUCKET` to start clean.

### Changed

- One `schema.sql`, one `schema.metrics.sql` and one control `defineSchema` are the whole schema of a fresh install. The runner's ordered `MIGRATIONS`, the metrics `ensure_environment_telemetry` rebuild, the tolerant `app_error_event` ALTERs, the control `schemaHistory`/ledger compatibility check and the installer upgrade confirmation are gone.
