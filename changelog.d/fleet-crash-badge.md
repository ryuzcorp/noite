### Added

- **A crash-looping or OOM-killed fleet says so.** An app whose fleet the supervisor is backing off showed a green `Running` badge while nothing served. `App.fleetHold` (`{ hold: "crash" | "oom", retryAt }`, filled from the supervisor's state — process state, never a column, `AppStatus` unchanged) now paints "Crashed, retrying" / "Out of memory, retrying" with the next attempt beside it in the app header, the apps list and the sidebar, on the REST app endpoints, their JSON-RPC mirror and the app state stream (so the badge flips without a refetch).
