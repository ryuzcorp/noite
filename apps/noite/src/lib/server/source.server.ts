import * as Schema from "effect/Schema";
import { action, withSchema } from "oxidejs";

import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import {
  runnerSourceBlob,
  runnerSourceCommit,
  runnerSourceDiff,
  runnerSourceTree,
} from "../runner";
import { AuthError, requireViewApp, sessionUser } from "./session.server";

const AppId = Schema.String;

/** Source preview — the runner serves from the persistent bare mirror. */
const SourceBlobArgs = Schema.Struct({
  appId: Schema.String,
  path: Schema.String,
});
export const sourceTree = action(
  withSchema(AppId, async (appId) => {
    await requireViewApp(appId);
    return runnerSourceTree(appId);
  }),
  { error: AuthError }
);

export const sourceBlob = action(
  withSchema(SourceBlobArgs, async ({ appId, path }) => {
    await requireViewApp(appId);
    return runnerSourceBlob(appId, path);
  }),
  { error: AuthError }
);

export const sourceDiff = action(
  withSchema(AppId, async (appId) => {
    await requireViewApp(appId);
    return runnerSourceDiff(appId);
  }),
  { error: AuthError }
);

const SourceCommitArgs = Schema.Struct({
  appId: Schema.String,
  files: Schema.Array(
    Schema.Struct({ content: Schema.String, path: Schema.String })
  ),
  message: Schema.String,
});

/** Browser-edit commit (push-gated): validated files become a main commit
 * that deploys like a stock push. The author is always the session user. */
export const sourceCommit = action(
  withSchema(SourceCommitArgs, async ({ appId, files, message }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    try {
      return await runnerSourceCommit(appId, {
        author: user.email,
        files: [...files],
        message,
      });
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);
