# Cutting a release

Read before tagging or publishing.

**Cutting a release:** run `bun docker/changelog-release.ts x.y.z` (defaults the date to today; `--dry-run` prints without writing) to assemble `changelog.d/` into `## [x.y.z] - date` in canonical order with an `### Operator action required` section and delete the fragments, bump `packages/cli/package.json` to the same version (`docker/check-versions.ts` enforces it never falls behind), then run `bun install` so `bun.lock` carries the new workspace version (`--frozen-lockfile` doesn't catch the drift, and every later `bun install` rewrites it). Tag `vx.y.z`, try it with `install --pre`, then mark it as a release, which moves the channels. The tag's `images.yml` gate publishes `@noitenow/cli` to npm itself (dist-tag `alpha` for prereleases), so nothing runs by hand after the first publish.

The one local run CI cannot replace is a release-image smoke test (`TAG=<short-sha> make e2e`), which belongs to cutting a release.

A new tag takes a deliberate image-pin bump first; see [pins.md](pins.md).
