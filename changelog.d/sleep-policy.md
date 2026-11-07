### Changed

- Scale-to-zero policy: Settings → Limits gains a per-app Sleep after threshold in seconds (`0` = never, valid range `60`–`2592000`); empty inherits the install default. Preview environments use their owning app's override, re-checked under the transition lock.
- `RUNNER_SLEEP_AFTER_H` unset now derives from detected memory (≤ 2 GiB: `1` h, ≤ 4 GiB: `6` h, else `24` h); an explicit value (including `0` = never) still wins.
- Apps running scheduled work (a non-empty `triggers.crons` or `queues.consumers` in the last deployed Wrangler config) no longer auto-sleep unless the owner set an explicit Sleep after override. Memory-pressure parking still parks them; the next request wakes them.
- A failed wake now records a tenant-visible `wake failed` fleet event and bumps the `wake_failed` sleep counter in `GET /v1/admin/stats`.

### Operator action required

- Scheduled apps no longer auto-sleep without an explicit override: if an install relied on idle-sleep for cron/queue workers, set Sleep after per app (Settings → Limits) or leave them awake.
- Small hosts derive a shorter threshold (`1` h at ≤ 2 GiB, `6` h at ≤ 4 GiB): set `RUNNER_SLEEP_AFTER_H` explicitly to keep the previous `24` h behavior.
