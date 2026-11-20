### Changed

- Tenant fleets, the control fleet and every `cello` CLI call run Cello 0.2.1, pinned by digest. App WebSockets are now backpressure-safe: a peer or app that stops reading ends the socket with close code 1011 at a 16 MiB backlog per direction, instead of growing host memory. A WebSocket message is capped at 32 MiB, Cloudflare's limit; past it the socket closes with 1009. A single message up to the cap still passes.
