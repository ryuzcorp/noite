### Changed

- Settings → Environment variables now reach Worker code: every variable (or preview-environment override) is merged into the deployed config's `vars`, winning over the config's own value, so the Worker reads it as `env.NAME`. Previously only the install, build, release command and fleet saw them. A change still takes effect on the next deploy. Void's `secrets.required` list is checked before `celld deploy`: a required name with no setting fails the deploy naming it. Settings or config `vars` using the runner-owned names (`__VOID_PROXY`, `__PROJECT_ID`, `__VOID_PROXY_TOKEN`, `__VOID_PROJECT_SLUG`, `__VOID_EMAIL_DOMAIN`, `__VOID_EMAIL_DEPLOYMENT_ID`) fail the deploy; every other name, `BETTER_AUTH_*` included, deploys as a Worker var.

### Operator action required

- Settings values are now readable by Worker code via `env` (plaintext `vars` in the deployed config — celld has no secret store). If you kept a value in Settings specifically because Workers could not see it, move it out: there is no process-only tier anymore. A deploy that fails naming a reserved variable needs that variable renamed.
