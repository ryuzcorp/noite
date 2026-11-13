### Changed

- `security-gate` keeps `security-reviewed` across a pure rebase. A push that only replays the PR's own commits onto a moved base (or the retarget GitHub performs when a stacked PR's lower layer squash-merges) no longer strips the label, so the review it stands for is not thrown away by a rebase; any change to the PR's own diff still strips it. The comparison is per commit over raw records — path, resulting mode, resulting blob — so an added, removed, renamed, re-moded or binary-changed file strips, a rebase's line numbers and context cannot hide one, and anything the gate cannot read (a merge commit in the PR's own range, a shallow history, a head GitHub no longer serves) fails closed by stripping.

### Operator action required

- None.
