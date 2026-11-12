### Fixed

- The image build verifies every remote download before it unpacks it: the Node tarball against the sha256 in the release's signed `SHASUMS256.txt` (both architectures), esbuild against the `@esbuild/linux-*` package's registry sha512, the DuckDB CLI against the sha256 GitHub publishes for the release asset, and the dev target's rustup bootstrap against rustup's own `rustup-init.sha256` instead of piping a shell script. A re-pushed or tampered asset now fails the build rather than shipping.

### Changed

- Every external base image is pinned by tag _and_ multi-arch index digest — the Caddy builder, Node, rust, both bun stages (`BUN_DEBIAN_DIGEST`, `BUN_SLIM_DIGEST`) — and so is the bundled RustFS image in `docker/compose.yaml` and in CI's runner service. The readable tags stay next to the digests.
- `docker/check-versions.ts` fails when an external `FROM` has no digest, when a downloaded artifact has no per-arch checksum for amd64 _and_ arm64, when a checksum is defined but nothing verifies with it, when a download is piped straight into `tar`/`sh`, or when compose, CI and `platforms.mdx` disagree on the RustFS image. Its new `--online` leg (run in CI) compares every image digest and tarball checksum with the publisher's own file, so a version bump that leaves a stale digest fails the check. `AGENTS.md` documents how to update a pin.
