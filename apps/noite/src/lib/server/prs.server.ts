/**
 * Pull-request server actions (F4): the runner's `prs.*` / `branch_rules.*`
 * RPCs behind the same role gates their RPCs expect. Reads (`prsList`,
 * `prsGet`, `branchRulesGet`, `prsUserNames`, `prsViewer`) are `view`;
 * `prsCreate`, `prsComment`, `prsReview`, `prsMerge`, `prsCommentEdit`,
 * `prsCommentDelete` and `prsUpdate` are `push` (the runner itself enforces
 * author-or-admin on update/delete); `branchRulesSet` is `admin`. Every
 * mutation builds `actor={userId,name}` from the session and passes the role
 * the gate resolved, which the runner trusts for policy.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";
import type { Mutable } from "effect/Types";
import { action, withSchema } from "oxidejs";

import { requireAppRole } from "../collaborators";
import { withDb } from "../db";
import {
  runnerBranchRulesGet,
  runnerBranchRulesSet,
  runnerPrComment,
  runnerPrCommentDelete,
  runnerPrCommentEdit,
  runnerPrCreate,
  runnerPrGet,
  runnerPrMerge,
  runnerPrReview,
  runnerPrsList,
  runnerPrUpdate,
} from "../runner";
import { AuthError, requireViewApp, sessionUser } from "./session.server";

const AppIdArgs = Schema.Struct({ appId: Schema.String });
const PrListArgs = Schema.Struct({
  appId: Schema.String,
  limit: Schema.optional(Schema.Number),
  skip: Schema.optional(Schema.Number),
  state: Schema.optional(Schema.String),
});
const PrGetArgs = Schema.Struct({
  appId: Schema.String,
  number: Schema.Number,
});
const PrCreateArgs = Schema.Struct({
  appId: Schema.String,
  base: Schema.String,
  body: Schema.optional(Schema.String),
  head: Schema.String,
  title: Schema.String,
});
/** What `prsCreate` takes; optional fields are omitted, never `undefined`. */
export type PrCreateInput = Mutable<typeof PrCreateArgs.Type>;
const PrUpdateArgs = Schema.Struct({
  appId: Schema.String,
  body: Schema.optional(Schema.String),
  number: Schema.Number,
  state: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
});
const PrCommentArgs = Schema.Struct({
  appId: Schema.String,
  body: Schema.String,
  commitSha: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
  number: Schema.Number,
  path: Schema.optional(Schema.String),
  side: Schema.optional(Schema.String),
});
const PrCommentEditArgs = Schema.Struct({
  appId: Schema.String,
  body: Schema.String,
  commentId: Schema.String,
});
const PrCommentDeleteArgs = Schema.Struct({
  appId: Schema.String,
  commentId: Schema.String,
});
const PrReviewArgs = Schema.Struct({
  appId: Schema.String,
  number: Schema.Number,
  state: Schema.Union([
    Schema.Literal("approved"),
    Schema.Literal("changes_requested"),
  ]),
});
const PrMergeArgs = Schema.Struct({
  appId: Schema.String,
  deleteBranch: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.String),
  number: Schema.Number,
  title: Schema.optional(Schema.String),
});
/** What `prsMerge` takes; optional fields are omitted, never `undefined`. */
export type PrMergeInput = Mutable<typeof PrMergeArgs.Type>;
const BranchRulesSetArgs = Schema.Struct({
  appId: Schema.String,
  requirePr: Schema.Boolean,
  requiredApprovals: Schema.Number,
});
const PrNamesArgs = Schema.Struct({
  appId: Schema.String,
  userIds: Schema.Array(Schema.String),
});

interface UserNameRow {
  id: string;
  name: string | null;
}

const userNamesQuery = (ids: string[]) =>
  Effect.gen(function* run() {
    const sql = yield* SqlClient;
    const placeholders = ids.map(() => "?").join(", ");
    return yield* sql.unsafe(
      `SELECT id, name FROM "user" WHERE id IN (${placeholders})`,
      ids
    );
  });

/** Display names for user ids in one query; ids with no account (or a blank
 * name) stay absent so callers render "Former user". */
export const resolveUserNames = async (
  userIds: readonly string[]
): Promise<Record<string, string>> => {
  const ids = [...new Set(userIds.filter((id) => id !== ""))];
  if (ids.length === 0) {
    return {};
  }
  // SAFETY: the projection is exactly the id/name columns; D1 returns plain rows.
  const rows = (await withDb(userNamesQuery(ids))) as UserNameRow[];
  const names: Record<string, string> = {};
  for (const row of rows) {
    if (row.name !== null && row.name !== "") {
      names[row.id] = row.name;
    }
  }
  return names;
};

/** Names for the ids a pull-request page renders (view-gated). */
export const prsUserNames = action(
  withSchema(PrNamesArgs, async ({ appId, userIds }) => {
    await requireViewApp(appId);
    return resolveUserNames(userIds);
  }),
  { error: AuthError }
);

