### Fixed

- The pull-request e2e gate runs every spec file the PR rewrites in full, not just its `@fast`/`@isolation` tests: the `e2e / plan` job selects changed `apps/noite/e2e/**/*.spec.ts` from the PR diff and the lanes run them beside the tagged gate on both tenancy lanes. A changed shared helper (`e2e/helpers.ts`, fixtures, the setup ceremony, the Playwright config) escalates the gate to the release suite instead. A rewritten spec can no longer first run in the merge queue and fail there.
