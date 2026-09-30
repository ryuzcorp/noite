/* eslint-disable func-names -- Effect.gen */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { action, useEnv, useRequest } from "oxidejs";

import { checkedSchema } from "./action-schema";
import {
  ActionError,
  authFromEnv,
  failAction,
  failUnknown,
  MissingAuthSecretError,
  UnauthorizedError,
} from "./auth";
import type { SessionUser } from "./auth";
import {
  acceptPendingInvite,
  countAdmins,
  declinePendingInvite,
  dropAppCollaborators,
  grantCollaborator,
  listCollaboratorRows,
  listInvitesForEmail,
  listPendingInvites,
  normalizeEmail,
  parseAppRole,
  requireAppRole,
  revokePendingInvite,
  upsertPendingInvite,
} from "./collaborators";
import { ensureDbPromise, orm, withDb } from "./db";
import { listUnusedInvitesFor } from "./invites.server";
import {
  runnerAddDomain,
  runnerCreateApp,
  runnerListDomains,
  runnerRemoveDomain,
  runnerDeleteApp,
  runnerGetLimits,
  runnerGitRemote,
  runnerPatchApp,
  runnerRenameApp,
  runnerSourceBlob,
  runnerSourceCommit,
  runnerSourceDiff,
  runnerSourceTree,
  runnerDeployLog,
  runnerRollback,
  runnerListEnv,
  runnerSetEnv,
  runnerDeleteEnv,
  runnerStorage,
  runnerD1,
  runnerD1Write,
  runnerDoInstances,
  runnerR2Get,
  runnerR2List,
  runnerR2Delete,
  runnerGetError,
  runnerListErrors,
  runnerSetErrorStatus,
  runnerSetLimits,
} from "./runner";

const CreateApp = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
});
const AppId = Schema.String;
const AuthError = Schema.Union([
  UnauthorizedError,
  MissingAuthSecretError,
  ActionError,
]);

/** Source preview — the runner serves from the persistent bare mirror. */
const SourceBlobArgs = Schema.Struct({
  appId: Schema.String,
  path: Schema.String,
});

const SLUG_RE = /^[a-z0-9](?<slug>[a-z0-9-]{0,46}[a-z0-9])?$/u;
const RESERVED_SLUGS = new Set(["_control", "app", "api", "git"]);

/** new URL() throws on malformed input — never let a bad request URL 500. */
const requestOrigin = (request: Request): string | undefined => {
  try {
    return new URL(request.url).origin;
  } catch {
    return undefined;
  }
};

export const sessionUser = async (): Promise<SessionUser> => {
  const request = useRequest();
  const env = useEnv<KitEnv>() ?? process.env;
  await ensureDbPromise();
  const origin = requestOrigin(request);
  if (!origin) {
    throw new UnauthorizedError({ message: "Sign in required" });
  }
  const auth = authFromEnv(
    // SAFETY: the ALS env (or process.env fallback) provides the same KitEnv control keys used by every action.
    env as KitEnv,
    origin
  );
  // A missing/unreadable session must 401 like a missing user, never
  // defect (matches requireUser's contract in lib/auth.ts).
  let session;
  try {
    session = await auth.api.getSession({ headers: request.headers });
  } catch {
    throw new UnauthorizedError({ message: "Sign in required" });
  }
  const user = session?.user;
  if (!user) {
    throw new UnauthorizedError({ message: "Sign in required" });
  }
  return { email: user.email, id: user.id, name: user.name };
};

