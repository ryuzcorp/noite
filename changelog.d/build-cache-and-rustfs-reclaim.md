### Changed

- The persistent per-app build cache cap is now 1024 MiB (was 512). A cold `bun install` of the shipped Void/Ilha template writes ~872 MB, so the old cap pruned the cache it had just filled at the end of every deploy and the next one downloaded it again; the cache survives deploys and is still pruned largest-first and deleted with the app. Worst-case disk is 1 GiB per app (the default install has 39 GB free on a 2 GB VPS).
- The bundled RustFS service now sets `RUSTFS_ALLOCATOR_RECLAIM_ENABLED` and `RUSTFS_ALLOCATOR_RECLAIM_FORCE` explicitly, so freed allocator pages return to the OS between idle periods instead of accumulating: prod measured 752 MB anonymous in the store's own container after four days, outside the noite container's memory accounting. The console stays disabled (it is admin UI, not storage).

### Operator action required

- None.
