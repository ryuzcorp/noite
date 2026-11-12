### Fixed

- A stopped or killed deploy no longer wedges the app's git mirror: the checkout of a build worktree used the bare mirror's own index, so a leftover `index.lock` failed every later deploy of that app ("Unable to create '…/index.lock': File exists"). Every checkout now owns its index file, so a concurrent read (d1's project dir, a source preview, a preview environment) or a stop mid-checkout cannot break the next deploy — and a checkout no longer moves the mirror's `HEAD`.
