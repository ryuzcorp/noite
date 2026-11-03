### Changed

- The image ships celld `0.6.3-noite.3` (patches `0004`–`0006` on top of the earlier ones).

### Added

- celld patches `0005` and `0006` (in `0.6.3-noite.3`):
  - A service-binding RPC method can return or accept a Durable Object stub, as on Cloudflare.
  - Container `exec` can allocate a terminal (`pty`, `isPty`, `resize(cols, rows)`).
