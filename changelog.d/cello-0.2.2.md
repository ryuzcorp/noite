### Changed

- Tenant fleets, the control fleet, and every `cello` CLI call run Cello 0.2.2, pinned by digest.
  - App WebSockets are now backpressure-safe. When a peer or app stops reading, the socket ends with close code 1011 at a 16 MiB backlog per direction, instead of growing host memory.
  - A WebSocket message is capped at 32 MiB, Cloudflare's limit. Past it, the socket closes with 1009. A single message up to the cap still passes.
  - A peer close that cuts a send short reports `wasClean: false`.
  - An app that reads one `tee()` copy of a fetched, RPC, Durable Object or R2 body to the end before the other no longer hangs. The copies buffer for each other up to 32 MiB per request. Past that, the lagging copy's read fails instead of growing host memory.
