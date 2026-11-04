/**
 * Noite-owned sandbox controller runtime: the `SandboxController` Durable
 * Object of the `noite-void-sandbox` script (see SPEC.md "Void sandbox
 * controller").
 *
 * Adapted from Void's `platform/packages/api/src/sandbox-controller-runtime.ts`
 * (MIT License, Copyright Cloudflare — see NOTICE). The lease, admission,
 * activity and alarm structure is Void's; every Noite (celld) change is marked
 * `Noite:` below:
 *
 * - Noite: no `start({ instance })`. celld sizes containers from the
 *   `containers[]` config, so the `container` wrapper strips the `instance`
 *   start arg the base class passes, and there is no
 *   `__VOID_SANDBOX_INSTANCE` var.
 * - Noite: `image` is always `images.default`. There is no
 *   `cloudflare/debian-trixie` branch, no `__VOID_SANDBOX_IMAGE` var, no
 *   runtime shim injection and no entrypoint override; the base-class defaults
 *   already do this, so the overrides are simply absent.
 * - Noite: the sandbox shim must be baked into the image. `initialize()`
 *   probes for `/usr/local/bin/sandbox-shim` and fails closed with a clear
 *   error when a custom image lacks it.
 * - Noite: `signal` flows to celld. celld `exec()` honors the AbortSignal
 *   natively (0010/0015: abort sends SIGKILL through the exec kill path),
 *   so `execProcess()` forwards it untouched.
 * - Noite: PTY passthrough. celld `exec()` takes `pty` (`true` or
 *   `{ cols, rows }`, patch 0006), so `execProcess()` forwards it; the wire
 *   `isPty` reads the native value and `resize` is the native resize.
 * - Noite: `fetch()` carries the activity guard, so direct port fetches
 *   refresh the idle deadline like `invoke` does.
 * - Noite: direct `execProcess()` heartbeats like `invoke` (setup-time execs
 *   excepted), so a denied lease cannot be outlived past one interval.
 * - Noite: `beforeStart()` serializes per cell, so a superseded start's
 *   reservation is released instead of orphaned.
 * - Noite: no `SandboxCapability` wrapper. The worker returns this DO's stub
 *   directly (the DO-stub shape); see `worker.ts`. Every method on this class
 *   is therefore tenant-reachable — keep them tenant-safe, and keep the
 *   method-set gate test (`controller.test.ts`) exact.
 */
import { SandboxContainer } from "void/_sandbox-container";
import type {
  SandboxExecOptions,
  SandboxNativeContainer,
  SandboxOptions,
  SandboxProcessWire,
} from "void/_sandbox-container";

import type { AdmissionResult } from "./admission.ts";
import { MIN_ADMISSION_NAME_LENGTH } from "./admission.ts";
import type { ControllerEnv } from "./env.ts";

interface Control {
  readonly reserve: (
    instanceId: string,
    generation: string
  ) => Promise<AdmissionResult>;
  readonly started: (
    instanceId: string,
    generation: string
  ) => Promise<AdmissionResult>;
  readonly heartbeat: (
    instanceId: string,
    generation: string
  ) => Promise<AdmissionResult>;
  readonly stopped: (instanceId: string, generation: string) => Promise<void>;
}

interface Lease {
  readonly generation: string;
  readonly phase: "pending" | "running" | "stopped";
}

const LEASE_KEY = "__voidSandboxLease";
const ACTIVITY_KEY = "__voidSandboxActivity";

interface Activity {
  readonly lastActivity: number;
  readonly idleDeadline: number;
}

const HEARTBEAT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 5000;

/** Path the `@cloudflare/sandbox` file operations shell out to. */
const SHIM_PATH = "/usr/local/bin/sandbox-shim";
const SHIM_PROBE_TIMEOUT_MS = 30_000;

/**
 * Minimal celld container surface the controller relies on. celld `start()`
 * takes `{ image, enableInternet, labels, entrypoint, env }` and `exec()`
 * takes `{ env, cwd, user, stdout, stderr, stdin, pty, signal, combined }`
 * — only `start()`'s Cloudflare-only `instance` key is stripped.
 */
export interface NoiteContainer {
  readonly running: boolean;
  readonly images: Record<string, string>;
  readonly start: (options: NoiteStartOptions) => void;
  readonly exec: (
    argv: string[],
    options?: SandboxExecOptions
  ) => Promise<NoiteExecProcess>;
  readonly destroy: () => Promise<void>;
  readonly setInactivityTimeout: (ms: number) => Promise<void>;
  readonly getTcpPort: (port: number) => NoiteTcpPort;
}

