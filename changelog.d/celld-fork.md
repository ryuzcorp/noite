### Changed

- The image ships celld `0.6.3-ryuzcorp.5` from the [ryuzcorp/celld](https://github.com/ryuzcorp/celld) fork: upstream celld 0.6.3 plus the fork's patches, built with celld's full upstream test suite, pinned by digest and published with SLSA provenance attestations. Upstream celld ships only security fixes from 0.6.x on, so the fork carries the patches.

### Fixed

- RPC stubs and byte streams cross isolates on the same node, so a Void sandbox's process handle and its output streams reach the app through the sandbox controller (they failed with `DataCloneError`).
- A container process's `exitCode` settles after the request that started it has ended; it used to hang forever, which timed out Void sandbox exec calls at 30 s.
