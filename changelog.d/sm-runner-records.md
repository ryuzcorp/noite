### Fixed

- A pull request merge that raced a close could end up `closed` while still carrying a merge commit and timestamps; the merge box then showed a closed PR that had in fact been merged. Every PR state change is now a compare-and-swap, so the losing side is refused instead of overwriting.
- Reopening a merged pull request silently did nothing and could leave a live PR with a merge commit recorded; it now answers a conflict.
- A review submitted at the same moment a pull request was closed could be stored on the closed PR; the insert now refuses it.
- Pruning old error data left each surviving issue's displayed lifetime count including the pruned hours, so counts drifted above the retained series; the count is now recomputed in the same prune pass.
- A source map that was missing the first time an error was symbolicated stayed negatively cached for the runner's lifetime, so a map uploaded moments later never symbolicated. Negative map entries now expire like manifest entries.
- Deleting an app or an environment dropped its operator token rows but kept the process cache, so a recreated slug or label could be probed with the dead fleet token until the runner restarted; the cache is now invalidated with the rows.

### Changed

- Pull-request, review, custom-domain and error-issue states are closed Rust enums exported as TypeScript unions; the wire strings and JSON shapes are unchanged. Durable Object probe causes and scoped-credential `live`/`revoking` are named in code (no wire change), and the probe reason is logged at debug level.
