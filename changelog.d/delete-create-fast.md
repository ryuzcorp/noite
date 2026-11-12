### Fixed

- Deleting an app no longer leaves its host on the "paused" page, and no longer blocks creating an app — the same slug or any other — for minutes. The delete now stops the fleet, drops the row and pushes the edge route table before the destructive wipe starts, then wipes local dirs and the `git/`, `fleets/` and `envs/` prefixes as a background chore, so the slug is free the moment the call answers and the host answers "no app for this slug".
- A re-created slug only waits for at most one in-flight wipe batch: `apps.create` asks the registered background wipe to stop, the wipe ends at its next batch boundary and the create re-wipes under the slug's guard. A wipe that was queued for a re-created slug re-checks the row after taking the guard and leaves the new app's objects alone.
- Creating an app no longer takes a process-wide lock: the create is exclusive per slug (its push guard) and the per-account quota count-then-insert uses its own short lock taken after it. One create parked behind another app's slow delete/purge used to stall every create on the instance.
- Preview-environment and slug renames no longer hold the process-wide create lock; the target slug's push guard serializes them, with the slug-taken check repeated under the guards so a loser bails before moving anything.
- A delete's data wipe deletes in 250-key batches with a 50 ms gap between them instead of firing 1000-key `DeleteObjects` back to back, and request-path wipes (deleted-ref cleanup, environment teardown) are never paced behind it. On a small host that pacing is what keeps a concurrent deploy's own S3 client inside its timeouts — a bundled RustFS on a 2 GB host was timing out a tenant deploy during a purge.
- Create and delete failures name the step that failed and the store's reason (for example "create foo: could not clear the deleted app's data: …"), instead of a bare 500 or a generic message.

### Changed

- `DELETE /v1/apps/{id}` answers as soon as the row is gone (3 s bound): `204` when the cleanup also finished, `202` while the credential revoke or the background wipe still runs. The app disappears from `apps.list`/`apps.get` immediately, as before.
