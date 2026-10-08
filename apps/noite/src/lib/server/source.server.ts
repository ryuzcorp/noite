import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { action, withSchema } from "oxidejs";

import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import {
  runnerSourceBlob,
  runnerSourceBundle,
  runnerSourceCommit,
  runnerSourceTree,
  runnerSourceTypes,
} from "../runner";
import type { SourceCommitBody } from "../runner";
import { AuthError, requireViewApp, sessionUser } from "./session.server";

/** Every source read takes an optional `ref` (branch, tag or SHA); Code mode
 * always sends one. Absent or `""` keeps the runner's deployed-SHA-then-HEAD
 * resolution; the runner refuses an empty ref, so `""` never reaches it. */
const SourceRefArgs = Schema.Struct({
  appId: Schema.String,
  ref: Schema.optional(Schema.String),
});

/** Source preview — the runner serves from the persistent bare mirror. */
const SourceBlobArgs = Schema.Struct({
  appId: Schema.String,
  path: Schema.String,
  ref: Schema.optional(Schema.String),
});
export const sourceTree = action(
  withSchema(SourceRefArgs, async ({ appId, ref }) => {
    await requireViewApp(appId);
    return runnerSourceTree(appId, ref || undefined);
  }),
  { error: AuthError }
);

export const sourceBlob = action(
  withSchema(SourceBlobArgs, async ({ appId, path, ref }) => {
    await requireViewApp(appId);
    return runnerSourceBlob(appId, path, ref || undefined);
  }),
  { error: AuthError }
);

/** Every text source in the repo at `ref`, for the language-service worker's
 * virtual FS (one round trip instead of one blob per file). Same ref rules as
 * `sourceTree`. */
export const sourceBundle = action(
  withSchema(SourceRefArgs, async ({ appId, ref }) => {
    await requireViewApp(appId);
    return runnerSourceBundle(appId, ref || undefined);
  }),
  { error: AuthError }
);

/** Declaration files captured from the app's last successful build — the
 * `node_modules` types the worker resolves imports against. No `ref`: the
 * capture belongs to the deployed build, whatever is being browsed. */
const SourceTypesArgs = Schema.Struct({ appId: Schema.String });
export const sourceTypes = action(
  withSchema(SourceTypesArgs, async ({ appId }) => {
    await requireViewApp(appId);
    return runnerSourceTypes(appId);
  }),
  { error: AuthError }
);

const SourceCommitArgs = Schema.Struct({
  appId: Schema.String,
  branch: Schema.optional(Schema.String),
  files: Schema.Array(
    Schema.Struct({ content: Schema.String, path: Schema.String })
  ),
  fromSha: Schema.optional(Schema.String),
  message: Schema.String,
});
/** What `sourceCommit` takes; optional fields are omitted, never `undefined`. */
export type SourceCommitInput = Mutable<typeof SourceCommitArgs.Type>;

/** Browser-edit commit (push-gated): validated files become a commit on
 * `main` (or on `branch`) that deploys like a stock push. The commit is
 * attributed to the session user through the noreply identity. */
export const sourceCommit = action(
  withSchema(
    SourceCommitArgs,
    async ({ appId, files, message, branch, fromSha }) => {
      const user = await sessionUser();
      const { role } = await requireAppRole(appId, user.id, "push");
      const body: SourceCommitBody = {
        actor: { name: user.name, userId: user.id },
        files: [...files],
        message,
        role,
      };
      if (branch !== undefined) {
        body.branch = branch;
      }
      if (fromSha !== undefined) {
        body.fromSha = fromSha;
      }
      try {
        return await runnerSourceCommit(appId, body);
      } catch (error) {
        failUnknown(error);
      }
    }
  ),
  { error: AuthError }
);
