### Fixed

- The control plane's live feeds no longer die at Cello's outbound fetch
  budget. Every live feed the control UI serves (the app state stream, app
  list, deploys, logs, events, errors and metrics) is a Worker `fetch()` to
  the runner, and Cello applied `CELLO_FETCH_TIMEOUT_S` (120 s) as a total
  request deadline that covered the response body: the raw
  `GET /api/apps/<id>/state/stream` ended at 120.01 s while keepalive frames
  were still flowing (Caddy relayed fine and logged the upstream's
  `unexpected EOF`). The fix is in Cello, whose budget now bounds the
  connect and the response head, never a live body; the HTTP stream idle
  deadline still ends a body that stops making progress. This release picks
  up that Cello version.

### Added

- `RUNNER_CONTROL_FETCH_TIMEOUT_S` (unset by default: Cello's own 120) →
  `CELLO_FETCH_TIMEOUT_S` on the control fleet only. The e2e lane sets it to
  `5` so `e2e/stream-lifetime.spec.ts` can prove a control-plane SSE outlives
  the budget instead of waiting out the 120 s default.
