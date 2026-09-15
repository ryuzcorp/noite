/* eslint-disable func-names -- Effect.gen */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { action, liveQuery, useEnv, useRequest, withSchema } from "oxidejs";

import {
  ActionError,
  authFromEnv,
  failAction,
  MissingAuthSecretError,
  requireUser,
  UnauthorizedError,
} from "./auth";
import type { SessionUser } from "./auth";
import {
  countAdmins,
  grantCollaborator,
  listAppsForCollaborator,
  parseAppRole,
  requireAppRole,
} from "./collaborators";
import { ensureDb, ensureDbPromise, orm, SqlLive, withDb } from "./db";
import type { App, AppRole, Deploy } from "./db";
import { enqueueOp } from "./ops.server";
import {
  runnerGetApp,
  runnerGitRemote,
  runnerListDeploys,
  runnerSourceBlob,
  runnerSourceDiff,
  runnerSourceTree,
  runnerAppMetrics,
  runnerAppSpans,
  runnerStorage,
  runnerD1,
  runnerDoInstances,
  runnerR2Get,
  runnerR2List,
  runnerR2Delete,
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

const SLUG_RE = /^[a-z](?<slug>[a-z-]{0,46}[a-z])?$/u;
const RESERVED_SLUGS = new Set(["_control", "app", "api", "git"]);

const asApp = (row: App): App => ({
  ...row,
  internalPort: row.internalPort ?? null,
  lastDeploySha: row.lastDeploySha ?? null,
  lastError: row.lastError ?? null,
  listenPort: row.listenPort ?? null,
});

const appsFor = (userId: string) =>
  liveQuery<App[]>({ topic: `apps:${userId}` });

const snapshotApps = (userId: string) => listAppsForCollaborator(userId);

const loadApps = (userId: string) =>
  ensureDb.pipe(
    Effect.andThen(() => snapshotApps(userId)),
    Effect.provide(SqlLive),
    Effect.scoped
  );

const loadDeploys = (appId: string) =>
  Effect.tryPromise({
    catch: (e) =>
      new ActionError({
        message: e instanceof Error ? e.message : String(e),
      }),
    try: async () => {
      const rows = await runnerListDeploys(appId);
      return rows.map((d) => {
        const row: Deploy = {
          appId: d.appId,
          createdAt: d.createdAt,
          id: d.id,
          log: d.log,
          sha: d.sha,
          status: d.status,
          updatedAt: d.updatedAt,
        };
        return row;
      });
    },
  });

/** new URL() throws on malformed input — never let a bad request URL 500. */
const requestOrigin = (request: Request): string | undefined => {
  try {
    return new URL(request.url).origin;
  } catch {
    return undefined;
  }
};

const sessionUser = async (): Promise<SessionUser> => {
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
  const session = await auth.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new UnauthorizedError({ message: "Sign in required" });
  }
  return { email: user.email, id: user.id, name: user.name };
};

export const list = action(
  () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const user = yield* requireUser;
        const apps = appsFor(user.id);
        return apps.subscribeStream(
          apps.mutateEffect(() => loadApps(user.id)).pipe(Effect.asVoid)
        );
      })
    ),
  { error: AuthError, stream: true }
);

/** One-shot deploy history from the runner (no liveQuery — avoids seed/ALS Defects). */
export const listDeploys = action(
  withSchema(AppId, (appId: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const user = yield* requireUser;
        yield* Effect.tryPromise({
          catch: (e) =>
            e instanceof UnauthorizedError || e instanceof ActionError
              ? e
              : new ActionError({
                  message: e instanceof Error ? e.message : String(e),
                }),
          try: () => requireAppRole(appId, user.id, "view"),
        });
        const rows = yield* loadDeploys(appId);
        return Stream.succeed(rows);
      })
    )
  ),
  { error: AuthError, stream: true }
);

export const create = action(
  withSchema(CreateApp, async ({ name, slug }) => {
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
        "Slug must be 1–48 chars: lowercase letters and hyphens, starting and ending with a letter"
      );
    }
    const hub = appsFor(user.id);
    try {
      // Run the op outside mutate so publish/liveQuery cannot deadlock the topic gate.
      await enqueueOp(
        {
          name: trimmedName,
          slug: normalized,
          type: "create",
          userId: user.id,
        },
        `create:${user.id}:${normalized}:${Date.now()}`
      );
      await hub.mutate(() => Effect.runPromise(loadApps(user.id)));
    } catch (error) {
      if (error instanceof ActionError || error instanceof UnauthorizedError) {
        throw error;
      }
      failAction(error instanceof Error ? error.message : String(error));
    }
  }),
  { error: AuthError }
);

