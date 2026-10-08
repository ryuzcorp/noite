import * as Schema from "effect/Schema";
import { action, fail, withSchema } from "oxidejs";

import type { CreateSourceInput } from "../apps/create-source";
import { TEMPLATES } from "../apps/templates";
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
  runnerRetryImport,
  runnerRollback,
} from "../runner";
import type { RunnerApp, RunnerCreateSource } from "../runner";
import { AuthError, requireViewApp, sessionUser } from "./session.server";

const CreateSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("blank") }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    ref: Schema.optional(Schema.String),
    url: Schema.String,
  }),
  Schema.Struct({ id: Schema.String, kind: Schema.Literal("template") }),
]);
const CreateApp = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
  source: Schema.optional(CreateSource),
});
const AppId = Schema.String;
const SLUG_RE = /^[a-z0-9](?<slug>[a-z0-9-]{0,46}[a-z0-9])?$/u;
/** Slugs the platform owns (the runner's own `RESERVED_SLUGS`, `lifecycle.rs`). */
const RESERVED_SLUGS = {
  _control: true,
  api: true,
  app: true,
  git: true,
} satisfies Record<string, true>;
/** Why a slug cannot be used, or null when it can — the one gate create,
 * rename and the push-to-create path (A5) all apply. */
export const slugError = (slug: string): string | null => {
  if (Object.hasOwn(RESERVED_SLUGS, slug)) {
    return "Slug is reserved";
  }
  if (!SLUG_RE.test(slug)) {
    return "Slug must be 1–48 chars: lowercase letters, digits, and hyphens, starting and ending with a letter or digit";
  }
  return null;
};

/** The account a create runs for — the session user, or the API-key owner on
 * the push-to-create path (/internal/git-auth). */
export interface CreateAccount {
  id: string;
  name: string;
}

/** Resolve what the runner should import. A template is named by id and
 * resolved here against the shipped list, so a client can never point an
 * import at another URL; the `actor` (who a squashed commit is authored as) is
 * filled from the account, never from the request. */
const toRunnerSource = (
  source: CreateSourceInput | undefined,
  account: CreateAccount
): RunnerCreateSource => {
  if (!source || source.kind === "blank") {
    return { kind: "blank" };
  }
  const actor = { name: account.name, userId: account.id };
  if (source.kind === "template") {
    const picked = TEMPLATES.find((template) => template.id === source.id);
    if (!picked) {
      fail(`Unknown template: ${source.id}`);
    }
    return {
      actor,
      kind: "git",
      ref: picked.ref,
      squash: true,
      url: picked.url,
    };
  }
  return { actor, kind: "git", ref: source.ref, url: source.url };
};

/** Create an app for one account and grant that account admin — the single
 * implementation behind the create action and /internal/git-auth's
 * push-to-create (A5). The runner owns the app row; the grant is ours, and a
 * failed grant rolls the row back so no app is left unopenable. */
export const createAppForUser = async (input: {
  account: CreateAccount;
  name: string;
  slug: string;
  source?: CreateSourceInput;
}): Promise<RunnerApp> => {
  const app = await runnerCreateApp({
    name: input.name,
    slug: input.slug,
    source: toRunnerSource(input.source, input.account),
    userId: input.account.id,
  });
  try {
    await withDb(grantCollaborator(app.id, input.account.id, "admin"));
  } catch (grantError) {
    await runnerDeleteApp(app.id).catch(() => null);
    throw grantError;
  }
  return app;
};

export const create = action(
  withSchema(CreateApp, async ({ name, slug, source }) => {
    const user = await sessionUser();
    const trimmedName = name.trim();
    const normalized = slug.trim().toLowerCase();
    if (!trimmedName) {
      fail("Name is required");
    }
    const slugProblem = slugError(normalized);
    if (slugProblem) {
      fail(slugProblem);
    }
    try {
      await createAppForUser({
        account: { id: user.id, name: user.name },
        name: trimmedName,
        slug: normalized,
        source,
      });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Retry a failed GitHub/template import (A2) with the source stored on the
 * app row: the app page offers this whenever the import ended in `error`. */
export const retryImport = action(
  withSchema(AppId, async (appId) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    try {
      return await runnerRetryImport(appId);
    } catch (error) {
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
    const slugProblem = normalized ? slugError(normalized) : null;
    if (slugProblem) {
      fail(slugProblem);
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