export interface NoiteStartOptions {
  readonly image: string;
  readonly enableInternet: boolean;
  readonly labels?: Record<string, string>;
  readonly entrypoint?: string[];
}

export interface NoiteTcpPort {
  readonly fetch: (request: Request) => Promise<Response>;
}

interface NoiteExecProcess {
  readonly pid: number;
  readonly exitCode: Promise<number>;
  readonly stdin: WritableStream | null;
  readonly stdout: ReadableStream | null;
  readonly stderr: ReadableStream | null;
  /** celld patch 0006: set for `pty` execs, with the native resize. */
  readonly isPty: boolean;
  readonly kill: (signal?: number) => void;
  readonly resize: (cols: number, rows: number) => Promise<void>;
  readonly output: () => Promise<ExecOutput>;
}

type BaseStartOptions = Parameters<SandboxNativeContainer["start"]>[0];

type BaseExecProcess = Awaited<ReturnType<SandboxNativeContainer["exec"]>>;

/** Failure capture `processContext` mints and `waitForProcessExit` reads back. */
interface ProcessCompletion {
  failure?: Error;
}

/**
 * Noite: restore exactly the container surface `SandboxContainer` uses,
 * minus the Cloudflare-only `instance` start arg. Each access builds a fresh
 * wrapper (no cached state, so no construction-order hazard with the base
 * constructor, which touches `container` behind `blockConcurrencyWhile`).
 */
const wrapCelldContainer = (
  native: SandboxNativeContainer
): SandboxNativeContainer => {
  // At runtime this is celld's container, not Cloudflare's. The wrapper
  // forwards the members the base class touches (`running`, `images`,
  // `start`, `exec`, `destroy`, `setInactivityTimeout`, `getTcpPort` — the
  // full set in the pinned `void`; `controller.test.ts` drives every one
  // end to end) and strips `instance` from `start`. Methods keep their native
  // receiver; only plain forwarding plus the strip happens here.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: see above.
  const noite = native as unknown as NoiteContainer;

  const wrapped = {
    destroy: (): Promise<void> => noite.destroy(),
    exec: (
      argv: string[],
      options?: SandboxExecOptions
    ): Promise<NoiteExecProcess> => {
      if (options === undefined) {
        return noite.exec(argv);
      }

      // Every exec option is portable now (`signal` since celld 0010, `pty`
      // since 0006): only `start()` strips anything.
      return noite.exec(argv, { ...options });
    },
    getTcpPort: (port: number): NoiteTcpPort => noite.getTcpPort(port),
    get images(): Record<string, string> {
      return noite.images;
    },
    get running(): boolean {
      return noite.running;
    },
    setInactivityTimeout: (ms: number): Promise<void> =>
      noite.setInactivityTimeout(ms),
    start: (options: BaseStartOptions): void => {
      const { instance: _droppedInstance, ...celldOptions } = options;
      void _droppedInstance;
      noite.start(celldOptions);
    },
  };

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the literal implements exactly the surface above, which is the full set the pinned base class touches.
  return wrapped as unknown as SandboxNativeContainer;
};

const denied = (reason: string): Error =>
  new Error(
    `VOID_SANDBOX_${reason === "concurrency" || reason === "runtime_budget" ? reason : "unavailable"}`
  );

const bounded = async <T>(operation: Promise<T>): Promise<T> => {
  const { promise, reject } = Promise.withResolvers<never>();

  const timeout = setTimeout(
    () => reject(denied("unavailable")),
    CONTROL_TIMEOUT_MS
  );

  try {
    return await Promise.race([operation, promise]);
  } finally {
    clearTimeout(timeout);
  }
};

const settleStart = (): void => {
  // The tail only sequences; each waiter already owns its own outcome.
};

/** Platform-owned lifecycle; no application code is loaded in this Worker. */
export class SandboxController extends SandboxContainer<ControllerEnv> {
  #finishing: Promise<void> | undefined;
  #activity: Activity | undefined;
  #activityReady: Promise<void> | undefined;
  #busy = 0;
  #generation: ProcessCompletion = {};
  #startTail: Promise<void> = Promise.resolve();

  /** Noite: strip the Cloudflare-only `instance` start arg (see `wrapCelldContainer`). */
  protected override get container(): SandboxNativeContainer {
    return wrapCelldContainer(super.container);
  }

