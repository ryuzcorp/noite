### Fixed

- Durable Objects with containers can read `ctx.container.images` and pass `start({ image })`, which Void's sandbox needs.
- `exec()` on a container now waits for a `start()` still in progress instead of failing because the container is not running yet.
- `node:crypto` `scrypt` and `scryptSync` work in Workers (Better Auth password hashing, which Void auth uses, threw "not implemented").
