### Fixed

- Code mode no longer says a repository has no files when it only has no `?file=`: a browse now opens `package.json`, then `README.md`, then the first file in tree order, and only a ref with no files at all shows the empty note. The chosen file is written to `?file=` in place (`replaceState`), so Back still leaves the page.

### Changed

- The open file's name header stays pinned at the top of the code pane while a long file scrolls under it, in both themes and on narrow panes (long names truncate).
