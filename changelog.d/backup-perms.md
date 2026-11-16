### Fixed

- `make backup` no longer writes secrets world-readable. The destination directory is created 0700 under `umask 077`, a pre-existing group- or world-accessible destination is refused with instructions instead of filled, and each volume tar is written 0600 (umask inside the helper plus a host-side chmod). Before, the destination inherited the caller's umask and root's helper wrote 0644 tars holding the runner SQLite (plaintext env values) and every tenant's objects.

### Operator action required

- If you back up to an existing directory shared with another user or group (e.g. a backup agent reading as group), `make backup` now refuses it: move the agent to read as root or point `DEST` at a private directory. The default `backups/<stamp>` path is unaffected.

### Changed

- The "Custom domains" section of Known limits now describes the check that ships: a claim stays pending until the TXT proof verifies, only verified hostnames route, and the first to verify wins (`single` claims are born verified by design). Known limits also records the accepted `libsqlite3-sys` RUSTSEC-2026-0459 advisory.
