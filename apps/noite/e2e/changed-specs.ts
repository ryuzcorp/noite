// `testMatch` patterns for the PR's rewritten specs (E2E_CHANGED_SPECS, set
// by e2e.yml's plan job): each pattern selects exactly its own file. The
// match is anchored on a path boundary — a bare `create.spec.ts$` suffix
// also matches `e2e/delete-recreate.spec.ts`, which ran an unchanged spec
// under `e2e-changed` on #359.
const escapeRegExp = (text: string): string =>
  text.replaceAll(/[/\\^$*+?.()|[\]{}]/gu, "\\$&");

export const changedSpecPatterns = (specs: string[]): RegExp[] =>
  specs.map((spec) => new RegExp(`(?:^|/)${escapeRegExp(spec)}$`, "u"));
