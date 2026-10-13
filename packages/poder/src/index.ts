// @noitenow/poder: in-pod Cloudflare Workers runtime (D1, R2, KV, Durable
// Objects) over local files. See README.md for supported/approximate behavior.
import { mkdirSync } from "node:fs";
import path from "node:path";

import { migrateD1, PoderD1 } from "./d1.ts";
import {
  isDurableObjectConstructor,
  PoderDurableObjectNamespace,
} from "./durable-objects/namespace.ts";
import { ensureDbDir, recordDbIndex, sqliteDbFile } from "./file-names.ts";
import { isFunction, isRecord } from "./guards.ts";
import { PoderKV } from "./kv.ts";
import { PoderR2 } from "./r2.ts";
import { defaultSqliteDriver } from "./sqlite.ts";
import type { Poder, PoderOptions, PoderRequestContext } from "./types.ts";

export type { DurableObjectConstructor } from "./durable-objects/namespace.ts";
export type { D1Meta, D1Result, D1Session, D1PreparedStatement } from "./d1.ts";
export type {
  BindingsConfig,
  SqliteDatabase,
  SqliteDriver,
  SqliteStatement,
} from "./types.ts";
export { DurableObjectId } from "./durable-objects/ids.ts";
export { PoderD1 } from "./d1.ts";
export { PoderDurableObjectNamespace } from "./durable-objects/namespace.ts";
export { PoderKV } from "./kv.ts";
export { PoderR2 } from "./r2.ts";
export { readBindings } from "./bindings.ts";
export { defaultSqliteDriver } from "./sqlite.ts";
export { WebSocketPair } from "./websockets.ts";
export { DurableObject, RpcTarget, WorkerEntrypoint } from "./workers-shim.ts";

interface PoderGlobals {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: the installed request env is caller-defined.
  __poderEnv?: Record<string, unknown>;
  __poderWaitUntil?: (promise: Promise<unknown>) => void;
}

type FetchHandler = (
  request: Request,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: worker envs are caller-defined.
  env: Record<string, unknown>,
  ctx: PoderRequestContext
) => Promise<Response>;

const poderGlobals = (): PoderGlobals =>
  // SAFETY: poder installs its env/waitUntil on globalThis for the request scope and restores them in dispose().
  globalThis as PoderGlobals;

const track = (
  settled: Promise<unknown>[],
  promise: Promise<unknown>
): void => {
  settled.push(promise);
  void (async (): Promise<void> => {
    try {
      await promise;
    } catch {
      // Tracked faults settle via dispose(); they must not throw here.
    }
  })();
};

const isWorkerEntrypoint = (
  exported: unknown
): exported is new (
  ctx: PoderRequestContext,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: worker envs are caller-defined.
  env: Record<string, unknown>
) => { fetch: (request: Request) => Promise<Response> } =>
  typeof exported === "function" &&
  exported.prototype !== undefined &&
  typeof exported.prototype.fetch === "function";

// oxlint-disable-next-line eslint/require-await -- mirrors the async poder factory API; setup faults surface as rejections.
export const createPoder = async (options: PoderOptions): Promise<Poder> => {
  const sqlite = options.sqlite ?? defaultSqliteDriver;
  const log = options.log ?? ((): void => undefined);
  mkdirSync(options.stateDir, { recursive: true });

  // oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- contract: env aggregates caller-defined bindings; the spread is the value.
  const env: Record<string, unknown> = { ...options.bindings.vars };
  const closables: { close: () => void }[] = [];
  const namespaces: PoderDurableObjectNamespace[] = [];
  const settled: Promise<unknown>[] = [];

  ensureDbDir(options.stateDir);
  for (const binding of options.bindings.d1 ?? []) {
    const file = sqliteDbFile(options.stateDir, "d1", [
      binding.binding,
      binding.databaseName,
    ]);
    recordDbIndex(options.stateDir, file, {
      binding: binding.binding,
      kind: "d1",
      name: binding.databaseName,
    });
    const db = sqlite.open(file);
    closables.push(db);
    migrateD1(db, {
      log,
      migrationsDir: binding.migrationsDir,
      projectDir: options.projectDir,
    });
    env[binding.binding] = new PoderD1(db, binding.databaseName, file);
  }

  for (const binding of options.bindings.r2 ?? []) {
    env[binding.binding] = new PoderR2(
      path.join(options.stateDir, "r2", binding.bucketName)
    );
  }

  for (const binding of options.bindings.kv ?? []) {
    const kv = PoderKV.open(
      sqlite,
      options.stateDir,
      binding.binding,
      binding.id
    );
    closables.push(kv);
    env[binding.binding] = kv;
  }

  for (const binding of options.bindings.durableObjects ?? []) {
    const ctor = options.workerModule[binding.className];
    if (!isDurableObjectConstructor(ctor)) {
      throw new TypeError(
        `Durable Object class "${binding.className}" (binding "${binding.binding}") is not exported by the worker module`
      );
    }
    const namespace = new PoderDurableObjectNamespace({
      binding: binding.binding,
      className: binding.className,
      ctor,
      env,
      sqlite,
      stateDir: options.stateDir,
    });
    namespaces.push(namespace);
    env[binding.binding] = namespace;
  }

  const previousEnv = poderGlobals().__poderEnv;
  const previousWaitUntil = poderGlobals().__poderWaitUntil;
  poderGlobals().__poderEnv = env;
  poderGlobals().__poderWaitUntil = (promise: Promise<unknown>): void => {
    track(settled, promise);
  };

  const ctx: PoderRequestContext = {
    passThroughOnException: (): void => undefined,
    waitUntil: (promise: Promise<unknown>): void => {
      track(settled, promise);
    },
  };

  return {
    ctx,
    async dispose(): Promise<void> {
      for (const namespace of namespaces) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- dispose settles each namespace (alarms, pending work) before closing shared DBs.
        await namespace.dispose();
      }
      for (const closable of closables) {
        closable.close();
      }
      await Promise.allSettled(settled);
      if (poderGlobals().__poderEnv === env) {
        poderGlobals().__poderEnv = previousEnv;
      }
      poderGlobals().__poderWaitUntil = previousWaitUntil;
    },
    env,
    fetch: (request: Request): Promise<Response> => {
      const exported = options.workerModule["default"];
      if (isWorkerEntrypoint(exported)) {
        return new exported(ctx, env).fetch(request);
      }
      if (
        isRecord(exported) &&
        "fetch" in exported &&
        isFunction(exported["fetch"])
      ) {
        // SAFETY: modules past this gate expose default.fetch(request, env, ctx) resolving a Response; the guards ruled out classes and missing members.
        const fetch = exported["fetch"] as FetchHandler;
        return fetch(request, env, ctx);
      }
      throw new Error(
        "Worker module has no default fetch handler or WorkerEntrypoint export"
      );
    },
  };
};
