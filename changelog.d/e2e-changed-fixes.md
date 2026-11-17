### Fixed

- The PR e2e's changed-spec matching anchors on a path boundary, so `create.spec.ts` no longer also selects `delete-recreate.spec.ts` (a #359 multi-lane shard ran that unchanged spec's `@fast` test under `e2e-changed` and then failed the lane's edge-push proof with only tiny tests).
- A lane shard whose apps never deploy no longer has to show an edge route-table push: since the tick pushes only changed tables and the edge logs only newly applied generations, the boot table reaches the edge through the file Caddy loads in Provision, and a no-deploy shard legitimately has zero push lines. Shards that deploy still require two pushes (generation 2), and the no-reload/no-restart checks still pin the edge on every shard.
