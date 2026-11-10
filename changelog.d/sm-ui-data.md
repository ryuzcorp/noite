### Fixed

- Deleting rows in the D1 table editor can no longer remove rows you did not pick: the selection is keyed by each record's own key, so a refresh, a sort or a background reload cannot remap it onto other rows.
- Clearing a D1 selection now also cancels an armed delete confirmation; editing the selection does the same, so the confirmation always matches the payload it sends.
- Esc during a save in the row editor no longer closes the dialog and loses the unsaved-changes guard; edits are refused while a write is in flight.
- Opening a D1 row editor on a record whose values equal the previous one now resets the fields instead of carrying the previous drafts.
- The D1 row editor no longer restores text that was typed and then hidden by the NULL toggle.
- The D1 toolbar search no longer commits a stale query onto another table's URL after you switch tables, and its box shows the applied query again after a table switch or a foreign-key jump.
- R2 bulk delete can no longer remove objects the search filtered out of the view, and the header checkbox shows a partial selection as indeterminate instead of unchecked.
- A slow R2 upload no longer disables the detail panel's own delete, and a page-level error banner no longer outlives the write it described.
- The new-folder form keeps its typed name and stays open when the runner refuses the create, and explains an invalid name instead of only disabling the button.
- Creating a pull request can no longer post a duplicate for a base/head pair that already has an open pull, and Create stays disabled until the branch compare has landed.
- The merge button is only offered when the pull is actually mergeable, Proposing Reopen only when its head branch still exists; unknown states no longer render as closable.
- A review that no longer counts (dismissed, or recorded at an older head) no longer leaves the review buttons disabled for the whole session.
- A failed reload of the D1 grid, R2 listing, Durable Object list or a pull request now shows an error banner above the last loaded data instead of presenting stale data as fresh.
- D1 grid, R2 and pull-request write errors are now announced to assistive technology instead of being visually-only text.

### Changed

- The storage and pull-request views now drive their selection, write, editor, search, paging, review and validation lifecycles through explicit state machines (typed transitions in one function per machine) instead of parallel busy/error/flag atoms.