/** The viewer's identity for this app: the PR pages compare author ids
 * against it to show edit/delete only for own work. */
export const prsViewer = action(
  withSchema(AppIdArgs, async ({ appId }) => {
    const user = await sessionUser();
    const { role } = await requireAppRole(appId, user.id, "view");
    return { id: user.id, name: user.name, role };
  }),
  { error: AuthError }
);

/** The app's branch protection rule (anyone who can view the app). */
export const branchRulesGet = action(
  withSchema(AppIdArgs, async ({ appId }) => {
    await requireViewApp(appId);
    return runnerBranchRulesGet(appId);
  }),
  { error: AuthError }
);

/** Replace the branch protection rule (admin only). */
export const branchRulesSet = action(
  withSchema(
    BranchRulesSetArgs,
    async ({ appId, requirePr, requiredApprovals }) => {
      const user = await sessionUser();
      await requireAppRole(appId, user.id, "admin");
      return runnerBranchRulesSet(appId, { requirePr, requiredApprovals });
    }
  ),
  { error: AuthError }
);

/** Newest-first pull requests with their state counts. */
export const prsList = action(
  withSchema(PrListArgs, async ({ appId, limit, skip, state }) => {
    await requireViewApp(appId);
    return runnerPrsList(appId, { limit, skip, state });
  }),
  { error: AuthError }
);

/** One pull request: comments, reviews, live compare and merge state. */
export const prsGet = action(
  withSchema(PrGetArgs, async ({ appId, number }) => {
    await requireViewApp(appId);
    return runnerPrGet(appId, number);
  }),
  { error: AuthError }
);

/** Open a pull request (push-gated). */
export const prsCreate = action(
  withSchema(PrCreateArgs, async ({ appId, base, body, head, title }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    return runnerPrCreate(appId, {
      actor: { name: user.name, userId: user.id },
      base,
      body,
      head,
      title,
    });
  }),
  { error: AuthError }
);

/** Edit title/body or close/reopen (push-gated; the runner allows only the
 * author or an admin). */
export const prsUpdate = action(
  withSchema(PrUpdateArgs, async ({ appId, number, body, state, title }) => {
    const user = await sessionUser();
    const { role } = await requireAppRole(appId, user.id, "push");
    return runnerPrUpdate(appId, number, {
      actor: { name: user.name, userId: user.id },
      body,
      role,
      state,
      title,
    });
  }),
  { error: AuthError }
);

/** Comment on the conversation, or on a diff line when the full anchor
 * (`path`, `line`, `side`, `commitSha`) is present (push-gated). */
export const prsComment = action(
  withSchema(
    PrCommentArgs,
    async ({ appId, number, body, commitSha, line, path, side }) => {
      const user = await sessionUser();
      const { role } = await requireAppRole(appId, user.id, "push");
      return runnerPrComment(appId, number, {
        actor: { name: user.name, userId: user.id },
        body,
        commitSha,
        line,
        path,
        role,
        side,
      });
    }
  ),
  { error: AuthError }
);

/** Edit one's own comment (push-gated; the runner allows only the author). */
export const prsCommentEdit = action(
  withSchema(PrCommentEditArgs, async ({ appId, commentId, body }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    return runnerPrCommentEdit(appId, commentId, {
      actor: { name: user.name, userId: user.id },
      body,
    });
  }),
  { error: AuthError }
);

/** Delete a comment (push-gated; the runner allows the author or an admin). */
export const prsCommentDelete = action(
  withSchema(PrCommentDeleteArgs, async ({ appId, commentId }) => {
    const user = await sessionUser();
    const { role } = await requireAppRole(appId, user.id, "push");
    return runnerPrCommentDelete(appId, commentId, {
      actor: { name: user.name, userId: user.id },
      role,
    });
  }),
  { error: AuthError }
);

/** Approve or request changes (push-gated; nobody approves their own). */
export const prsReview = action(
  withSchema(PrReviewArgs, async ({ appId, number, state }) => {
    const user = await sessionUser();
    const { role } = await requireAppRole(appId, user.id, "push");
    return runnerPrReview(appId, number, {
      actor: { name: user.name, userId: user.id },
      role,
      state,
    });
  }),
  { error: AuthError }
);

/** Squash-merge (push-gated). The merge commit is attributed to the PR
 * author through their noreply identity, so the author's display name is
 * resolved from D1 and left undefined when the account is gone. */
export const prsMerge = action(
  withSchema(
    PrMergeArgs,
    async ({ appId, number, deleteBranch, message, title }) => {
      const user = await sessionUser();
      const { role } = await requireAppRole(appId, user.id, "push");
      const detail = await runnerPrGet(appId, number);
      const names = await resolveUserNames([detail.pullRequest.authorId]);
      return runnerPrMerge(appId, number, {
        actor: { name: user.name, userId: user.id },
        authorName: names[detail.pullRequest.authorId],
        deleteBranch,
        message,
        role,
        title,
      });
    }
  ),
  { error: AuthError }
);
