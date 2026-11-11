### Fixed

- **Deleting D1 rows can no longer remove rows you did not pick.** The selection is keyed by each record's own key, so a refresh, sort or background reload cannot remap it; clearing or editing the selection cancels an armed delete, Esc during a save no longer closes the dialog and loses the unsaved-changes guard, and edits are refused while a write is in flight.
- **The D1 row editor starts fresh.** Opening a record whose values equal the previous one resets the fields instead of carrying the previous drafts, and text hidden by the NULL toggle is not restored.
- **The D1 toolbar search no longer commits a stale query onto another table's URL**, and shows the applied query again after a table switch or a foreign-key jump.
- **R2 bulk delete can no longer remove objects the search filtered out**, and the header checkbox shows a partial selection as indeterminate instead of unchecked.
- **A slow R2 upload no longer disables the detail panel's own delete**, and a page-level error banner does not outlive the write it described.
- **The new-folder form keeps its typed name and stays open when the runner refuses the create**, and explains an invalid name instead of only disabling the button.
- **A failed reload of the D1 grid, R2 listing, Durable Object list or a pull request shows an error banner above the last loaded data** instead of presenting stale data as fresh, and D1, R2 and pull-request write errors are announced to assistive technology.