export const remove = action(
  withSchema(AppId, async (appId) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    const hub = appsFor(user.id);
    try {
      await enqueueOp(
        { appId, type: "remove", userId: user.id },
        `remove:${appId}:${Date.now()}`
      );
      await hub.mutate(() => Effect.runPromise(loadApps(user.id)));
    } catch (error) {
      if (error instanceof ActionError || error instanceof UnauthorizedError) {
        throw error;
      }
      failAction(error instanceof Error ? error.message : String(error));
    }
  }),
  { error: AuthError }
);

export const setDesired = action(
  withSchema(
    Schema.Struct({ desiredState: Schema.String, id: Schema.String }),
    async ({ id, desiredState }) => {
      if (desiredState !== "running" && desiredState !== "stopped") {
        failAction("desiredState must be running or stopped");
      }
      const user = await sessionUser();
      await requireAppRole(id, user.id, "push");
      const hub = appsFor(user.id);
      try {
        await enqueueOp(
          {
            appId: id,
            // SAFETY: desiredState is validated above to be exactly "running" | "stopped" before this cast.
            desiredState: desiredState as "running" | "stopped",
            type: "desired",
            userId: user.id,
          },
          `desired:${id}:${desiredState}:${Date.now()}`
        );
        await hub.mutate(() => Effect.runPromise(loadApps(user.id)));
      } catch (error) {
        if (
          error instanceof ActionError ||
          error instanceof UnauthorizedError
        ) {
          throw error;
        }
        failAction(error instanceof Error ? error.message : String(error));
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
      failAction("Name or slug required");
    }
    if (normalized && RESERVED_SLUGS.has(normalized)) {
      failAction("Slug is reserved");
    }
    if (normalized && !SLUG_RE.test(normalized)) {
      failAction(
        "Slug must be 1–48 chars: lowercase letters and hyphens, starting and ending with a letter"
      );
    }
    const user = await sessionUser();
    await requireAppRole(id, user.id, "admin");
    const hub = appsFor(user.id);
    try {
      await enqueueOp(
        {
          appId: id,
          name: trimmedName,
          slug: normalized,
          type: "rename",
          userId: user.id,
        },
        `rename:${id}:${Date.now()}`
      );
      await hub.mutate(() => Effect.runPromise(loadApps(user.id)));
    } catch (error) {
      if (error instanceof ActionError || error instanceof UnauthorizedError) {
        throw error;
      }
      failAction(error instanceof Error ? error.message : String(error));
    }
  }),
  { error: AuthError }
);

