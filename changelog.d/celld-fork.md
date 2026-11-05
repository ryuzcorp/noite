### Changed

- The image ships celld `0.6.3-ryuzcorp.8` from the [ryuzcorp/celld](https://github.com/ryuzcorp/celld) fork: upstream celld 0.6.3 plus the fork's patches, built with celld's full upstream test suite, pinned by digest and published with SLSA provenance attestations. Upstream celld ships only security fixes from 0.6.x on, so the fork carries the patches.
- A deploy reads only the app's own checkout. Imports, source maps, `tsconfig.json` `extends` and Dockerfiles that resolve outside it fail the deploy, and esbuild runs with its file reads confined to it. Assets, migrations and the Wrangler config itself must sit inside the config's own directory.

### Fixed

- RPC stubs and byte streams cross isolates on the same node, so a Void sandbox's process handle and its output streams reach the app through the sandbox controller (they failed with `DataCloneError`).
- A container process's `exitCode` settles after the request that started it has ended; it used to hang forever, which timed out Void sandbox exec calls at 30 s.
- Concurrent D1 calls from one request no longer stall each other.
- `caches.default` and `caches.open()` cache per node (up to 64 MiB) instead of always missing.
- A Worker can reach only the D1 databases, KV namespaces, queues, workflows and Durable Object namespaces its script declares, and only its own cell's storage and sockets.
- `exec()` in a container honors `signal`, and closing stdin or signalling a container no longer dies with the request that sent it.
- An `exec()` that carries a `signal` no longer aborts as soon as the request that started it returns: a stream received over RPC stays open while the receiver holds it.
