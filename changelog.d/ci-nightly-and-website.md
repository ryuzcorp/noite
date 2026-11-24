### Fixed

- The nightly `e2e` schedule plans its suite again. A `schedule` event carries no workflow inputs, so `e2e.yml`'s plan job handed `e2e-plan.ts` an empty `--suite` and the run died before any lane started (`suite must be fast or release, not `, every night since 2026-11-17). An empty request now resolves to `release`, which the workflow comment and the lane's `|| 'release'` fallback already meant.
- The docs site builds again. `docs/apps/create.mdx` quoted the sync dialog's commit count as `<N>`, which MDX read as an unclosed JSX element (`BLUME_MDX_SYNTAX`): the page was dropped, the build failed, and the `meta.ts` entry that ordered it warned `BLUME_META_UNKNOWN_PAGE`. The placeholder is now a code span, like the page's other placeholders.
