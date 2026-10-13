// Durable Object namespace: one SQLite file per object id, one live instance
// per id, and an input gate that runs one request/RPC per object at a time.
// Database files live flat under `<stateDir>/db/` (see file-names.ts).
// Alarms persist in storage and refire on restart via `readAlarmSync`.
import { createHash, randomBytes } from "node:crypto";

import { ensureDbDir, recordDbIndex, sqliteDbFile } from "../file-names.ts";
import { isFunction, isString } from "../guards.ts";
import type { SqliteDriver } from "../types.ts";
import type { PoderWebSocket } from "../websockets.ts";
import { DurableObjectId } from "./ids.ts";
import { DOStorage } from "./storage.ts";

export interface DurableObjectContext {
  id: DurableObjectId;
  storage: DOStorage;
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
  blockConcurrencyWhile: <T>(callback: () => T | Promise<T>) => Promise<T>;
  acceptWebSocket: (ws: PoderWebSocket) => void;
}

export type DurableObjectConstructor = new (
  ctx: DurableObjectContext,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: the platform env is caller-defined.
  env: Record<string, unknown>
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: instances expose arbitrary RPC members.
) => Record<string, unknown>;

/** Narrows worker-module exports to DO constructors (platform shape check). */
export const isDurableObjectConstructor = (
  value: unknown
): value is DurableObjectConstructor => typeof value === "function";

interface ObjectRecord {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: object instances expose arbitrary RPC members.
  instance: Record<string, unknown>;
  storage: DOStorage;
  gate: Promise<void>;
  pending: Promise<unknown>[];
  alarmTimer: ReturnType<typeof setTimeout> | null;
}

interface FetchStub {
  fetch: (request: Request) => Promise<Response>;
}

const MAX_TIMER_DELAY = 2_147_483_647;

export class PoderDurableObjectNamespace {
  readonly binding: string;
  readonly className: string;
  private readonly ctor: DurableObjectConstructor;
  private readonly stateDir: string;
  private readonly sqlite: SqliteDriver;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: the namespace shares the worker env with every object instance.
  private readonly env: Record<string, unknown>;
  private readonly records = new Map<string, ObjectRecord>();

  constructor(options: {
    binding: string;
    className: string;
    ctor: DurableObjectConstructor;
    stateDir: string;
    sqlite: SqliteDriver;
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: the namespace shares the worker env with every object instance.
    env: Record<string, unknown>;
  }) {
    this.binding = options.binding;
    this.className = options.className;
    this.ctor = options.ctor;
    this.stateDir = options.stateDir;
    this.sqlite = options.sqlite;
    this.env = options.env;
    ensureDbDir(options.stateDir);
  }

  idFromName(name: string): DurableObjectId {
    const id = createHash("sha256")
      .update(`${this.className}\0${name}`, "utf-8")
      .digest("hex");
    return new DurableObjectId(id, name);
  }

  // oxlint-disable-next-line eslint/class-methods-use-this -- instance shape mirrors the Cloudflare namespace API.
  newUniqueId(): DurableObjectId {
    return new DurableObjectId(randomBytes(32).toString("hex"));
  }

  // oxlint-disable-next-line eslint/class-methods-use-this -- instance shape mirrors the Cloudflare namespace API.
  idFromString(hex: string): DurableObjectId {
    if (!/^[0-9a-fA-F]{64}$/u.test(hex)) {
      throw new Error(`Invalid Durable Object id: ${hex}`);
    }
    return new DurableObjectId(hex.toLowerCase());
  }

