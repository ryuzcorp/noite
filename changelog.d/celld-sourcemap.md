### Changed

- Worker source maps now come from `celld deploy --sourcemap` instead of the runner's shadow esbuild bundle: the map celld writes for the app deploy is stored for the Errors tab, chained through the build's own entry map as before, so symbolicated stacks still show project-root-relative paths. The shadow bundle, its byte-verify step, and the mirrored esbuild flags, banner, and externals are deleted, so celld bumps no longer need a bundling re-verify.
- `no_bundle` apps no longer get a Worker map: celld writes no map for entries it deploys unbundled, so those stacks render raw instead of resolving through the entry's sibling map.
