/**
 * Forge reads and branch mutations (F1–F3): the runner client functions
 * behind the same role gates their RPCs expect, resolved through the shared
 * `roleFor` helpers. Reads are `view`, branch create is `push`, branch
 * delete is `admin` (contract §"Forge read RPCs").
 */
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { action, withSchema } from "oxidejs";

import { requireAppRole } from "../collaborators";
import {
  runnerGitBranchCreate,
  runnerGitBranchDelete,
  runnerGitCommit,
  runnerGitCompare,
  runnerGitLog,
  runnerGitRefs,
} from "../runner";
import { AuthError, requireViewApp, sessionUser } from "./session.server";

const GitRefsArgs = Schema.Struct({ appId: Schema.String });
const GitLogArgs = Schema.Struct({
  appId: Schema.String,
  limit: Schema.optional(Schema.Number),
  path: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  skip: Schema.optional(Schema.Number),
});
/** What `gitLog` takes; optional fields are omitted, never `undefined`. */
export type GitLogInput = Mutable<typeof GitLogArgs.Type>;
const GitCommitArgs = Schema.Struct({
  appId: Schema.String,
  sha: Schema.String,
});
const GitCompareArgs = Schema.Struct({
  appId: Schema.String,
  base: Schema.String,
  head: Schema.String,
});
const GitBranchCreateArgs = Schema.Struct({
  appId: Schema.String,
  from: Schema.String,
  name: Schema.String,
});
const GitBranchDeleteArgs = Schema.Struct({
  appId: Schema.String,
  name: Schema.String,
});

/** Branches with their tip, last commit and ahead/behind vs main. */
export const gitRefs = action(
  withSchema(GitRefsArgs, async ({ appId }) => {
    await requireViewApp(appId);
    return runnerGitRefs(appId);
  }),
  { error: AuthError }
);

/** One page of a ref's history, optionally scoped to a path. */
export const gitLog = action(
  withSchema(GitLogArgs, async ({ appId, limit, path, ref, skip }) => {
    await requireViewApp(appId);
    return runnerGitLog(appId, { limit, path, ref, skip });
  }),
  { error: AuthError }
);

/** One commit with its first-parent diff. */
export const gitCommit = action(
  withSchema(GitCommitArgs, async ({ appId, sha }) => {
    await requireViewApp(appId);
    return runnerGitCommit(appId, sha);
  }),
  { error: AuthError }
);

/** Merge-base, `base..head` commits, three-dot diff and mergeability. */
export const gitCompare = action(
  withSchema(GitCompareArgs, async ({ appId, base, head }) => {
    await requireViewApp(appId);
    return runnerGitCompare(appId, base, head);
  }),
  { error: AuthError }
);

/** Create a branch from a ref or SHA (push-gated). */
export const gitBranchCreate = action(
  withSchema(GitBranchCreateArgs, async ({ appId, from, name }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    return runnerGitBranchCreate(appId, name, from);
  }),
  { error: AuthError }
);

/** Delete a branch (admin only; the runner refuses `main`). */
export const gitBranchDelete = action(
  withSchema(GitBranchDeleteArgs, async ({ appId, name }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    return runnerGitBranchDelete(appId, name);
  }),
  { error: AuthError }
);
