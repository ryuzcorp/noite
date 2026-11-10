### Fixed

- **Creating an app from a dropped folder no longer creates a second app when the upload fails.** The app was created and the folder's first commit failed, and the form left Create enabled with the folder still attached — pressing it again created another app and stranded the first one. The form now remembers the app it created, links to it, and its button becomes "Retry upload", which commits the folder into that app.
- **The invitations banner answers one invitation at a time and reports failures on the row they belong to.** Accept and Decline used to share one disabled flag and one error line, so one click greyed out every invitation and a failure read as if it were about the whole list.

### Changed

- **The create page's form is one explicit state machine** (`apps/noite/src/lib/apps/create-machine.ts`, an `@ilha/model` island): the mode, the dropped folder, where the slug came from, the slug verdict (keyed to the slug it checked), the drag/read overlay and the create-and-commit flow are one model with one `update`, so the button, the notice and the Slug field can no longer disagree. Its controls stay disabled until the client mounts, and the dropped-folder-beats-the-picker rule lives in a single function.
