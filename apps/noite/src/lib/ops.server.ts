import * as Effect from "effect/Effect";
/**
 * Durable control-plane ops via Oxide workflow / queue / schedule.
 * Bun fetch mode gets bindings from `./bun-durable` (imports).
 */
import * as Schema from "effect/Schema";
import {
  publish,
  queue,
  schedule,
  useEnv,
  useRequest,
  withRequestStore,
  workflow,
} from "oxidejs";

import { listAppsForCollaborator } from "./collaborators";
import { controlEnv } from "./control-env";
import { ensureDb, ensureDbPromise, orm, SqlLive, withDb } from "./db";
import {
  runnerCreateApp,
  runnerDeleteApp,
  runnerListApps,
  runnerPatchApp,
  runnerRenameApp,
} from "./runner";

const OpPayloadSchema = Schema.Union([
  Schema.Struct({
    name: Schema.String,
    slug: Schema.String,
    type: Schema.Literal("create"),
    userId: Schema.String,
  }),
  Schema.Struct({
    appId: Schema.String,
    type: Schema.Literal("remove"),
    userId: Schema.String,
  }),
  Schema.Struct({
    appId: Schema.String,
    desiredState: Schema.Union([
      Schema.Literal("running"),
      Schema.Literal("stopped"),
    ]),
    type: Schema.Literal("desired"),
    userId: Schema.String,
  }),
  Schema.Struct({
    appId: Schema.String,
    name: Schema.optional(Schema.String),
    slug: Schema.optional(Schema.String),
    type: Schema.Literal("rename"),
    userId: Schema.String,
  }),
]);

export type OpPayload = Schema.Schema.Type<typeof OpPayloadSchema>;

const asAppRow = (agent: {
  id: string;
  slug: string;
  name: string;
  status: string;
  subdomain: string;
  gitPrefix: string;
  fleetBucket: string;
  listenPort: number | null;
  internalPort: number | null;
  lastDeploySha: string | null;
  lastError: string | null;
  desiredState: string;
}) => ({
  desiredState: agent.desiredState,
  fleetBucket: agent.fleetBucket,
  gitPrefix: agent.gitPrefix,
  id: agent.id,
  internalPort: agent.internalPort,
  lastDeploySha: agent.lastDeploySha,
  lastError: agent.lastError,
  listenPort: agent.listenPort,
  name: agent.name,
  slug: agent.slug,
  status: agent.status,
  subdomain: agent.subdomain,
});

const loadApps = (userId: string) =>
  ensureDb.pipe(
    Effect.andThen(() => listAppsForCollaborator(userId)),
    Effect.provide(SqlLive),
    Effect.scoped
  );

const publishApps = async (userId: string) => {
  const apps = await Effect.runPromise(loadApps(userId));
  publish(`apps:${userId}`, apps);
};

/** Multi-step runner mutation — create / remove / desired-state. */
export const runnerOp = workflow({
  name: "runner-op",
  payload: OpPayloadSchema,
  run: async ({ payload }, { step }) => {
    await step.do("ensure-db", () => ensureDbPromise());

    if (payload.type === "create") {
      const app = await step.do("runner-create", () =>
        runnerCreateApp({ name: payload.name, slug: payload.slug })
      );
      await step.do("grant", () =>
        withDb(
          Effect.gen(function* run() {
            const existing = yield* orm.app.findFirst({
              where: { id: app.id },
            });
            if (existing) {
              // runner-op is a fresh create; the id already being local is
              // a retry of the same op.
              yield* orm.app.update({
                data: {
                  ...asAppRow(app),
                  userId: payload.userId,
                },
                where: { id: app.id },
              });
            } else {
              // A leftover local row can hold the slug of an app the runner
              // no longer has (direct runner deletes bypass the UI, sync
              // only updates never removes). Drop it so the unique slug
              // never shadows the fresh app.
              const stale = yield* orm.app.findFirst({
                where: { slug: app.slug },
              });
              if (stale) {
                yield* orm.app.delete({ where: { id: stale.id } });
              }
              yield* orm.app.create({
                data: {
                  ...asAppRow(app),
                  userId: payload.userId,
                },
              });
            }
            const collab = yield* orm.app_collaborator.findFirst({
              where: { appId: app.id, userId: payload.userId },
            });
            if (!collab) {
              yield* orm.app_collaborator.create({
                data: {
                  appId: app.id,
                  id: crypto.randomUUID(),
                  role: "admin",
                  userId: payload.userId,
                },
              });
            }
          })
        )
      );
      await step.do("publish", () => publishApps(payload.userId));
      return { appId: app.id };
    }

    if (payload.type === "remove") {
      await step.do("runner-delete", () => runnerDeleteApp(payload.appId));
      await step.do("local-delete", () =>
        withDb(
          Effect.gen(function* run() {
            yield* orm.app.update({
              data: { desiredState: "deleted", status: "deleting" },
              where: { id: payload.appId },
            });
          })
        )
      );
      await step.do("publish", () => publishApps(payload.userId));
      return { appId: payload.appId };
    }

    if (payload.type === "rename") {
      const app = await step.do("runner-rename", () =>
        runnerRenameApp(payload.appId, {
          name: payload.name,
          slug: payload.slug,
        })
      );
      await step.do("local-rename", () =>
        withDb(
          Effect.gen(function* run() {
            const existing = yield* orm.app.findFirst({
              where: { id: payload.appId },
            });
            // Keep the original owner — the actor is just an admin.
            const owner = existing?.userId ?? payload.userId;
            const saved = { ...asAppRow(app), userId: owner };
            yield* existing
              ? orm.app.update({ data: saved, where: { id: payload.appId } })
              : orm.app.create({ data: saved });
          })
        )
      );
      await step.do("publish", () => publishApps(payload.userId));
      return { appId: payload.appId };
    }

    const app = await step.do("runner-patch", () =>
      runnerPatchApp(payload.appId, { desiredState: payload.desiredState })
    );
    await step.do("local-patch", () =>
      withDb(
        Effect.gen(function* run() {
          yield* orm.app.update({
            data: {
              desiredState: app.desiredState,
              status: app.status,
            },
            where: { id: payload.appId },
          });
        })
      )
    );
    await step.do("publish", () => publishApps(payload.userId));
    return { appId: payload.appId };
  },
});

