### Fixed

- **Environment groups tell the truth.** A stopped environment reads as stopped in its group header with its last error still visible, and a preview deploy group no longer marks a release live while the environment is stopped.
- **Creating an environment never deploys a branch you did not pick.** A branch that disappears resets the selection, and submitting it is refused with a reason; a `?env=` link to a deleted environment says so instead of silently showing Production.
- **The app header's status dot and its Start/Stop label can no longer contradict each other.**
