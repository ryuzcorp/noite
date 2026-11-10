### Fixed

- **Stopping a deploy now either prevents it or refuses cleanly.** A stop that arrived while the staged generation was being activated could answer 200 and still let the deploy go live (and then mark the row failed while the new generation served traffic). Activation is now the point of no return in one step: a stop before it wins and nothing activates, a stop after it answers 409 with the deploy finishing normally.
- **A finished deploy row can no longer be rewritten.** A late log line, a second stop, the stall sweep or a retried deploy could move a `failed`/`success` row back to `building` or flip its story; every status write now carries the legal predecessor states, and the late writer is refused instead of rewriting history.
- **"Retry import" no longer breaks a healthy app.** Retrying an import used to set the app's status back to `importing` even while it was running, deploying or building, leaving the badge wrong until the next deploy. Retry is now refused with a 409 for an app that is deployed or busy.
- **An interrupted import can no longer block its own retry.** A panic inside an import task left the in-process "an import is running" claim behind forever, so every later retry answered "an import is already running" until the runner restarted. The claim is released on every exit path.
- **A failed import is stored as `error` rather than a status the API types did not know**, so a failed import no longer surfaces as an unknown badge value.
- **Deleting an app stops its running import first.** A background import that finished after the purge could publish `main` (and its bundles) under the slug the delete had just freed, so a later app created with that slug inherited the imported tree. The delete now stops the import, waits for it to end, and a ref move re-checks that the app still owns the slug; retry/patch/rename on an app being deleted answer 409 instead of writing into a freed slug.

### Changed

- The persisted status columns the runner reads (`app.status`, `environment.status`, `deploy.status`, `app.desired_state`, `environment.desired_state`, `environment.kind`, env-var `source`) are typed state machines in `apps/runner/src/models.rs`, each with one transition table, one guarded writer and an agent-readable state diagram; the emitted JSON and every stored value are unchanged.
- Env-var provenance is a closed type (`user`, `auth-default`, `void-proxy-token`, `void-sandbox-admission`); a `source` value outside it is refused loudly at read instead of silently routing a secret through the wrong merge.
- The in-process import and app-delete lifecycles are explicit phases with one transition function each (`Running`/`Done` for an import, `Purging`/`Cleanup` for a delete).
