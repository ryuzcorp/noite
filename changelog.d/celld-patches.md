### Changed

- The image now ships celld 0.6.3 from the ryuzcorp/celld fork (`ghcr.io/ryuzcorp/celld:0.6.3-noite.1`, pinned by digest), built with celld's full upstream test suite. Upstream celld ships only security fixes from 0.6.x on, so the fork carries the patches.

### Fixed

- Durable Objects with containers can read `ctx.container.images` and pass `start({ image })`, which Void's sandbox needs.
- `exec()` on a container now waits for a `start()` still in progress instead of failing because the container is not running yet.
- `node:crypto` `scrypt` and `scryptSync` work in Workers (Better Auth password hashing, which Void auth uses, threw "not implemented").
