### Fixed

- Deleting an app now frees its slug as soon as the app row is gone: the stop of any re-spawned fleet, then the push guard and deploy claim, run before the post-delete cleanup (edge route push, provider key revoke, operator-token cleanup). A slow or hung cleanup step used to keep the slug taken after the app had disappeared from the list, so create or rename onto that slug waited on the guard past the control plane's 5 s and failed with "operation aborted due to timeout". The remaining cleanup is bounded to 30 s and logged when it outlives that, so a hung provider call can no longer outlive the delete task.
- Create, rename and delete runner calls in the control UI now allow 14 s (the route's own bound is 15 s) instead of the 5 s default (the runner still answers delete within 3 s): clearing a deleted slug's leftovers or moving a large S3 prefix no longer shows as an abort while the runner is still working.

### Operator action required

- None.
