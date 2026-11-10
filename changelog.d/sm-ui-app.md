### Fixed

- Stopping a deploy that already finished no longer leaves a permanent red error inside the row; it says the deploy already finished.
- The header's Deploy menu no longer claims there is no earlier deploy to roll back to when the lookup itself failed; it shows the failure with a retry.
- Double-clicking Stop, Roll back or Redeploy can no longer send the destructive call twice.
- The Deployments tab's Start/Stop and import retry no longer poll silently for up to three minutes: the app's state stream settles them, and a missed deadline shows an explicit "still waiting" notice.
- A preview deploy group no longer marks a release as live when the environment is stopped.
- Creating an environment never deploys a branch the user did not pick: a branch that disappears resets the selection, and a submit for it is refused with a reason.
- A `?env=` link to a deleted environment now says so instead of silently showing Production.
- The app header's status dot and Start/Stop label can no longer contradict each other.
- A stopped environment now shows as stopped in its group header, with its last error still visible.

### Changed

- The app detail page's deploy row, Deploy menu, environment group, variable editor, create-environment dialog and header are explicit state machines; their status decoding goes through one shared lifecycle helper, and role gates through one capability table.
- The Settings forms (limits, branch protection, name) track their draft against the last saved value, so an unchanged Save is disabled and a failed save keeps the input.
- The control app treats an unanswered control-fleet status as unknown instead of assuming the fleet exists.
