### Added

- **Every deploy row says why it ran.** A new `deploy.intent` column (`deploy` | `rollback` | `redeploy`, the runner's `DeployIntent`) records the trigger instead of leaving it to be inferred: a push, a web commit or the runner's tip sweep is `deploy`, `POST /v1/apps/{id}/rollback` is `rollback`, and an environment deploy (`environments.deploy`, the UI's Redeploy) is `redeploy`. It is set once when the row is created (`db::deploys::queue_deploy`) and never rewritten, so a rollback that then fails still reads `rollback`. The field rides on every deploy row (REST, RPC, MCP `deploy_status`) and the Deployments tab labels the history **Rollback to `<sha>`** / **Redeploy**; a plain deploy is unlabelled.

### Operator action required

- **Runner schema version 101.** Booting this image on an existing install adds `deploy.intent` (`TEXT NOT NULL DEFAULT 'deploy'`) in the boot transaction; every row written before it reads `deploy`, nothing needs backfilling, and the upgrade is automatic — only a downgrade is refused as before. Deploy API consumers get one new field on every deploy row (`intent`), which is additive: clients that ignore unknown fields are unaffected, and `Deploy` in the generated UI bindings gained the required field.
