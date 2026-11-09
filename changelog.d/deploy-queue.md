### Changed

- **A deploy that is waiting its turn now says so.** A rollback or an environment redeploy issued while the app is already building lists as **queued** — "queued behind the app's running deploy" — from the moment the request is accepted, instead of appearing only when its build starts (and staying badge-warning like an in-flight run, stoppable from the row).
