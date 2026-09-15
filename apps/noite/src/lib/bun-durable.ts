/**
 * In-process Oxide durable bindings for `preset: "fetch"` (Bun).
 * Mirrors celld/CF workflow + queue bindings so workflow()/queue()/schedule() run locally.
 */
import {
  dispatchSchedule,
  readQueueMeta,
  readScheduleMeta,
  readWorkflowMeta,
  withRequestStore,
} from "oxidejs";
import type { QueueHandle, WorkflowHandle } from "oxidejs";

import { controlEnv, hydrateControlEnv } from "./control-env";
import * as ops from "./ops.server";

interface Instance {
  id: string;
  status: "running" | "complete" | "errored";
  output?: unknown;
  error?: { message: string };
}

const instances = new Map<string, Instance>();
let schedulesStarted = false;
let installed = false;

const sleepMs = (spec: string): number => {
  const m = /^(?<num>\d+)\s*(?<unit>ms|s|m|h|d)?$/iu.exec(spec.trim());
  if (!m?.groups) {
    return 0;
  }
  const n = Number(m.groups.num);
  const u = (m.groups.unit ?? "ms").toLowerCase();
  if (u === "ms") {
    return n;
  }
  if (u === "s") {
    return n * 1000;
  }
  if (u === "m") {
    return n * 60_000;
  }
  if (u === "h") {
    return n * 3_600_000;
  }
  if (u === "d") {
    return n * 86_400_000;
  }
  return n;
};

const makeStep = () => ({
  do: async <T>(_name: string, fn: () => T | Promise<T>): Promise<T> =>
    await fn(),
  sleep: async (_name: string, duration: string) => {
    const ms = sleepMs(duration);
    if (ms > 0) {
      await Bun.sleep(ms);
    }
  },
});

const installWorkflow = (
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  env: Record<string, unknown>,
  handle: WorkflowHandle<unknown>
) => {
  const meta = readWorkflowMeta(handle);
  if (!meta?.run) {
    return;
  }
  const binding = String(meta.binding);
  env[binding] = {
    create: (opts: { id?: string; params?: unknown }) => {
      const id = opts.id ?? crypto.randomUUID();
      if (instances.has(id)) {
        throw new Error(`instance ${id} already exists`);
      }
      const inst: Instance = { id, status: "running" };
      instances.set(id, inst);
      const envBag = env;
      // Fire-and-forget like Cloudflare Workflows.create — callers poll status.
      void withRequestStore(
        {
          // SAFETY: withRequestStore carries an oxide runtime context; the control env bag only ever holds strings + durable bindings written before boot, so widening to the framework's `never` store slot is harmless.
          env: envBag as never,
          req: new Request("https://oxide.local/workflow"),
        },
        async () => {
          try {
            // SAFETY: meta.run is a Workflow run; the event/ctx shapes here mirror oxide's own argument contract.
            const run = meta.run as WorkflowRunFn;
            const output = await run(
              {
                instanceId: id,
                payload: opts.params,
                timestamp: new Date(),
              },
              {
                env: envBag,
                step: {
                  ...makeStep(),
                  sleepUntil: () => Promise.resolve(),
                  waitForEvent: () => Promise.resolve(),
                },
              }
            );
            inst.status = "complete";
            inst.output = output;
          } catch (error) {
            inst.status = "errored";
            inst.error = {
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }
      );
      return { id };
    },
    get: (id: string) => {
      const inst = instances.get(id);
      if (!inst) {
        throw new Error(`instance ${id} not_found`);
      }
      return {
        sendEvent: () => Promise.resolve(),
        status: () => ({
          error: inst.error,
          output: inst.output,
          status: inst.status,
        }),
      };
    },
  };
};

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
type WorkflowEvent = Record<string, unknown>;
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
type WorkflowCtx = Record<string, unknown>;

/** Concrete contract for the durable `run` callback (event + ctx pair). */
/* oxlint-disable anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */
type WorkflowRunFn = (
  event: WorkflowEvent,
  ctx: WorkflowCtx
) => Promise<WorkflowResult>;
/* oxlint-enable anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
type WorkflowResult = Record<string, unknown>;

const installQueue = (
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  env: Record<string, unknown>,
  handle: QueueHandle<unknown>
) => {
  const meta = readQueueMeta(handle);
  if (!meta) {
    return;
  }
  env[String(meta.binding)] = {
    send: () => Promise.resolve(),
    sendBatch: () => Promise.resolve(),
  };
};

const cronMatches = (cron: string, d: Date): boolean => {
  const parts = cron.trim().split(/\s+/u);
  if (parts.length !== 5) {
    return false;
  }
  const vals = [
    d.getUTCMinutes(),
    d.getUTCHours(),
    d.getUTCDate(),
    d.getUTCMonth() + 1,
    d.getUTCDay(),
  ];
  for (let i = 0; i < 5; i += 1) {
    const p = parts[i];
    if (p === undefined) {
      continue;
    }
    if (p === "*") {
      continue;
    }
    if (Number(p) !== vals[i]) {
      return false;
    }
  }
  return true;
};

const startSchedules = (
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  env: Record<string, unknown>
) => {
  if (schedulesStarted) {
    return;
  }
  schedulesStarted = true;
  const meta = readScheduleMeta(ops.syncAppsSchedule);
  if (!meta) {
    return;
  }
  let lastMin = -1;
  const timer = setInterval(() => {
    const now = new Date();
    const min = now.getUTCMinutes();
    if (min === lastMin) {
      return;
    }
    if (!cronMatches(meta.cron, now)) {
      return;
    }
    lastMin = min;
    void (async () => {
      try {
        await dispatchSchedule(
          [meta],
          { cron: meta.cron, scheduledTime: now.getTime() },
          env
        );
      } catch (error) {
        console.error("schedule tick failed", error);
      }
    })();
  }, 15_000);
  timer.unref?.();
};

const hasDurableBindings = (
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  env: Record<string, unknown>
) =>
  Boolean(
    env.RUNNER_OP &&
    // SAFETY: RUNNER_OP is only ever installed by installWorkflow as a `{ create }` binder before this is called.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    typeof (env.RUNNER_OP as { create?: unknown }).create === "function" &&
    env.RUNNER_OPS &&
    // SAFETY: RUNNER_OPS is only ever installed by installQueue as a `{ send }` binder before this is called.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    typeof (env.RUNNER_OPS as { send?: unknown }).send === "function"
  );

/** Install workflow/queue bindings onto the shared control env bag. */
export const installBunDurable = (
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  env: Record<string, unknown> = controlEnv
) => {
  hydrateControlEnv();
  if (env !== controlEnv) {
    for (const [k, v] of Object.entries(controlEnv)) {
      if (env[k] === undefined) {
        env[k] = v;
      }
    }
  }
  if (installed && hasDurableBindings(env)) {
    startSchedules(env);
    return;
  }
  installWorkflow(env, ops.runnerOp);
  installWorkflow(env, ops.syncApps);
  installQueue(env, ops.runnerOps);
  startSchedules(env);
  installed = true;
};

/** Ensure request env has the same durable bindings as controlEnv. */
export const ensureDurableEnv = (
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  env: Record<string, unknown>
) => {
  installBunDurable(controlEnv);
  for (const [key, value] of Object.entries(controlEnv)) {
    // SAFETY: env bindings are either durable objects (already-built binders) or plain strings; object check distinguishes durable binders so they are copied wholesale.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (value && typeof value === "object") {
      env[key] = value;
    } else if (env[key] === undefined) {
      env[key] = value;
    }
  }
};

export const durableBindingsReady = (
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  env: Record<string, unknown>
) => hasDurableBindings(env);