  protected override processContext(
    exitCode: Promise<number>
  ): ProcessCompletion {
    const generation = this.#generation;
    const completion: ProcessCompletion = {};

    const capture = (): void => {
      completion.failure = generation.failure;
    };

    // oxlint-disable-next-line promise/prefer-await-to-then -- a completion listener, not a wait: the context must return while the process runs.
    void exitCode.then(capture, capture);

    return completion;
  }

  async #loadActivity(): Promise<void> {
    this.#activityReady ??= (async () => {
      this.#activity = await this.ctx.storage.get<Activity>(ACTIVITY_KEY);
    })();
    await this.#activityReady;
  }

  async #touch(): Promise<void> {
    await this.#loadActivity();
    const lastActivity = Date.now();
    this.#activity = {
      idleDeadline: lastActivity + this.inactivityTimeoutMs,
      lastActivity,
    };
    await this.ctx.storage.put(ACTIVITY_KEY, this.#activity);
  }

  async #active(): Promise<() => Promise<void>> {
    this.#busy += 1;

    try {
      await this.#touch();
    } catch (error) {
      this.#busy -= 1;
      throw error;
    }

    let finished = false;

    return async () => {
      if (finished) {
        return;
      }

      finished = true;

      try {
        if (this.container.running) {
          await this.#touch();
        }
      } finally {
        this.#busy -= 1;
      }
    };
  }

  override async configure(options: SandboxOptions): Promise<void> {
    await super.configure(options);
    await this.#loadActivity();

    if (this.#activity !== undefined) {
      this.#activity = {
        ...this.#activity,
        idleDeadline: this.#activity.lastActivity + this.inactivityTimeoutMs,
      };
      await this.ctx.storage.put(ACTIVITY_KEY, this.#activity);
    }
  }

  protected override async waitForProcessExit(
    exitCode: Promise<number>,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the base signature carries the `processContext` value opaquely; narrowed below.
    context?: unknown
  ): Promise<number> {
    const finish = await this.#active();

    // SAFETY: `context` is the `ProcessCompletion` our own `processContext`
    // minted for this process (or undefined when the base never made one);
    // nothing else flows through this parameter.
    const completion = context as ProcessCompletion | undefined;

    try {
      try {
        const code = await exitCode;

        if (completion?.failure !== undefined) {
          throw completion.failure;
        }

        return code;
      } catch (error) {
        throw completion?.failure ?? error;
      }
    } finally {
      await finish();
    }
  }

  #readable(
    stream: ReadableStream,
    finish?: () => Promise<void>
  ): ReadableStream {
    const reader = stream.getReader();

    return new ReadableStream(
      {
        cancel: async (reason) => {
          try {
            await reader.cancel(reason);
          } finally {
            if (finish !== undefined) {
              await finish();
            }
          }
        },
        pull: async (controller) => {
          try {
            const chunk = await reader.read();

            if (chunk.done) {
              controller.close();

              await finish?.();
            } else {
              // Workers RPC eagerly pumps transferred streams, even if the
              // application never reads them. A pending transport read must
              // not keep an unattended background process alive forever.
              if (finish === undefined) {
                await this.#touch();
              }

              controller.enqueue(chunk.value);
            }
          } catch (error) {
            controller.error(error);

            await finish?.();
          }
        },
      },
      { highWaterMark: 0 }
    );
  }

  #writable(stream: WritableStream): WritableStream {
    const writer = stream.getWriter();

    const run = async (operation: () => Promise<void>): Promise<void> => {
      const finish = await this.#active();

      try {
        await operation();
      } finally {
        await finish();
      }
    };

    return new WritableStream({
      abort: (reason) => run(() => writer.abort(reason)),
      close: () => run(() => writer.close()),
      write: (chunk) => run(() => writer.write(chunk)),
    });
  }

  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the base `invoke` contract resolves per-operation shapes (`Response`, process wire, boolean, void); callers narrow by operation.
  override async invoke(operation: string, args: unknown[]): Promise<unknown> {
    if (
      operation !== "exec" &&
      operation !== "files" &&
      operation !== "fetch"
    ) {
      return super.invoke(operation, args);
    }

    const finish = await this.#active();
    let streaming = false;

    try {
      const result = await super.invoke(operation, args);

      if (result instanceof Response && result.body !== null) {
        streaming = true;

        return new Response(this.#readable(result.body, finish), result);
      }

      if (operation === "exec") {
        // SAFETY: the base `invoke` resolves the exec branch to the process
        // wire; the stdio members below are that wire's contract.
        const process = result as Pick<
          SandboxProcessWire,
          "stderr" | "stdin" | "stdout"
        >;

        if (process.stdout !== null) {
          process.stdout = this.#readable(process.stdout);
        }

        if (process.stderr !== null) {
          process.stderr = this.#readable(process.stderr);
        }

        if (process.stdin !== null) {
          process.stdin = this.#writable(process.stdin);
        }
      }

      return result;
    } finally {
      if (!streaming) {
        await finish();
      }
    }
  }

  /**
   * Noite: direct port fetches (and the WebSocket upgrade path, which must
   * travel through DO `fetch` since RPC cannot serialize sockets) refresh the
   * idle deadline exactly like `invoke` does.
   */
  override async fetch(request: Request): Promise<Response> {
    const finish = await this.#active();

    try {
      return await super.fetch(request);
    } finally {
      await finish();
    }
  }

  /**
   * Noite: `signal` flows straight to the native exec (celld 0010/0015:
   * abort sends SIGKILL through the exec kill path, and an already-aborted
   * signal refuses with its reason before spawning — workerd semantics).
   * `pty` flows straight too (celld 0006): the wire `isPty` reads the
   * native value and `resize` is the native resize, so a terminal session
   * just works.
   *
   * Noite: direct exec is tenant-reachable, so it heartbeats exactly like an
   * `invoke` op — a denied lease cannot be outlived past one interval. The
   * guard runs on every call: the options come from the caller, so an
   * `{ aborted: true }` look-alike must not skip admission. Setup-time
   * execs run under the setup's own admission verdicts (see `#guardExec`).
   */
  protected override async execProcess(
    argv: string[],
    options: SandboxExecOptions = {}
  ): Promise<BaseExecProcess> {
    await this.#guardExec();

    return this.container.exec(argv, { ...options });
  }

  /**
   * Noite: heartbeat gate for direct `execProcess` (and thereby
   * `initializationOutput` and `initialize`). Execs inside a setup — an
   * `ensureRunning` setup (`starting`) or a direct `setup` (lease pending)
   * — skip: the setup's own `beforeStart`/`started`/`beforeUse` verdicts own
   * admission there, and a pending lease would deny. Anything else runs
   * `beforeUse`, which fails closed without a running lease and destroys on
   * a denied heartbeat, exactly like `invoke`.
   */
  async #guardExec(): Promise<void> {
    if (this.starting) {
      return;
    }

    const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);

    if (lease?.phase === "pending") {
      return;
    }

    await this.beforeUse();
  }

  /**
   * Noite: after the base workspace setup, prove the image carries the sandbox
   * shim `@cloudflare/sandbox` shells out to, and fail closed with the
   * contract when it does not. Only `sh` is assumed (the base setup already
   * needs it).
   */
  protected override async initialize(): Promise<void> {
    await super.initialize();

    const probe = await this.initializationOutput(
      ["sh", "-c", `test -x ${SHIM_PATH}`],
      {},
      SHIM_PROBE_TIMEOUT_MS
    );

    if (probe.exitCode !== 0) {
      throw new Error(
        `Sandbox image is missing ${SHIM_PATH}, which file operations need. ` +
          "Base the image on a shim-carrying image (FROM it, or COPY --from " +
          "docker.io/cloudflare/sandbox:1.0.3 " +
          `${SHIM_PATH} ${SHIM_PATH}).`
      );
    }
  }

  #admission(): Control {
    // A secret name, not a fixed one: celld derives a named id from the
    // name alone, so a guessable name would give the admission cell a
    // public address. Missing or short fails closed.
    const name = this.env.__VOID_SANDBOX_ADMISSION_NAME ?? "";

    if (name.length < MIN_ADMISSION_NAME_LENGTH) {
      throw denied("unavailable");
    }

    return this.env.__VOID_SANDBOX_ADMISSION.getByName(name);
  }

  async #arm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  async #control(
    method: "reserve" | "started" | "heartbeat",
    lease: Lease
  ): Promise<void> {
    const result = await bounded(
      this.#admission()[method](this.ctx.id.toString(), lease.generation)
    );

    if (!result.ok) {
      throw denied(result.reason);
    }
  }

  /**
   * Noite: serialize the lease-reserve sequence per cell. The `invoke` path
   * already funnels through one `#setup`, but direct `beforeStart` calls
   * would interleave: two starts could both mint generations, race at
   * `reserve`, and leave the winner's admission entry with no controller
   * lease to ever stop it. Queued, a second start cleanly supersedes the
   * first (`stopped` releases its reservation before the new one mints).
   */
  #serializeStart<T>(operation: () => Promise<T>): Promise<T> {
    // oxlint-disable-next-line promise/prefer-await-to-then -- the queue links continuations; awaiting here would serialize the caller instead of the work.
    const result = this.#startTail.then(operation);
    // oxlint-disable-next-line promise/prefer-await-to-then -- see above: the tail must advance without blocking this call.
    this.#startTail = result.then(settleStart, settleStart);

    return result;
  }

  protected override async beforeStart(): Promise<void> {
    return await this.#serializeStart(async () => {
      // Noite: no `instanceType` assignment — celld sizes from config, and the
      // `container` wrapper strips the `instance` start arg.
      let lease = await this.ctx.storage.get<Lease>(LEASE_KEY);

      if (lease?.phase === "running" && this.container.running) {
        await this.#control("heartbeat", lease);
        await this.#arm();

        return;
      }

      if (lease !== undefined) {
        if (this.container.running) {
          await this.container.destroy();
        }

        await this.stopped();
      }

      // A container with no durable admission record must never be adopted.
      if (this.container.running) {
        await this.container.destroy();
      }

      this.#generation = {};
      lease = { generation: crypto.randomUUID(), phase: "pending" };
      await this.ctx.storage.put(LEASE_KEY, lease);
      await this.#arm();
      await this.#control("reserve", lease);
    });
  }

  protected override async afterStart(): Promise<void> {
    const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);

    if (
      lease === undefined ||
      lease.phase === "stopped" ||
      !this.container.running
    ) {
      throw denied("unavailable");
    }

    if (lease.phase === "pending") {
      await this.#control("started", lease);
      await this.ctx.storage.put(LEASE_KEY, {
        ...lease,
        phase: "running",
      } satisfies Lease);
      await this.#touch();
    }

    await this.#arm();
  }

  protected override async beforeUse(): Promise<void> {
    const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);

    if (lease === undefined || lease.phase !== "running") {
      throw denied("unavailable");
    }

    try {
      await this.#control("heartbeat", lease);
    } catch (error) {
      this.#generation.failure =
        error instanceof Error ? error : denied("unavailable");

      try {
        await this.destroy();
      } catch {
        // Best effort: the heartbeat failure below is what the caller sees.
      }

      throw error;
    }
  }

  protected override async stopped(): Promise<void> {
    if (this.#finishing !== undefined) {
      return this.#finishing;
    }

    const pending = (async () => {
      if (this.container.running) {
        return;
      }

      const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);

      if (lease === undefined) {
        return;
      }

      await this.ctx.storage.put(LEASE_KEY, {
        ...lease,
        phase: "stopped",
      } satisfies Lease);
      await this.#arm();
      await bounded(
        this.#admission().stopped(this.ctx.id.toString(), lease.generation)
      );
      await this.ctx.storage.delete(LEASE_KEY);
      await this.ctx.storage.delete(ACTIVITY_KEY);
      this.#activity = undefined;
      await this.ctx.storage.deleteAlarm();
    })();

    this.#finishing = pending;

    try {
      await pending;
    } finally {
      if (this.#finishing === pending) {
        this.#finishing = undefined;
      }
    }
  }

  override async alarm(): Promise<void> {
    try {
      const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);

      if (lease === undefined) {
        return;
      }

      if (lease.phase === "running" && this.container.running) {
        await this.#loadActivity();

        if (this.#activity === undefined) {
          await this.#touch();
        }

        // SAFETY: `#touch` above assigns `#activity` before its first await
        // resolves, so a successful return guarantees it is set.
        const activity = this.#activity as Activity;

        if (this.#busy === 0 && Date.now() >= activity.idleDeadline) {
          await this.destroy();

          return;
        }

        await this.#control("heartbeat", lease);
      } else if (lease.phase !== "pending" || !this.starting) {
        await this.destroy();
      }
    } catch (error) {
      this.#generation.failure =
        error instanceof Error ? error : denied("unavailable");

      try {
        await this.destroy();
      } catch {
        // Best effort: the alarm already records the original failure.
      }

      console.error("[void/sandbox] lifecycle check failed", error);
    } finally {
      if ((await this.ctx.storage.get(LEASE_KEY)) !== undefined) {
        await this.#arm();
      }
    }
  }
}
