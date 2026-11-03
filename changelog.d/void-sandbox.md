### Added

- Void apps with a managed sandbox now get a working `__VOID_SANDBOX` service binding: each sandbox deploy cohosts the runner-owned `noite-void-sandbox` controller script in the fleet next to the app — controller first, proxy second, app last — so `getSandbox()` returns a live cell stub instead of throwing `SandboxUnavailableError`. Previews get their own controller; a script whose content hash matches the stored one is skipped, so steady state stays one app deploy.
- The app's sandbox `containers[]` entry moves to the controller config through the existing Dockerfile check/vet/pin (Void's `scheduling_policy` dropped, the controller class and stable name mapped, the admission cap as the `max_instances` backstop). A direct registry ref must be digest-pinned (`@sha256:` plus 64 lowercase hex); an unpinned tag fails the deploy before anything builds. `instanceType` is ignored in v1.
- A sandbox app whose `void` major differs from the controller bundle's fails the deploy with Void's own upgrade message ("Managed Sandboxes require an updated Void runtime…"), before anything deploys; the deploy records the app `void` version, the bundle `void` version + sha256, and the protocol.
- Operator cap `NOITE_VOID_SANDBOX_MAX_CONCURRENT` (default `4`; `0` admits none; validated at boot), rendered as `__VOID_SANDBOX_MAX_CONCURRENT` plus the `max_instances` backstop. Over the cap, `getSandbox()` throws Void's `SandboxLimitError`.
- Sandbox `exec` supports PTY terminal sessions (`pty: true` or `{ cols, rows }`): the wire `isPty` reports the terminal and `resize(cols, rows)` resizes it (celld patch `0006`).
- Known deviations: aborts kill the process — the platform has no signal delivery into the container.

### Fixed

- The sandbox controller no longer redeploys on every deploy: per-deploy container-image paths are excluded from its content hash (the pinned-Dockerfile + build-context digest carries the content), so identical content in another build dir skips like the proxy does — which also removes the common case of two concurrent deploys racing celld's fence-image build.
- Cohosted script deploys (controller, proxy) retry once on infra-class errors, like the app deploy; tenant failures still fail at once.