export const get = action(
  withSchema(AppId, async (appId) => {
    const user = await sessionUser();
    const { app: local, role } = await requireAppRole(appId, user.id, "view");
    let app = asApp(local);
    try {
      const remote = await runnerGetApp(appId);
      app = asApp({
        ...local,
        desiredState: remote.desiredState,
        fleetBucket: remote.fleetBucket,
        internalPort: remote.internalPort,
        lastDeploySha: remote.lastDeploySha,
        lastError: remote.lastError,
        listenPort: remote.listenPort,
        status: remote.status,
        subdomain: remote.subdomain,
      });
    } catch {
      /* runner may be briefly down */
    }
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

export const appMetrics = action(
  withSchema(AppId, async (appId) => {
    await requireViewApp(appId);
    return runnerAppMetrics(appId, 24);
  }),
  { error: AuthError }
);

export const appSpans = action(
  withSchema(AppId, async (appId) => {
    await requireViewApp(appId);
    try {
      // On-demand window over the fleet's OTel spans (what it's doing, queue
      // wait, errors) — read at page load, not stored.
      return await runnerAppSpans(appId, 1);
    } catch (error) {
      // Surface the underlying failure instead of the RPC's generic
      // "Internal error" — failAction is mapped into AuthError.
      failAction(error instanceof Error ? error.message : String(error));
    }
  }),
  { error: AuthError }
);

// ---- Storage preview (curated read-only; ungated — see runner note) ----

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

/** D1 databases + DO classes across all of the user's apps. */
export const listAllStorage = action(
  async () => {
    const user = await sessionUser();
    const apps = await withDb(listAppsForCollaborator(user.id));
    const all: Awaited<ReturnType<typeof runnerStorage>> = [];
    const live = apps.filter(
      (app) => app.status !== "deleting" && app.status !== "gone"
    );
    const got = await Promise.all(
      live.map(async (app) => {
        try {
          return await runnerStorage(app.id);
        } catch {
          // no deployed source yet for this app — skip
          return [];
        }
      })
    );
    for (const items of got) {
      all.push(...items);
    }
    return all;
  },
  {
    error: AuthError,
  }
);

/** D1 databases + DO classes declared by an app's deployed config. */
export const listAppStorage = action(
  withSchema(StorageListArgs, async ({ appId }) => {
    await requireViewApp(appId);
    try {
      return await runnerStorage(appId);
    } catch (error) {
      failAction(error instanceof Error ? error.message : String(error));
    }
  }),
  { error: AuthError }
);

/** Curated read-only D1 preview: tables + first rows. */
export const d1Preview = action(
  withSchema(D1PreviewArgs, async ({ appId, databaseId }) => {
    await requireViewApp(appId);
    try {
      return await runnerD1(appId, databaseId);
    } catch (error) {
      failAction(error instanceof Error ? error.message : String(error));
    }
  }),
  { error: AuthError }
);

/** Read-only Durable Object instance list for one class. */
export const doPreview = action(
  withSchema(DoPreviewArgs, async ({ appId, className }) => {
    await requireViewApp(appId);
    try {
      return await runnerDoInstances(appId, className);
    } catch (error) {
      failAction(error instanceof Error ? error.message : String(error));
    }
  }),
  { error: AuthError }
);

/** Read-only R2 key listing for one bucket. */
export const r2List = action(
  withSchema(R2ListArgs, async ({ appId, bucket }) => {
    await requireViewApp(appId);
    try {
      return await runnerR2List(appId, bucket);
    } catch (error) {
      failAction(error instanceof Error ? error.message : String(error));
    }
  }),
  { error: AuthError }
);

/** Read-only R2 object fetch (bounded text preview). */
export const r2Get = action(
  withSchema(R2GetArgs, async ({ appId, bucket, key }) => {
    await requireViewApp(appId);
    try {
      return await runnerR2Get(appId, bucket, key);
    } catch (error) {
      failAction(error instanceof Error ? error.message : String(error));
    }
  }),
  { error: AuthError }
);

/** Delete one R2 object by key (push role — a write). */
export const r2Delete = action(
  withSchema(R2GetArgs, async ({ appId, bucket, key }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    try {
      await runnerR2Delete(appId, bucket, key);
      return { ok: true as const };
    } catch (error) {
      failAction(error instanceof Error ? error.message : String(error));
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
  withSchema(AppId, async (appId) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "view");
    const rows = await withDb(
      Effect.gen(function* run() {
        const memberships = yield* orm.app_collaborator.findMany({
          where: { appId },
        });
        const out: {
          userId: string;
          email: string;
          name: string;
          role: AppRole;
          createdAt: string;
        }[] = [];
        for (const m of memberships) {
          const role = parseAppRole(m.role);
          if (!role) {
            continue;
          }
          const u = yield* orm.user.findFirst({ where: { id: m.userId } });
          out.push({
            createdAt:
              m.createdAt instanceof Date
                ? m.createdAt.toISOString()
                : String(m.createdAt),
            email: u?.email ?? "",
            name: u?.name ?? "",
            role,
            userId: m.userId,
          });
        }
        out.sort((a, b) => a.email.localeCompare(b.email));
        return out;
      })
    );
    return rows;
  }),
  { error: AuthError }
);

export const inviteCollaborator = action(
  withSchema(InviteCollaborator, async ({ appId, email, role }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    const nextRole = parseAppRole(role.trim().toLowerCase());
    if (nextRole === null) {
      return failAction("role must be view, push, or admin");
    }
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes("@")) {
      return failAction("Valid email required");
    }
    const invitee = await withDb(
      orm.user.findFirst({ where: { email: normalized } })
    );
    if (invitee === null) {
      return failAction(
        "No Noite user with that email — they must sign in once first"
      );
    }
    await withDb(grantCollaborator(appId, invitee.id, nextRole));
    return { ok: true as const, userId: invitee.id };
  }),
  { error: AuthError }
);

export const updateCollaboratorRole = action(
  withSchema(UpdateCollaborator, async ({ appId, userId, role }) => {
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
  withSchema(RemoveCollaborator, async ({ appId, userId }) => {
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
