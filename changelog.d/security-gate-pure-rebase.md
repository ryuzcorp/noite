### Changed

- `security-gate` keeps `security-reviewed` across a pure rebase, and only across one. Adding the label now records what was reviewed — a marker comment holding the reviewed head, its merge base and the sha256 of the PR's own-change fingerprint list — and every later push, base retarget (`edited` is a trigger now) or reopen compares the current own change with that record: the same change replayed keeps the label, anything else strips it. Anchoring on the record rather than on the previous head closes the accidental bypass where a cancelled run left the label on an unreviewed head.
- The comparison is per commit over raw `-z` records — path, resulting mode, resulting blob — so an added, removed, renamed, re-moded or binary-changed file strips, a trailing space in a path cannot alias another path, and the stacked retarget after a lower layer's squash merge is accepted only when the base really carries the dropped commits (exact `ls-tree` paths, never a pathspec/glob). Anything unreadable strips: a merge commit in the PR's own range, a shallow history, an unservable head, an edited or missing marker.
- `security-gate` no longer passes `merge_group` unconditionally: every queued PR the gate marked sensitive must still carry `security-reviewed`, and its record must name the queued head.

### Operator action required

- None.
