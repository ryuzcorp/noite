### Fixed

- **Error counts no longer include pruned hours.** Pruning old error data recomputes each surviving issue's lifetime count in the same pass, so the displayed number matches the retained series instead of drifting above it.
- **A source map that was missing on first use no longer stays negatively cached forever.** A map uploaded moments later now symbolicates, because negative entries expire like manifest entries.
- **Deleting an app or environment drops its fleet-token process cache with its token rows**, so a recreated slug or label cannot be probed with the dead fleet token until the runner restarts.
