/**
 * Forge reads and branch mutations (F1–F3): the runner client functions
 * behind the same role gates their RPCs expect, resolved through the shared
 * `roleFor` helpers. Reads are `view`, branch create is `push`, branch
 * delete is `admin` (contract §"Forge read RPCs").
 */
import * as Schema from "effect/Schema";

import { requireAppRole } from "../collaborators";
import {
  runnerGitBranchCreate,
  runnerGitBranchDelete,
  runnerGitCommit,
  runnerGitCompare,
  runnerGitLog,
  runnerGitRefs,
} from "../runner";
import { apiAction } from "./api";
import { requireViewApp, sessionUser } from "./session.server";

const GitRefsArgs = Schema.Struct({ appId: Schema.String });
const GitLogArgs = Schema.Struct({
  appId: Schema.String,
  limit: Schema.optional(Schema.Number),
  path: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  skip: Schema.optional(Schema.Number),
});
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
export const gitRefs = apiAction(
  GitRefsArgs,
  async ({ appId }, { env, request }) => {
    await requireViewApp(request, env, appId);
    return runnerGitRefs(appId);
  }
);

/** One page of a ref's history, optionally scoped to a path. */
export const gitLog = apiAction(
  GitLogArgs,
  async ({ appId, limit, path, ref, skip }, { env, request }) => {
    await requireViewApp(request, env, appId);
    return runnerGitLog(appId, { limit, path, ref, skip });
  }
);

/** One commit with its first-parent diff. */
export const gitCommit = apiAction(
  GitCommitArgs,
  async ({ appId, sha }, { env, request }) => {
    await requireViewApp(request, env, appId);
    return runnerGitCommit(appId, sha);
  }
);

/** Merge-base, `base..head` commits, three-dot diff and mergeability. */
export const gitCompare = apiAction(
  GitCompareArgs,
  async ({ appId, base, head }, { env, request }) => {
    await requireViewApp(request, env, appId);
    return runnerGitCompare(appId, base, head);
  }
);

/** Create a branch from a ref or SHA (push-gated). */
export const gitBranchCreate = apiAction(
  GitBranchCreateArgs,
  async ({ appId, from, name }, { env, request }) => {
    const user = await sessionUser(request, env);
    await requireAppRole(appId, user.id, "push");
    return runnerGitBranchCreate(appId, name, from);
  }
);

/** Delete a branch (admin only; the runner refuses `main`). */
export const gitBranchDelete = apiAction(
  GitBranchDeleteArgs,
  async ({ appId, name }, { env, request }) => {
    const user = await sessionUser(request, env);
    await requireAppRole(appId, user.id, "admin");
    return runnerGitBranchDelete(appId, name);
  }
);
