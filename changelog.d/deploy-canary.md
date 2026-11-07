### Added

- Deploys now prove the new generation before serving it: after staging, the deploy asks the staged generation for `HEAD <path>` (`RUNNER_DEPLOY_PROBE_PATH`, default `/`) through `celld invoke` — the staged pins plus the app as `--target`, like the staged migrations — before the one `celld activate` moves the pointer, on every deploy (a Void redeploy after its staged migrate, any other deploy right after its stage). An answered status below 500 activates; a 5xx or a missing answer fails the deploy with nothing activated, so the previous generation keeps serving until the new one is proven live. `RUNNER_DEPLOY_PROBE_TIMEOUT_S` (default 30) bounds the probe; empty path disables it (a celld without `invoke`).

### Operator action required

- None.
