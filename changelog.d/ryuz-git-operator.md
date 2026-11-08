### Operator action required

- The first push to each repository after upgrading rewrites its `git/{slug}/MANIFEST.json` as manifest v2. This build reads v1 and v2; an older build reads only v1. Do not roll back to an image older than this release after pushing: git pushes to already-upgraded repositories fail until the `git/` prefix is restored from a backup. No manual step is needed to upgrade.
