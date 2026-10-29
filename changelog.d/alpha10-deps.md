### Operator action required

- None for the npm/Rust bumps. The celld 0.6.2 → 0.6.3 image upgrade restarts every fleet and the control node (rolling update, a rollback rolls too). A restore that lost a cell's ownership record now stays failed and visible (`celld ownership record lost` in the node log) instead of starting the cell empty — re-create the record per the celld guarantees docs before the cell serves again.

### Changed

- **Every npm and Rust dependency to latest.** ilha 0.16.0 → 0.16.1, effect 4.0.5 → 4.1.0 (plus exact-pinned `@effect/sql-d1` and `@effect/platform-node` 4.0.5 → 4.1.0), `void` 1.1.12 → 1.3.0, `@ilha/void` 0.1.4 → 0.1.5, better-auth 1.7.11 → 1.7.14 (all four packages), vite 8.3.4 → 8.3.5, `@cloudflare/workers-types` to 5.20261029.1, oxlint 1.89 → 1.90, oxfmt 0.74 → 0.75, blume 2.2.4 → 2.2.6. Rust `cargo update` floats 25 crates (tokio 1.54.1, uuid 1.29.0, libsqlite3-sys 0.30 → 0.37, ICU 2.4.0); no direct-dependency major. Other Docker-pinned tools (Caddy, Node, jup, sidecars) untouched.
- **celld 0.6.2 → 0.6.3.** rustls 0.23.46 (TLS 1.3 handshake fix GHSA-2mjx-qc3c-rqvc) and outbound TLS distrusts the compromised eMudhra CA chain. `celld deploy` bundles byte-identically to 0.6.2 (flags, CommonJS-builtin banner and `BARE_NODE_BUILTINS` verified at the v0.6.3 tag), so the runner's shadow bundle and the Errors tab's mappings are unchanged.