  // oxlint-disable-next-line anti-slop/no-unknown-returns -- contract: stubs are dynamically-shaped RPC proxies by definition.
  get(id: DurableObjectId): unknown {
    const record = this.recordFor(id);
    return this.stubFor(record, id);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-returns -- contract: stubs are dynamically-shaped RPC proxies by definition.
  getByName(name: string): unknown {
    return this.get(this.idFromName(name));
  }

  jurisdiction(_jurisdiction: string): this {
    return this;
  }

  private recordFor(id: DurableObjectId): ObjectRecord {
    const existing = this.records.get(id.id);
    if (existing !== undefined) {
      return existing;
    }
    const file = sqliteDbFile(this.stateDir, "do", [this.binding, id.id]);
    recordDbIndex(this.stateDir, file, {
      binding: this.binding,
      kind: "do",
      name: id.name ?? id.id,
    });
    const storage = new DOStorage(this.sqlite.open(file));
    const record: ObjectRecord = {
      alarmTimer: null,
      gate: Promise.resolve(),
      instance: {},
      pending: [],
      storage,
    };
    const context: DurableObjectContext = {
      acceptWebSocket: (ws: PoderWebSocket): void => {
        ws.accept();
      },
      // oxlint-disable-next-line eslint/require-await -- contract: blockConcurrencyWhile mirrors the platform gate; the callback runs inline and faults surface as rejections.
      blockConcurrencyWhile: async <T>(
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- contract: same platform gate (callback parameter).
        callback: () => T | Promise<T>
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- contract: same platform gate (callback invocation).
      ): Promise<T> => callback(),
      id,
      passThroughOnException: (): void => undefined,
      storage,
      waitUntil: (promise: Promise<unknown>): void => {
        record.pending.push(promise);
        void (async (): Promise<void> => {
          try {
            await promise;
          } catch {
            // waitUntil faults settle via dispose(); they must not throw here.
          }
        })();
      },
    };
    record.instance = new this.ctor(context, this.env);
    storage.onAlarm((at: number | null) => {
      this.scheduleAlarm(record, id, at);
    });
    this.records.set(id.id, record);
    this.scheduleAlarm(record, id, storage.readAlarmSync());
    return record;
  }

  private scheduleAlarm(
    record: ObjectRecord,
    id: DurableObjectId,
    at: number | null
  ): void {
    if (record.alarmTimer !== null) {
      clearTimeout(record.alarmTimer);
      record.alarmTimer = null;
    }
    if (at === null) {
      return;
    }
    const delay = Math.max(0, Math.min(at - Date.now(), MAX_TIMER_DELAY));
    record.alarmTimer = setTimeout(() => {
      record.alarmTimer = null;
      void this.dispatch(record, id, "alarm", [], at);
    }, delay);
  }

  private stubFor(record: ObjectRecord, id: DurableObjectId): FetchStub {
    const target: FetchStub = {
      fetch: (request: Request): Promise<Response> =>
        // SAFETY: the fetch entry always resolves a Response; dispatch passes Response results through unchanged.
        this.dispatch(
          record,
          id,
          "fetch",
          [request],
          null
        ) as Promise<Response>,
    };
    return new Proxy(target, {
      get: (obj, prop) => {
        if (prop === "then") {
          return;
        }
        if (prop === "fetch") {
          return (...args: unknown[]): Promise<Response> =>
            // SAFETY: fetch stubs always receive the Request as the first argument.
            obj.fetch(args[0] as Request);
        }
        // oxlint-disable-next-line eslint/prefer-destructuring -- computed member read; the key is dynamic by definition.
        // SAFETY: string keys other than fetch are RPC methods served by dispatch; declared members resolve first.
        const own = obj[prop as keyof typeof obj];
        if (own !== undefined) {
          return own;
        }
        if (isString(prop)) {
          return (...args: unknown[]) =>
            this.dispatch(record, id, prop, args, null);
        }
      },
    });
  }

  private dispatch(
    record: ObjectRecord,
    id: DurableObjectId,
    method: string,
    args: unknown[],
    firedAlarm: number | null
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- contract: RPC methods resolve arbitrary values by definition.
  ): Promise<unknown> {
    const { gate } = record;
    const run = (async () => {
      await gate;
      const handler = record.instance[method];
      if (!isFunction(handler)) {
        if (method === "alarm") {
          if (firedAlarm !== null) {
            record.storage.clearAlarmSync(firedAlarm);
          }
          return;
        }
        throw new Error(
          `Durable Object ${this.className} has no method: ${method}`
        );
      }
      const cloned = method === "fetch" ? args : structuredClone(args);
      const result = await handler.bind(record.instance)(...cloned);
      if (method === "alarm" && firedAlarm !== null) {
        record.storage.clearAlarmSync(firedAlarm);
      }
      if (result instanceof Response) {
        return result;
      }
      return structuredClone(result);
    })();
    const settle = (async () => {
      try {
        await run;
      } catch {
        // Turn faults stay on the stub promise; the gate always opens.
      }
    })();
    // The next turn chains onto this turn synchronously: awaiting here would
    // yield and let a later turn jump the queue.
    record.gate = settle;
    return run;
  }

  async dispose(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.alarmTimer !== null) {
        clearTimeout(record.alarmTimer);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- dispose settles each object (alarms, pending work) before closing its storage.
      await Promise.allSettled(record.pending);
      record.storage.close();
    }
    this.records.clear();
  }
}
