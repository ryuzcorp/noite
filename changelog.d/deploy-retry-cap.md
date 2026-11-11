### Changed

- The runner stops retrying a deploy that keeps failing: after two consecutive failed deploys of the same target (app or environment) at the same sha, its automatic deploys of that sha are paused instead of looping. A new push, or an explicit Deploy/Redeploy/Rollback — the same action that applies a build-affecting settings or env-var change — resumes them.
- The app row and each environment carry an additive `autoDeploy` field (`eligible`, `failing`, `exhausted` or `stopped` with the sha and failure count), derived from the deploy rows so it survives a restart, and the Deployments tab shows "Automatic deploys paused after 2 failed attempts of `<sha>`; push a fix or deploy manually". The second failure also records an `auto deploy paused` app event.

### Operator action required

- Automatic deploys of a failing sha now stop after two consecutive failures. Nothing to configure: the state is derived from the existing deploy history, and any new push or manual deploy resumes it.
