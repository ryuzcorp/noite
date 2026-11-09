### Fixed

- `apps/noite` pins `void` at `1.3.0` exactly (it was `^1.3.0`), and `docker/check-versions.ts` fails if the pin is a range or if `apps/noite/bun.lock` resolves a dependency differently from the workspace lock. A caret range let a lockfile regeneration pull `void` 1.7.0, whose build emits no root `dist/wrangler.json`: the control deploy was skipped and `/ready` stayed unhealthy with no cause.
