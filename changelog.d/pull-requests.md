### Fixed

- **Pull-request state changes are compare-and-swap.** A merge that raced a close can no longer leave the PR closed while carrying a merge commit, reopening a merged PR answers a conflict instead of silently doing nothing, and a review submitted as the PR closes is refused instead of stored on the closed pull.
- **The pull-request view only offers actions that can succeed.** A duplicate base/head pair can no longer be posted twice and Create waits for the branch compare; Merge is offered only when the pull is mergeable and Reopen only when its head branch still exists; a dismissed or older-head review no longer disables the review buttons for the session.
