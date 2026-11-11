### Added

- **Every deploy row says why it ran.** A new `intent` field (`deploy`, `rollback` or `redeploy`) records the trigger: a push, a web commit or the runner's tip sweep is `deploy`, `POST /v1/apps/{id}/rollback` is `rollback`, and an environment deploy or the UI's Redeploy is `redeploy`. It is set once when the row is created and never rewritten, so a rollback that then fails still reads `rollback`. It rides on every deploy row (REST, RPC, MCP `deploy_status`), and the Deployments tab labels history **Rollback to `<sha>`** / **Redeploy**; a plain deploy is unlabelled.

### Changed

- **A stopped deploy is `cancelled`; a swept one is `stalled`.** Both used to be recorded as `failed`, with the cause only in the log text. The stop endpoint and a run that finds its own token tripped close the row as `cancelled`, the stuck-deploy sweep closes a row nothing reported on as `stalled`, and both are terminal through the same guarded writers: a late log line, a second stop or a second sweep is refused. The app and environment chip still reads failed with the stop or timeout as its summary, while the Deployments tab shows **Stopped** and **Timed out** badges.
- **Automatic deploys stop retrying a failing sha.** After two consecutive failed deploys of the same target (app or environment) at the same sha, automatic deploys of that sha pause instead of looping; a new push or an explicit Deploy/Redeploy/Rollback resumes them. The app row and each environment carry an `autoDeploy` state (`eligible`, `failing`, `exhausted` or `stopped`, with the sha and failure count) derived from the deploy rows so it survives a restart, the Deployments tab says "Automatic deploys paused after 2 failed attempts of `<sha>`; push a fix or deploy manually", and each target records its own "auto deploy paused" event.

### Fixed

- **Stopping a deploy either prevents it or refuses cleanly.** Activation is now the point of no return in one step: a stop before it wins and nothing activates, a stop after it answers 409 with the deploy finishing normally, and the row is no longer marked failed while the new generation serves.
- **A finished deploy row can no longer be rewritten.** A late log line, a second stop, the stall sweep or a retried deploy is refused instead of moving a `failed` or `success` row back to `building` or flipping its story.
- **The git-tip sweep no longer undoes a rollback.** The fallback sweep deployed the branch tip whenever `last_deploy_sha` differed from it, so a rollback was silently replaced by the tip within a minute. It now only deploys a tip whose sha has never been deployed successfully in that target: an already-built release the live sha moved off is the operator's choice, while pushes and explicit redeploys deploy on their own trigger.
- **The Deployments tab's Start/Stop and import retry settle from the app's state stream** instead of polling silently for up to three minutes; a missed deadline shows an explicit "still waiting" notice.
- **Stopping a deploy that already finished no longer leaves a permanent red error inside the row**; it says the deploy already finished.
- **MCP `deploy_status` reports `live` correctly again.** A sleeping (scale-to-zero) app reads `live: true` because it serves on the next request, while a crash- or OOM-held fleet reads `false` even though its row still says `running`.

### Operator action required

- **Runner schema version 101.** Booting this image on an existing install adds `deploy.intent` (`TEXT NOT NULL DEFAULT 'deploy'`) in the boot transaction; every row written before it reads `deploy`, nothing needs backfilling, and the upgrade is automatic — only a downgrade is refused as before. Deploy API consumers get one new additive field on every deploy row, and the generated `Deploy` binding gained the required field.
- **API and SDK consumers must treat `cancelled` and `stalled` as terminal failures.** `DeployStatus` (runner REST/RPC and the generated binding) gains the two values; code that branched on `status === 'failed'` to stop polling should branch on "terminal" instead. A terminal non-success still means the deploy did not land, so a client that exits non-zero on `failed` must exit non-zero on both new values. There is no schema change (the column is TEXT with no CHECK) and rows written before the upgrade stay `failed`.
- **Automatic deploys of a failing sha now stop after two consecutive failures.** Nothing to configure: the state is derived from the existing deploy history, and any new push or manual deploy resumes it.
