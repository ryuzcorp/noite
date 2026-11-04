### Changed

- Sandbox exec `signal` now reaches the container: the controller forwards the caller's AbortSignal to celld instead of mapping aborts to `kill()` itself (celld 0010/0015: abort sends SIGKILL through the exec kill path, and an already-aborted signal refuses with its reason before spawning). The engine proxy's exec validation pins celld's kill-exec shape (attachless `sh -c` scan for the exec's `CELLD_EXEC_ID` marker, run as the exec's user) with admit and near-miss tests.
- Void ISR stays KV-backed by design now that celld caches per node (0018): the proxy still never touches `caches` (per-node state must not become an ISR dependency), and `/revalidate` purges KV only.
