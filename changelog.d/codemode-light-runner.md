### Changed

- **The runner and the edge no longer carry the in-browser pod or workspace previews.** `source.preview`, its hidden `refs/previews/<user>/<branch>` refs and `EnvironmentKind::Workspace` are gone, so an environment is always one branch; `source.bundle` and `source/archive` (the language-service bundle and the workspace tarball) are gone with the editor that read them. The pod host (`pod-<app id>.<base>`) is gone from the route table and the TLS ask, and its `preview` route-table kind is refused by the edge (the previous table keeps serving).
- `RUNNER_ENVIRONMENT_TTL_H` is removed with the sweep it configured; branch environments still live until their branch or their row goes.

### Operator action required

- On upgrade the runner tears down every environment row left from workspace previews before it serves: the fleet is stopped, the local state and `envs/<slug>/<label>` prefix are deleted, the route is rebuilt without its host, and the row is removed. A failure stops the boot so the next start retries; nothing is left half-deleted.
- Remove `RUNNER_ENVIRONMENT_TTL_H` from your environment if you set it; it is no longer read.
