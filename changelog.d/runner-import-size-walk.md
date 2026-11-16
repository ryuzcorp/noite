### Fixed

- GitHub imports and Sync from GitHub no longer fail spuriously with `No such file or directory`: the clone's on-disk size poll measured the scratch dir while git was still writing it, and a strict walk turned git's transient lock files (`config.lock`, `packed-refs.lock`, `pack-*.keep`) into a failed clone. The size walk now skips entries that vanish mid-walk, like the build-quota and cache-prune walks already did.
