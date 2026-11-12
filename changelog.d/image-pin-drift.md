### Changed

- `docker/check-versions.ts` splits its online leg: `--online` compares the immutable publisher pins (Node's signed `SHASUMS256.txt`, npm's `dist.integrity`, the GitHub release-asset digests, rustup's checksum) and gates every pull request; `--online-images` adds the image tag index digests. Official images re-push the same tag for a base-OS update, so `check.yml` resolves image digests only for a PR that changes a pin (`docker/Dockerfile`, `docker/compose.yaml`, CI's `rustfs` service or `platforms.mdx`), and the new weekly `pin-drift.yml` run does the full check and keeps one `Image pin drift` issue open while a pin no longer matches its publisher.

### Fixed

- `docker.io/library/rust:1-bookworm` is re-pinned to the digest the tag carries after upstream's base-OS rebuild. A moved tag no longer fails the `check` job on unrelated pull requests; it is reported by the weekly drift run instead.
