### Fixed

- Renaming an app now runs as its own task, like delete: the control plane aborting the call (14 s lifecycle bound) only drops the waiter, and the move completes instead of leaving the row on the old slug with local dirs or S3 prefixes half moved. A slug that still belongs to another app answers `409` immediately; a slug freed by a delete has no leftovers (its purge completed before the row went away) and can be taken. Regression tests cover a taken target, a deleted target, and a dropped caller (the last fails without the detached task: the move is canceled and the row stays on the old slug).

### Operator action required

- None.
