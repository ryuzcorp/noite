### Changed

- The create page's controls stay disabled until the client mounts, so a pre-hydration click can no longer submit a form the page is not ready to drive.

### Fixed

- **Creating an app from a dropped folder no longer creates a second app when the upload fails.** The form remembers the app it created, links to it, and its button becomes "Retry upload", which commits the folder into that app instead of stranding a second one.
- **The invitations banner answers one invitation at a time and reports a failure on its own row**, instead of one click disabling every invitation and one error reading as if it were about the whole list.
