### Fixed

- Creating an app on a slug with a large deleted history no longer fails with "operation aborted due to timeout". The prefix purge now lists and deletes one page at a time (a canceled caller leaves progress instead of re-walking the whole prefix on every retry), and the create runs as its own task: the control plane's 14 s abort drops only the waiter, the row lands, and the GitHub import spawns. The control UI's create retry recognizes a `409` for a slug taken by the caller's own timed-out attempt and grants the account instead of failing.

### Operator action required

- None.