export const create = action(
  checkedSchema(CreateApp, async ({ name, slug }) => {
    const user = await sessionUser();
    const trimmedName = name.trim();
    const normalized = slug.trim().toLowerCase();
    if (!trimmedName) {
      failAction("Name is required");
    }
    if (RESERVED_SLUGS.has(normalized)) {
      failAction("Slug is reserved");
    }
    if (!SLUG_RE.test(normalized)) {
      failAction(
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
      if (error instanceof ActionError || error instanceof UnauthorizedError) {
        throw error;
      }
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

export const remove = action(
  checkedSchema(AppId, async (appId) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      await runnerDeleteApp(appId);
      // Nothing cascades grants now that the app row lives in the runner.
      await withDb(dropAppCollaborators(appId));
    } catch (error) {
      if (error instanceof ActionError || error instanceof UnauthorizedError) {
        throw error;
      }
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

const CreateApiKey = Schema.Struct({
  appManagement: Schema.Boolean,
  events: Schema.Boolean,
  name: Schema.String,
});

/** Profile API key with machine scopes. Permissions are server-only in
 * better-auth, so creation goes through this action (the client SDK
 * cannot set them). Returns the raw key once — the UI shows it once,
 * like the client flow did. */
export const createApiKey = action(
  checkedSchema(CreateApiKey, async ({ appManagement, events, name }) => {
    const user = await sessionUser();
    const label = name.trim();
    if (!label) {
      failAction("Name is required");
    }
    if (!appManagement && !events) {
      failAction("Select at least one scope");
    }
    const permissions: Record<string, string[]> = {};
    if (appManagement) {
      permissions.apps = ["manage"];
    }
    if (events) {
      permissions.events = ["push"];
    }
    const request = useRequest();
    const env = useEnv<KitEnv>() ?? process.env;
    const origin = requestOrigin(request);
    if (!origin) {
      throw new UnauthorizedError({ message: "Sign in required" });
    }
    const auth = authFromEnv(
      // SAFETY: the ALS env (or process.env fallback) provides the same KitEnv control keys used by every action.
      env as KitEnv,
      origin
    );
    const created = await auth.api.createApiKey({
      body: { name: label, permissions, userId: user.id },
    });
    const key = created?.key;
    if (!key) {
      failAction("Failed to create API key");
    }
    return { key };
  }),
  { error: AuthError }
);

export const setDesired = action(
  checkedSchema(
    Schema.Struct({ desiredState: Schema.String, id: Schema.String }),
    async ({ id, desiredState }) => {
      if (desiredState !== "running" && desiredState !== "stopped") {
        failAction("desiredState must be running or stopped");
      }
      const user = await sessionUser();
      await requireAppRole(id, user.id, "push");
      try {
        // SAFETY: desiredState is validated above to be exactly "running" | "stopped" before this cast.
        await runnerPatchApp(id, {
          desiredState: desiredState as "running" | "stopped",
        });
      } catch (error) {
        if (
          error instanceof ActionError ||
          error instanceof UnauthorizedError
        ) {
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
  checkedSchema(RenameApp, async ({ id, name, slug }) => {
    const trimmedName = name?.trim() || undefined;
    const normalized = slug?.trim().toLowerCase() || undefined;
    if (!trimmedName && !normalized) {
      failAction("Name or slug required");
    }
    if (normalized && RESERVED_SLUGS.has(normalized)) {
      failAction("Slug is reserved");
    }
    if (normalized && !SLUG_RE.test(normalized)) {
      failAction(
        "Slug must be 1–48 chars: lowercase letters, digits, and hyphens, starting and ending with a letter or digit"
      );
    }
    const user = await sessionUser();
    await requireAppRole(id, user.id, "admin");
    try {
      await runnerRenameApp(id, { name: trimmedName, slug: normalized });
    } catch (error) {
      if (error instanceof ActionError || error instanceof UnauthorizedError) {
        throw error;
      }
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

export const get = action(
  checkedSchema(AppId, async (appId) => {
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

/** Ownership gate for source browsing — the runner is the data source. */
const requireViewApp = async (appId: string): Promise<void> => {
  const user = await sessionUser();
  await requireAppRole(appId, user.id, "view");
};

export const sourceTree = action(
  checkedSchema(AppId, async (appId) => {
    await requireViewApp(appId);
    return runnerSourceTree(appId);
  }),
  { error: AuthError }
);

export const sourceBlob = action(
  checkedSchema(SourceBlobArgs, async ({ appId, path }) => {
    await requireViewApp(appId);
    return runnerSourceBlob(appId, path);
  }),
  { error: AuthError }
);

export const sourceDiff = action(
  checkedSchema(AppId, async (appId) => {
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
  checkedSchema(SourceCommitArgs, async ({ appId, files, message }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    try {
      return await runnerSourceCommit(appId, {
        author: user.email,
        files,
        message,
      });
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

// ---- Rollback + tenant env vars (`.dev.vars` model) ----

const RollbackArgs = Schema.Struct({
  appId: Schema.String,
  sha: Schema.String,
});

/** Rollback to a previous successful deploy sha (push-gated): re-runs
 * the pipeline at the old tip bundle. Progress follows on the deploys
 * stream like a normal deploy. */
export const rollback = action(
  checkedSchema(RollbackArgs, async ({ appId, sha }) => {
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
  checkedSchema(DeployLogArgs, async ({ appId, deployId }) => {
    await requireViewApp(appId);
    try {
      return await runnerDeployLog(appId, deployId);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

const SetEnvArgs = Schema.Struct({
  appId: Schema.String,
  name: Schema.String,
  value: Schema.String,
});
const DeleteEnvArgs = Schema.Struct({
  appId: Schema.String,
  name: Schema.String,
});

/** One env row as the browser sees it. Values are write-only: only
 * `FLAG_*` toggles (non-secret `1`/`0` by convention) carry theirs, so a
 * view-only collaborator — or anything persisted client-side — never holds a
 * secret. */
export interface EnvVarView {
  name: string;
  updatedAt: string;
  value: string;
}

const FLAG_VALUES = new Set(["0", "1"]);

/** Redact one runner env row for the browser (see {@link EnvVarView}). */
export const redactEnv = ({
  name,
  updatedAt,
  value,
}: {
  name: string;
  updatedAt: string;
  value: string;
}): EnvVarView => ({
  name,
  updatedAt,
  value: name.startsWith("FLAG_") && FLAG_VALUES.has(value) ? value : "",
});

export const listEnv = action(
  checkedSchema(AppId, async (appId): Promise<EnvVarView[]> => {
    await requireViewApp(appId);
    const rows = await runnerListEnv(appId);
    return rows.map((row) => redactEnv(row));
  }),
  { error: AuthError }
);

export const setEnv = action(
  checkedSchema(SetEnvArgs, async ({ appId, name, value }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerSetEnv(appId, name, value);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

export const deleteEnv = action(
  checkedSchema(DeleteEnvArgs, async ({ appId, name }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerDeleteEnv(appId, name);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Render stored env as `.dev.vars` text for local dev (admin-gated: this is
 * the one place secret values leave the runner). Values are shell-escaped. */
export const envDotVars = action(
  checkedSchema(AppId, async (appId) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    const rows = await runnerListEnv(appId);
    const lines = rows.map(({ name, value }) => {
      const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      return /\s|#/u.test(value)
        ? `${name}="${escaped}"`
        : `${name}=${escaped}`;
    });
    return lines.join("\n");
  }),
  { error: AuthError }
);

// ---- Invitations a member can hand out ----

/** The signed-in account's unused codes (see `INVITES_PER_USER`). */
export const myInviteCodes = action(
  async () => {
    const user = await sessionUser();
    try {
      return await listUnusedInvitesFor(user.id);
    } catch (error) {
      failUnknown(error);
    }
  },
  { error: AuthError }
);

// ---- Custom domains (read: view · write: admin) ----

const DomainArgs = Schema.Struct({
  appId: Schema.String,
  hostname: Schema.String,
});

/** Hostnames this app answers on, for anyone who can see the app. */
export const listDomains = action(
  checkedSchema(AppId, async (appId) => {
    await requireViewApp(appId);
    try {
      return await runnerListDomains(appId);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Reserve a hostname for the app (admin). The runner is the authority on
 * shape, collisions and platform-owned names; its message is surfaced. */
export const addDomain = action(
  checkedSchema(DomainArgs, async ({ appId, hostname }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerAddDomain(appId, hostname);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

export const removeDomain = action(
  checkedSchema(DomainArgs, async ({ appId, hostname }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerRemoveDomain(appId, hostname);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

// ---- Edge rate limits (read: view · write: admin) ----

/** Requests per minute; null = the platform default, 0 = off. */
const Rpm = Schema.Union([Schema.Number, Schema.Null]);
const LimitArgs = Schema.Struct({
  appId: Schema.String,
  appRpm: Rpm,
  clientRpm: Rpm,
});

/** The app's edge limits beside the platform defaults they fall back to. */
export const getLimits = action(
  checkedSchema(AppId, async (appId) => {
    await requireViewApp(appId);
    try {
      return await runnerGetLimits(appId);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Set the app's edge limits (admin). The runner owns the range check and
 * rewrites the edge on its next reconcile. */
export const setLimits = action(
  checkedSchema(LimitArgs, async ({ appId, appRpm, clientRpm }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerSetLimits(appId, clientRpm, appRpm);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

// ---- Errors (view: read · push: resolve, ignore, reopen) ----

const ErrorStatusSchema = Schema.Union([
  Schema.Literal("open"),
  Schema.Literal("resolved"),
  Schema.Literal("ignored"),
]);
const ErrorListArgs = Schema.Struct({
  appId: Schema.String,
  status: ErrorStatusSchema,
});
const ErrorArgs = Schema.Struct({
  appId: Schema.String,
  fingerprint: Schema.String,
});
const ErrorStatusArgs = Schema.Struct({
  appId: Schema.String,
  fingerprint: Schema.String,
  status: ErrorStatusSchema,
});

/** Grouped errors in one status, most recently seen first. */
export const listErrors = action(
  checkedSchema(ErrorListArgs, async ({ appId, status }) => {
    await requireViewApp(appId);
    try {
      return await runnerListErrors(appId, status);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** One error with its recent occurrences (stack, request, trace logs). */
export const errorDetail = action(
  checkedSchema(ErrorArgs, async ({ appId, fingerprint }) => {
    await requireViewApp(appId);
    try {
      return await runnerGetError(appId, fingerprint);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Resolve, ignore or reopen an error — anyone who can push can triage. */
export const setErrorStatus = action(
  checkedSchema(ErrorStatusArgs, async ({ appId, fingerprint, status }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    try {
      return await runnerSetErrorStatus(appId, fingerprint, status);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

// ---- Storage (view: browse · push: edit and delete) ----

const StorageListArgs = Schema.Struct({ appId: Schema.String });
const D1PreviewArgs = Schema.Struct({
  appId: Schema.String,
  databaseId: Schema.String,
});
const DoPreviewArgs = Schema.Struct({
  appId: Schema.String,
  className: Schema.String,
});
const R2ListArgs = Schema.Struct({
  appId: Schema.String,
  bucket: Schema.String,
});
const R2GetArgs = Schema.Struct({
  appId: Schema.String,
  bucket: Schema.String,
  key: Schema.String,
});

/** D1 databases + DO classes declared by an app's deployed config. */
export const listAppStorage = action(
  checkedSchema(StorageListArgs, async ({ appId }) => {
    await requireViewApp(appId);
    try {
      return await runnerStorage(appId);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Curated read-only D1 preview: tables + first rows. */
export const d1Preview = action(
  checkedSchema(D1PreviewArgs, async ({ appId, databaseId }) => {
    await requireViewApp(appId);
    try {
      return await runnerD1(appId, databaseId);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

const D1WriteArgs = Schema.Struct({
  appId: Schema.String,
  databaseId: Schema.String,
  key: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Null]))
  ),
  op: Schema.Union([
    Schema.Literal("insert"),
    Schema.Literal("update"),
    Schema.Literal("delete"),
  ]),
  table: Schema.String,
  values: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Null])
  ),
});

/** Curated tenant-DB write (push-gated): single INSERT or UPDATE. */
export const d1Write = action(
  checkedSchema(
    D1WriteArgs,
    async ({ appId, databaseId, key, op, table, values }) => {
      const user = await sessionUser();
      await requireAppRole(appId, user.id, "push");
      try {
        return await runnerD1Write(appId, databaseId, {
          key,
          op,
          table,
          values,
        });
      } catch (error) {
        failUnknown(error);
      }
    }
  ),
  { error: AuthError }
);

/** Read-only Durable Object instance list for one class. */
export const doPreview = action(
  checkedSchema(DoPreviewArgs, async ({ appId, className }) => {
    await requireViewApp(appId);
    try {
      return await runnerDoInstances(appId, className);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Read-only R2 key listing for one bucket. */
export const r2List = action(
  checkedSchema(R2ListArgs, async ({ appId, bucket }) => {
    await requireViewApp(appId);
    try {
      return await runnerR2List(appId, bucket);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Read-only R2 object fetch (bounded text preview). */
export const r2Get = action(
  checkedSchema(R2GetArgs, async ({ appId, bucket, key }) => {
    await requireViewApp(appId);
    try {
      return await runnerR2Get(appId, bucket, key);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Delete one R2 object by key (push role — a write). */
export const r2Delete = action(
  checkedSchema(R2GetArgs, async ({ appId, bucket, key }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    try {
      await runnerR2Delete(appId, bucket, key);
      return { ok: true as const };
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

// ---- Collaborators (app-scoped roles: view | push | admin) ----

const InviteCollaborator = Schema.Struct({
  appId: Schema.String,
  email: Schema.String,
  role: Schema.String,
});

const UpdateCollaborator = Schema.Struct({
  appId: Schema.String,
  role: Schema.String,
  userId: Schema.String,
});

const RemoveCollaborator = Schema.Struct({
  appId: Schema.String,
  userId: Schema.String,
});

export const listCollaborators = action(
  checkedSchema(AppId, async (appId) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "view");
    return listCollaboratorRows(appId);
  }),
  { error: AuthError }
);

/** Invite an email to an app. Never reveals whether the address has an
 * account: an existing collaborator's role is updated in place (they are
 * already visible in the list), anyone else gets a pending invitation they
 * accept after signing in with that address. */
export const inviteCollaborator = action(
  checkedSchema(InviteCollaborator, async ({ appId, email, role }) => {
    const user = await sessionUser();
    const { app } = await requireAppRole(appId, user.id, "admin");
    const nextRole = parseAppRole(role.trim().toLowerCase());
    if (nextRole === null) {
      return failAction("role must be view, push, or admin");
    }
    const normalized = normalizeEmail(email);
    if (!normalized.includes("@")) {
      return failAction("Valid email required");
    }
    try {
      const members = await listCollaboratorRows(appId);
      const member = members.find(
        (row) => normalizeEmail(row.email) === normalized
      );
      if (member) {
        await withDb(grantCollaborator(appId, member.userId, nextRole));
        return { ok: true as const, status: "updated" as const };
      }
      await withDb(
        upsertPendingInvite({
          appId,
          appName: app.name,
          email: normalized,
          invitedBy: user.id,
          role: nextRole,
        })
      );
      return { ok: true as const, status: "invited" as const };
    } catch (error) {
      return failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Invitations waiting on an app (admin only: they carry email addresses). */
export const listPendingInvitations = action(
  checkedSchema(AppId, async (appId) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    return listPendingInvites(appId);
  }),
  { error: AuthError }
);

export const revokeInvitation = action(
  checkedSchema(
    Schema.Struct({ appId: Schema.String, inviteId: Schema.String }),
    async ({ appId, inviteId }) => {
      const user = await sessionUser();
      await requireAppRole(appId, user.id, "admin");
      await withDb(revokePendingInvite(appId, inviteId));
      return { ok: true as const };
    }
  ),
  { error: AuthError }
);

/** Invitations addressed to the signed-in account's email. */
export const myCollaboratorInvitations = action(
  async () => {
    const user = await sessionUser();
    try {
      return await listInvitesForEmail(user.email);
    } catch (error) {
      return failUnknown(error);
    }
  },
  { error: AuthError }
);

/** Accept an invitation: the grant is created for the session account only
 * when the invitation is addressed to its email. */
export const acceptInvitation = action(
  checkedSchema(Schema.String, async (inviteId) => {
    const user = await sessionUser();
    const accepted = await acceptPendingInvite(inviteId, user.email, user.id);
    if (!accepted) {
      return failAction("Invitation not found");
    }
    return { appId: accepted.appId, ok: true as const };
  }),
  { error: AuthError }
);

export const declineInvitation = action(
  checkedSchema(Schema.String, async (inviteId) => {
    const user = await sessionUser();
    await withDb(declinePendingInvite(inviteId, user.email));
    return { ok: true as const };
  }),
  { error: AuthError }
);

export const updateCollaboratorRole = action(
  checkedSchema(UpdateCollaborator, async ({ appId, userId, role }) => {
    const actor = await sessionUser();
    await requireAppRole(appId, actor.id, "admin");
    const nextRole = parseAppRole(role.trim().toLowerCase());
    if (nextRole === null) {
      return failAction("role must be view, push, or admin");
    }
    const err = await withDb(
      Effect.gen(function* run() {
        const membership = yield* orm.app_collaborator.findFirst({
          where: { appId, userId },
        });
        if (!membership) {
          return "Collaborator not found";
        }
        const current = parseAppRole(membership.role);
        if (current === "admin" && nextRole !== "admin") {
          const admins = yield* countAdmins(appId);
          if (admins <= 1) {
            return "Cannot demote the last admin";
          }
        }
        yield* orm.app_collaborator.update({
          data: { role: nextRole },
          where: { id: membership.id },
        });
        return "";
      })
    );
    if (err) {
      return failAction(err);
    }
    return { ok: true as const };
  }),
  { error: AuthError }
);

export const removeCollaborator = action(
  checkedSchema(RemoveCollaborator, async ({ appId, userId }) => {
    const actor = await sessionUser();
    await requireAppRole(appId, actor.id, "admin");
    const err = await withDb(
      Effect.gen(function* run() {
        const membership = yield* orm.app_collaborator.findFirst({
          where: { appId, userId },
        });
        if (!membership) {
          return "";
        }
        if (parseAppRole(membership.role) === "admin") {
          const admins = yield* countAdmins(appId);
          if (admins <= 1) {
            return "Cannot remove the last admin";
          }
        }
        yield* orm.app_collaborator.delete({ where: { id: membership.id } });
        return "";
      })
    );
    if (err) {
      return failAction(err);
    }
    return { ok: true as const };
  }),
  { error: AuthError }
);