/** Buffer mutations; producerStart so celld/Bun progress without a separate consumer. */
export const runnerOps = queue({
  name: "runner-ops",
  producerStart: true,
  workflow: runnerOp,
});

const SyncPayload = Schema.Struct({ reason: Schema.String });

/** Pull runner status into local rows + liveQuery topics. */
export const syncApps = workflow({
  name: "sync-apps",
  payload: SyncPayload,
  run: async (_event, { step }) => {
    await step.do("ensure-db", () => ensureDbPromise());
    const remote = await step.do("list-runner", () => runnerListApps());
    const byId = new Map(remote.map((a) => [a.id, a]));
    const userIds = await step.do("merge", () =>
      withDb(
        Effect.gen(function* collectUserIds() {
          const local = yield* orm.app.findMany({});
          const users = new Set<string>();
          for (const row of local) {
            if (row.desiredState === "deleted") {
              continue;
            }
            users.add(row.userId);
            const remoteApp = byId.get(row.id);
            if (!remoteApp) {
              // The runner no longer holds this row — it was removed on its
              // side (direct runner delete, ghost cleanup, …). It only ever
              // updates without cleaning, so drop the orphan here or its
              // unique slug shadows the next create.
              yield* orm.app.delete({ where: { id: row.id } });
              continue;
            }
            yield* orm.app.update({
              data: {
                desiredState: remoteApp.desiredState,
                internalPort: remoteApp.internalPort,
                lastDeploySha: remoteApp.lastDeploySha,
                lastError: remoteApp.lastError,
                listenPort: remoteApp.listenPort,
                status: remoteApp.status,
                subdomain: remoteApp.subdomain,
              },
              where: { id: row.id },
            });
          }
          return [...users];
        })
      )
    );
    await step.do("publish", async () => {
      await Promise.all(userIds.map((userId) => publishApps(userId)));
    });
    return { synced: remote.length, users: userIds.length };
  },
});

/** Cron: refresh app status from the runner every minute. */
export const syncAppsSchedule = schedule({
  cron: "* * * * *",
  name: "sync-apps-tick",
  params: { reason: "cron" },
  workflow: syncApps,
});

/** Vite action RPC has no worker `env` — bind durable APIs onto ALS for this call. */
const withDurableAls = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { durableBindingsReady, ensureDurableEnv, installBunDurable } =
    await import("./bun-durable");
  installBunDurable(controlEnv);
  // SAFETY: useEnv returns the ALS request env, which mirrors the controlEnv shape (strings + durable bindings), so widening to a Record for inspection is safe.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  const current = useEnv() as Record<string, unknown> | undefined;
  if (current && durableBindingsReady(current)) {
    return fn();
  }
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- the control env bag is a heterogeneous open map by design
  const bag: Record<string, unknown> = { ...controlEnv, ...current };
  ensureDurableEnv(bag);
  let req: Request;
  try {
    req = useRequest();
  } catch {
    req = new Request("https://oxide.local/durable");
  }
  // SAFETY: oxide's withRequestStore carries a `never`-keyed env store slot; the real control/ALS env bag only ever holds strings + durable binders.
  return withRequestStore({ env: bag as never, req }, fn);
};

const sleep = (ms: number) => Bun.sleep(ms);

export const enqueueOp = (payload: OpPayload, idempotencyKey?: string) =>
  withDurableAls(async () => {
    let id: string;
    try {
      ({ id } = await runnerOps.send(
        payload,
        idempotencyKey ? { idempotencyKey } : {}
      ));
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : `queue send failed: ${String(error)}`,
        { cause: error }
      );
    }
    for (let i = 0; i < 120; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential status polling; Promise.all can't early-exit on completion
      const st = await runnerOp.status(id);
      if (st.status === "complete" || st.status === "completed") {
        // SAFETY: the runner op's output is the created/patched app id envelope the workers type as `{ appId }`.
        return st.output as { appId: string };
      }
      if (
        st.status === "errored" ||
        st.status === "error" ||
        st.status === "failed"
      ) {
        throw new Error(st.error?.message ?? "runner op failed");
      }
      if (st.status === "not_found") {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
        await sleep(50);
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
      await sleep(100);
    }
    throw new Error("runner op timed out");
  });
