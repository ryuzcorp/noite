import * as Schema from "effect/Schema";
import { action, fail, withSchema } from "oxidejs";

import { failUnknown, UnauthorizedError } from "../auth";
import {
  dropAppCollaborators,
  grantCollaborator,
  requireAppRole,
} from "../collaborators";
import { withDb } from "../db";
import {
  runnerCreateApp,
  runnerDeleteApp,
  runnerDeployLog,
  runnerGitRemote,
  runnerPatchApp,
  runnerRenameApp,
  runnerRollback,
} from "../runner";
import { AuthError, requireViewApp, sessionUser } from "./session.server";

const CreateApp = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
});
const AppId = Schema.String;
const SLUG_RE = /^[a-z0-9](?<slug>[a-z0-9-]{0,46}[a-z0-9])?$/u;
const RESERVED_SLUGS = new Set(["_control", "app", "api", "git"]);
export const create = action(
  withSchema(CreateApp, async ({ name, slug }) => {
    const user = await sessionUser();
    const trimmedName = name.trim();
    const normalized = slug.trim().toLowerCase();
    if (!trimmedName) {
      fail("Name is required");
    }
    if (RESERVED_SLUGS.has(normalized)) {
      fail("Slug is reserved");
    }
    if (!SLUG_RE.test(normalized)) {
      fail(
        "Slug must be 1–48 chars: lowercase letters, digits, and hyphens, starting and ending with a letter or digit"
      );
    }
    try {
      const app = await runnerCreateApp({
        name: trimmedName,
        slug: normalized,
        userId: user.id,
      });
      // The runner owns the app row; the creator's admin grant is ours. A
      // failed grant would leave an app nobody can open, so roll it back.
      try {
        await withDb(grantCollaborator(app.id, user.id, "admin"));
      } catch (grantError) {
        await runnerDeleteApp(app.id).catch(() => null);
        throw grantError;
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

export const remove = action(
  withSchema(AppId, async (appId) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      await runnerDeleteApp(appId);
      // Nothing cascades grants now that the app row lives in the runner.
      await withDb(dropAppCollaborators(appId));
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }
      failUnknown(error);
    }
  }),
  { error: AuthError }
);
export const setDesired = action(
  withSchema(
    Schema.Struct({ desiredState: Schema.String, id: Schema.String }),
    async ({ id, desiredState }) => {
      if (desiredState !== "running" && desiredState !== "stopped") {
        fail("desiredState must be running or stopped");
      }
      const user = await sessionUser();
      await requireAppRole(id, user.id, "push");
      try {
        // SAFETY: desiredState is validated above to be exactly "running" | "stopped" before this cast.
        await runnerPatchApp(id, {
          desiredState: desiredState as "running" | "stopped",
        });
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          throw error;
        }
        failUnknown(error);
      }
    }
  ),
  { error: AuthError }
);

const RenameApp = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
});

/** Rename an app (display name and/or slug). Admin-gated; a slug change
 * moves the subdomain, git remote, and fleet data via the runner op. */
export const renameApp = action(
  withSchema(RenameApp, async ({ id, name, slug }) => {
    const trimmedName = name?.trim() || undefined;
    const normalized = slug?.trim().toLowerCase() || undefined;
    if (!trimmedName && !normalized) {
      fail("Name or slug required");
    }
    if (normalized && RESERVED_SLUGS.has(normalized)) {
      fail("Slug is reserved");
    }
    if (normalized && !SLUG_RE.test(normalized)) {
      fail(
        "Slug must be 1–48 chars: lowercase letters, digits, and hyphens, starting and ending with a letter or digit"
      );
    }
    const user = await sessionUser();
    await requireAppRole(id, user.id, "admin");
    try {
      await runnerRenameApp(id, { name: trimmedName, slug: normalized });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

export const get = action(
  withSchema(AppId, async (appId) => {
    const user = await sessionUser();
    const { app, role } = await requireAppRole(appId, user.id, "view");
    const git = await runnerGitRemote(appId);
    return {
      app,
      gitHint: `git remote add origin ${git.url}`,
      gitRemote: git.url,
      host: git.url.replace(/^https?:\/\//u, ""),
      myRole: role,
      s3Endpoint: git.endpoint,
      username: git.username,
    };
  }),
  { error: AuthError }
);

const RollbackArgs = Schema.Struct({
  appId: Schema.String,
  sha: Schema.String,
});

/** Rollback to a previous successful deploy sha (push-gated): re-runs
 * the pipeline at the old tip bundle. Progress follows on the deploys
 * stream like a normal deploy. */
export const rollback = action(
  withSchema(RollbackArgs, async ({ appId, sha }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    try {
      return await runnerRollback(appId, sha);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

const DeployLogArgs = Schema.Struct({
  appId: Schema.String,
  deployId: Schema.String,
});

/** One finished deploy's build log (view-gated): the stream omits finished
 * rows' logs, so the panel fetches them on demand per deploy id. */
export const deployLog = action(
  withSchema(DeployLogArgs, async ({ appId, deployId }) => {
    await requireViewApp(appId);
    try {
      return await runnerDeployLog(appId, deployId);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);
