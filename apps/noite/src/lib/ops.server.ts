import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { publish, queue, readWorkflowMeta, schedule, workflow } from "oxidejs";

import { failAction } from "./auth";
import { listAppsForCollaborator } from "./collaborators";
import {
  ensureDb,
  ensureDbPromise,
  orm,
  resolveEnv,
  sqlLive,
  withDb,
} from "./db";
import {
  runnerCreateApp,
  runnerDeleteApp,
  runnerListApps,
  runnerPatchApp,
  runnerRenameApp,
} from "./runner";

/** Map an unknown catch value into a mapped ActionError (client-visible).
 * Use in action catch blocks instead of repeating the instanceof ternary. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site values are unknown by construction; this helper narrows to message
export const failUnknown = (error: unknown): never =>
  failAction(error instanceof Error ? error.message : String(error));

/** Minimal app row for the reconcile merge (see collectUserIds): a narrow
 * interface keeps the raw query shallow where the full builder blows tsc's
 * depth budget. */
interface MergeRow {
  desiredState: string;
  id: string;
  userId: string;
}

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
    Effect.provide(sqlLive()),
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
          // Plain SELECT outside the paranorm builder (see MergeRow): the
          // builder exceeds tsc's depth budget in some configs, while the
          // untyped call stays shallow everywhere.
          const sql = yield* SqlClient;
          const found = yield* sql.unsafe(
            `SELECT id, userId, desiredState FROM "app"`
          );
          // SAFETY: the column list mirrors MergeRow and D1 returns plain
          // row objects.
          const local = found as MergeRow[];
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
              // @ts-expect-error TS2589: paranorm update inference exceeds tsc's depth budget here; same call shape typechecks elsewhere.
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

/** Parse oxide step durations (`ms`/`s`/`m`/`h`/`d`, default ms). */
const stepDurationMs = (spec: string): number => {
  const m = /^(?<num>\d+)\s*(?<unit>ms|s|m|h|d)?$/iu.exec(spec.trim());
  if (!m?.groups) {
    return 0;
  }
  const n = Number(m.groups.num);
  switch ((m.groups.unit ?? "ms").toLowerCase()) {
    case "s": {
      return n * 1000;
    }
    case "m": {
      return n * 60_000;
    }
    case "h": {
      return n * 3_600_000;
    }
    case "d": {
      return n * 86_400_000;
    }
    default: {
      return n;
    }
  }
};

/** Inline step shim: each step runs once, immediately, in the action isolate. */
const inlineStep = () => ({
  do: async <T>(_name: string, fn: () => T | Promise<T>): Promise<T> =>
    await fn(),
  sleep: async (_name: string, duration: string) => {
    await Effect.runPromise(Effect.sleep(stepDurationMs(duration)));
  },
  sleepUntil: () => Promise.resolve(),
  waitForEvent: () => Promise.resolve(),
});

export const enqueueOp = async (
  payload: OpPayload,
  idempotencyKey?: string
): Promise<{ appId: string }> => {
  // Interactive ops run inline, not via queue+workflow: celld only drives
  // platform-triggered (cron) workflow instances, while binding-created
  // ones wait forever (no queue consumer runs with fetch()). Same behavior
  // as the pre-worker inline runner. Schedules keep real workflows.
  // SAFETY: runnerOp is an Oxide workflow handle carrying WORKFLOW_META; the bridge below only reads its run callback.
  const meta = readWorkflowMeta(
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the handle type and the meta reader disagree on generics; unknown bridges them.
    runnerOp as unknown as Parameters<typeof readWorkflowMeta>[0]
  );
  if (!meta?.run) {
    throw new Error("runner op workflow has no run function");
  }
  // SAFETY: meta.run is the runnerOp run callback, which resolves the created/patched app id envelope; the event/ctx shapes mirror oxide's run contract.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- same generic disagreement as above; unknown bridges it.
  const run = meta.run as unknown as (
    event: { instanceId: string; payload: OpPayload; timestamp: Date },
    ctx: { env: KitEnv; step: ReturnType<typeof inlineStep> }
  ) => Promise<{ appId: string }>;
  return await run(
    {
      instanceId: idempotencyKey ?? crypto.randomUUID(),
      payload,
      timestamp: new Date(),
    },
    { env: resolveEnv(), step: inlineStep() }
  );
};
