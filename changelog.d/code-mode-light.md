### Changed

- **Code mode is a light editor.** The file tree, the `@pierre/diffs` editor, diffs, the Changes panel and one Push per commit stay; everything around them was replaced by three calls to the runner: read a ref's listing, read one file's committed text, and post one commit. An edit is now a blob read, a buffer in the page and an HTTP `POST`, so a failure is a status code instead of a dead frame, and unsaved work is the page's alone.

- **Payload:** a Code mode page view drops from **2.0 MB to 0.65 MB of JavaScript transferred** (8.4 MB → 2.16 MB decoded, 56 → 29 chunks); the route's own chunks are 0.12 MB of the total.

- the **in-browser Terminal** and with it `npm install`, a dev server and any command run locally;
- **unsaved work across reloads and tabs**: buffers live in the page, so a reload, a new tab or a page leave drops them (the page warns first, and a ref switch with unsaved edits asks before discarding). Nothing is written to IndexedDB or shared between tabs any more;
- the **TypeScript language service** (diagnostics, hover, go-to-definition, inline prediction) with the 6.5 MB worker and its `esm.sh` fetches — there is no network-free replacement that keeps those features without shipping a compiler, so the editor is a syntax-highlighting text editor;
- the **Preview panel and workspace previews** (`refs/previews/<user>/<branch>`, **Deploy preview**): previews are deployed environments, so commit to a branch that has an environment, or open a pull request from a new branch;
- the **pod host** (`pod-<app id>.<base>`), its second build entry and the cross-origin isolation headers, which removes the last per-app certificate and DNS alias Code mode needed.

- Still there: New File, Rename/move, Delete, uploads, Restore/Discard, commit to a branch or a new branch with the pull-request link, branch protection, History, commit pages, compare, and read-only refs.

### Fixed

- The editor no longer loses keystrokes, scroll position or the open file's text when the page repaints, when a branch switch lands, when a second tab is open, or when a pod worker dies: there is one copy of the text (the page's buffer) and one writer.
