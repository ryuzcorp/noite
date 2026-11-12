### Changed

- **The runner and the edge no longer carry the in-browser pod or workspace previews.** `source.preview`, its hidden `refs/previews/<user>/<branch>` refs and `EnvironmentKind::Workspace` are gone, so an environment is always one branch; `source.bundle` and `source/archive` (the language-service bundle and the workspace tarball) are gone with the editor that read them. The pod host (`pod-<app id>.<base>`) is gone from the route table and the TLS ask, and its `preview` route-table kind is refused by the edge (the previous table keeps serving).
- `RUNNER_ENVIRONMENT_TTL_H` is removed with the sweep it configured; branch environments still live until their branch or their row goes.

### Operator action required

- On upgrade the runner tears down every environment row left from workspace previews before it serves: the fleet is stopped, the local state and `envs/<slug>/<label>` prefix are deleted, every `refs/previews/*` ref is deleted from every app's mirror and durable manifest (a one-shot sweep, because the old teardown removed the row but left the hidden ref), the route is rebuilt without its host, and the row is removed. A failure is logged and retried on the next boot instead of aborting it (a corrupt manifest or a racing runner must not brick the install); nothing is left half-deleted. The control host also answers a permanent 404 for the retired pod asset paths, covering the window before the new control generation is deployed.
- Remove `RUNNER_ENVIRONMENT_TTL_H` from your environment if you set it; it is no longer read.
