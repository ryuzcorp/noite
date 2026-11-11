### Fixed

- **A sandbox cell can no longer leak capacity or race its own teardown.** An interrupted stop still schedules the cleanup that frees its concurrency slot, a request that arrives while the idle alarm is destroying the cell is refused with `VOID_SANDBOX_unavailable`, and a stopped lease asked to confirm a start tears the container down instead of leaving it running with no record able to stop it.
