// Public contract types for @noitenow/poder. The integration codes against
// these exact interfaces; keep them stable.

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: driver rows carry arbitrary SQLite columns.
/** Minimal synchronous SQLite interface poder runs on. */
export interface SqliteDriver {
  open: (path: string) => SqliteDatabase;
}

/** A single open SQLite database file. */
export interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

/** A prepared statement. Parameters are positional (`?` placeholders). */
export interface SqliteStatement {
  run: (...params: unknown[]) => {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: rows carry arbitrary SQLite columns.
  all: (...params: unknown[]) => Record<string, unknown>[];
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: rows carry arbitrary SQLite columns.
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  columns?: () => { name: string }[];
}

export interface D1Binding {
  binding: string;
  databaseName: string;
  migrationsDir?: string;
}

export interface R2Binding {
  binding: string;
  bucketName: string;
}

export interface KvBinding {
  binding: string;
  id: string;
}

export interface DurableObjectBinding {
  binding: string;
  className: string;
}

export interface BindingsConfig {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: worker vars are caller-defined.
  vars?: Record<string, string | number | boolean | object>;
  d1?: D1Binding[];
  r2?: R2Binding[];
  kv?: KvBinding[];
  durableObjects?: DurableObjectBinding[];
}

export interface PoderOptions {
  /** Where all binding data lives (d1/, r2/, kv/, do/ subdirectories). */
  stateDir: string;
  /** Resolves relative `migrationsDir` entries. */
  projectDir: string;
  bindings: BindingsConfig;
  /** The imported user module (DO classes are its exports). */
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: the worker module's exports are caller-defined.
  workerModule: Record<string, unknown>;
  /** Defaults to the `node:sqlite` driver. Tests inject a `bun:sqlite` one. */
  sqlite?: SqliteDriver;
  log?: (line: string) => void;
}

export interface PoderRequestContext {
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
}

export interface Poder {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: env holds caller-defined bindings.
  env: Record<string, unknown>;
  ctx: PoderRequestContext;
  /** Calls `workerModule.default.fetch(request, env, ctx)` (or a WorkerEntrypoint class). */
  fetch: (request: Request) => Promise<Response>;
  /** Closes DBs, clears alarm timers, settles waitUntil work. */
  dispose: () => Promise<void>;
}
