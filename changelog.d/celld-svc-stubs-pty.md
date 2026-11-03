### Changed

- The image ships celld `0.6.3-noite.2`, which carries patch `0004` (streaming `Response.clone()`).

### Added

- celld patches `0005` and `0006` (celld `0.6.3-noite.3`, pinned in a following change once published):
  - A service-binding RPC method can return or accept a Durable Object stub, as on Cloudflare.
  - Container `exec` can allocate a terminal (`pty`, `isPty`, `resize(cols, rows)`).
