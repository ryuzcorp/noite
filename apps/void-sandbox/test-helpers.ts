// Shared fakes for the void-sandbox tests: in-memory DO storage/state, a
// scripted container with deferred exec processes, and DO namespaces. The
// controller and admission classes under test are always the real bundle
// classes over the real `void/_sandbox-container` base; only the
// `cloudflare:workers` module itself is stubbed (see test-setup.ts).
/* oxlint-disable eslint/max-classes-per-file -- seven fakes share this helper module */
/* oxlint-disable eslint/require-await, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: they mirror async platform interfaces and stand in for bindings they only partly implement */
import type {
  SandboxExecOptions,
  SandboxOptions,
} from "void/_sandbox-container";

import type { AdmissionResult } from "./src/admission.ts";
import type { NoiteStartOptions, NoiteTcpPort } from "./src/controller.ts";
import type { ControllerEnv } from "./src/env.ts";
import SandboxService from "./worker.ts";

export class Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  constructor() {
    const { promise, resolve } = Promise.withResolvers<T>();
    this.promise = promise;
    this.resolve = resolve;
  }
}

/** In-memory storage. Every op yields a microtask (no timers) so concurrent callers interleave. */
export class FakeStorage {
  readonly store = new Map<string, unknown>();
  alarmAt: number | null = null;
  gets = 0;
  puts = 0;
  /** Crash-window scripting: puts whose 1-based index matches throw. */
  failPut: ((putIndex: number) => boolean) | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    this.gets += 1;
    await Promise.resolve();

    return this.store.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.puts += 1;
    await Promise.resolve();

    if (this.failPut?.(this.puts) === true) {
      throw new Error("storage boom");
    }

    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    await Promise.resolve();

    return this.store.delete(key);
  }

  async setAlarm(at: number): Promise<void> {
    await Promise.resolve();
    this.alarmAt = at;
  }

  async getAlarm(): Promise<number | null> {
    await Promise.resolve();

    return this.alarmAt;
  }

  async deleteAlarm(): Promise<void> {
    await Promise.resolve();
    this.alarmAt = null;
  }
}

/** Deferred exec process: `finish` settles the exit; `kill` records and settles nonzero. */
export class FakeProcess {
  readonly kills: (number | undefined)[] = [];
  readonly pid: number;
  stdin: WritableStream | null = null;
  stdout: ReadableStream | null = null;
  stderr: ReadableStream | null = null;
  /** celld 0006: scripted per test — set for the `pty` exec under test. */
  isPty = false;
  readonly resizes: { readonly cols: number; readonly rows: number }[] = [];
  killCode = 137;
  readonly #exit = new Deferred<number>();
  readonly exitCode: Promise<number>;

  constructor(pid = 4242) {
    this.pid = pid;
    this.exitCode = this.#exit.promise;
  }

  finish(code: number): void {
    this.#exit.resolve(code);
  }

  kill(signal?: number): void {
    this.kills.push(signal);
    this.#exit.resolve(this.killCode);
  }

  /** Mirrors the native refusal: only a PTY process resizes. */
  async resize(cols: number, rows: number): Promise<void> {
    if (!this.isPty) {
      throw new Error("resize() requires a PTY process.");
    }

    this.resizes.push({ cols, rows });
  }

  async output(): Promise<ExecOutput> {
    const exitCode = await this.exitCode;

    return {
      exitCode,
      stderr: new ArrayBuffer(0),
      stdout: new ArrayBuffer(0),
    };
  }
}

export interface ExecCall {
  readonly argv: string[];
  readonly options: SandboxExecOptions;
}

/** Scripted container. `execImpl` decides each process; the default never settles, so tests script it. */
export class FakeContainer {
  running = false;
  images = { default: "fake-image:1" };
  readonly starts: NoiteStartOptions[] = [];
  readonly execCalls: ExecCall[] = [];
  destroys = 0;
  /** Resolves when `destroy` is entered, before the container reports gone. */
  readonly destroyEntered = new Deferred<void>();
  /** Set to hold a destroy mid-flight (the crash/reap race window). */
  holdDestroy: Deferred<void> | null = null;
  readonly inactivityTimeouts: number[] = [];
  readonly tcpFetches: { readonly port: number; readonly request: Request }[] =
    [];
  // oxlint-disable-next-line eslint/class-methods-use-this -- per-instance script hook reassigned by tests; the default ignores the instance.
  execImpl: (argv: string[], options: SandboxExecOptions) => FakeProcess = () =>
    new FakeProcess();
  // oxlint-disable-next-line eslint/class-methods-use-this -- per-instance script hook reassigned by tests; the default ignores the instance.
  fetchImpl: (port: number, request: Request) => Response = () =>
    new Response("fake-port");

  start(options: NoiteStartOptions): void {
    this.starts.push(options);
    this.running = true;
  }

  async exec(
    argv: string[],
    options: SandboxExecOptions = {}
  ): Promise<FakeProcess> {
    this.execCalls.push({ argv, options });

    return this.execImpl(argv, options);
  }

  async destroy(): Promise<void> {
    this.destroys += 1;
    this.destroyEntered.resolve();

    if (this.holdDestroy !== null) {
      await this.holdDestroy.promise;
    }

    this.running = false;
  }

  async setInactivityTimeout(ms: number): Promise<void> {
    this.inactivityTimeouts.push(ms);
  }

  getTcpPort(port: number): NoiteTcpPort {
    return {
      fetch: async (request: Request): Promise<Response> => {
        this.tcpFetches.push({ port, request });

        return this.fetchImpl(port, request);
      },
    };
  }
}

/** Script every exec to exit with `code` immediately (microtasks only). */
export const succeedExec = (container: FakeContainer, code = 0): void => {
  container.execImpl = (): FakeProcess => {
    const process = new FakeProcess();
    process.finish(code);

    return process;
  };
};

export interface CtxInit {
  readonly id?: string;
  readonly storage?: FakeStorage;
  /** Omit (or null) for a DO with no container binding. */
  readonly container?: FakeContainer | null;
}

export const makeCtx = (init: CtxInit = {}): DurableObjectState => {
  const storage = init.storage ?? new FakeStorage();

  // SAFETY: tests drive only `id.toString`, `storage` (see FakeStorage),
  // `blockConcurrencyWhile` and `container` on the state; the casts stand in
  // for the platform-provided remainder.
  return {
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    container:
      init.container === undefined || init.container === null
        ? undefined
        : (init.container as unknown),
    id: { toString: (): string => init.id ?? "test-do-id-1" },
    storage: storage as unknown as DurableObjectStorage,
  } as unknown as DurableObjectState;
};

export class FakeNamespace<T extends object> {
  readonly instances = new Map<string, T>();
  readonly factory: (name: string) => T;
  constructor(factory: (name: string) => T) {
    this.factory = factory;
  }
  getByName(name: string): T {
    const existing = this.instances.get(name);

    if (existing !== undefined) {
      return existing;
    }

    const created = this.factory(name);
    this.instances.set(name, created);

    return created;
  }
}

/** Scriptable admission binding for controller tests (the real admission DO has its own suite). */
export class FakeAdmission {
  readonly calls: {
    readonly method: string;
    readonly id: string;
    readonly generation: string;
  }[] = [];
  reserveResult: AdmissionResult = { ok: true };
  startedResult: AdmissionResult = { ok: true };
  heartbeatResult: AdmissionResult = { ok: true };

  async reserve(id: string, generation: string): Promise<AdmissionResult> {
    this.calls.push({ generation, id, method: "reserve" });

    return this.reserveResult;
  }

  async started(id: string, generation: string): Promise<AdmissionResult> {
    this.calls.push({ generation, id, method: "started" });

    return this.startedResult;
  }

  async heartbeat(id: string, generation: string): Promise<AdmissionResult> {
    this.calls.push({ generation, id, method: "heartbeat" });

    return this.heartbeatResult;
  }

  async stopped(id: string, generation: string): Promise<void> {
    this.calls.push({ generation, id, method: "stopped" });
  }
}

export class FakeSandboxStub {
  readonly configured: SandboxOptions[] = [];
  async configure(options: SandboxOptions): Promise<void> {
    this.configured.push(options);
  }
}

export interface EnvFakes {
  readonly sandbox?: FakeNamespace<FakeSandboxStub>;
  readonly admission?: FakeNamespace<FakeAdmission>;
  readonly maxConcurrent?: string;
  readonly source?: string;
  readonly admissionName?: string | null;
}

export const makeControllerEnv = (fakes: EnvFakes = {}): ControllerEnv => ({
  SANDBOX: (fakes.sandbox ??
    new FakeNamespace(
      () => new FakeSandboxStub()
    )) as unknown as ControllerEnv["SANDBOX"],
  __VOID_SANDBOX_ADMISSION: (fakes.admission ??
    new FakeNamespace(
      () => new FakeAdmission()
    )) as unknown as ControllerEnv["__VOID_SANDBOX_ADMISSION"],
  __VOID_SANDBOX_ADMISSION_NAME:
    fakes.admissionName === null
      ? undefined
      : (fakes.admissionName ?? "test-admission-name-0123456789abcdefghij"),
  __VOID_SANDBOX_MAX_CONCURRENT: fakes.maxConcurrent,
  __VOID_SANDBOX_SOURCE: fakes.source,
});

export const makeService = (env: ControllerEnv): SandboxService =>
  // SAFETY: `getSandbox` reads only `env`; the execution context is unused.
  new SandboxService({} as unknown as ExecutionContext, env);
