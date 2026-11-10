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

import type {
  Activity,
  ActivityDecision,
  ActivityEvent,
  ActivityRecord,
} from "./activity.ts";
import { decodeActivity, stepActivity } from "./activity.ts";
import type { AdmissionResult } from "./admission.ts";
import { MIN_ADMISSION_NAME_LENGTH } from "./admission.ts";
import type { WriteState } from "./bridge.ts";
import { closeWrite, StreamBridge } from "./bridge.ts";
import type { ControllerEnv } from "./env.ts";
import type {
  AdmissionMethod,
  Lease,
  LeaseDecision,
  LeaseEffect,
  LeaseFacts,
} from "./lease.ts";
import { decodeLease, encodeLease, stepLease } from "./lease.ts";

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

const LEASE_KEY = "__voidSandboxLease";
const ACTIVITY_KEY = "__voidSandboxActivity";

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

const settleTail = (): void => {
  // The tail only sequences; each waiter already owns its own outcome.
};

/** Platform-owned lifecycle; no application code is loaded in this Worker. */
export class SandboxController extends SandboxContainer<ControllerEnv> {
  #finishing: Promise<void> | undefined;
  #activity: Activity = { _tag: "Absent" };
  #activityLoaded = false;
  #activityTail: Promise<void> = Promise.resolve();
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

  /**
   * Serialize every activity read/mutation. The alarm's reap decision and a
   * request's `Begin` are ordered by this queue, so a request can never land
   * between the idle check and the teardown.
   */
  #serializeActivity<T>(operation: () => Promise<T>): Promise<T> {
    // oxlint-disable-next-line promise/prefer-await-to-then -- the queue links continuations; awaiting here would serialize the caller instead of the work.
    const result = this.#activityTail.then(operation);
    // oxlint-disable-next-line promise/prefer-await-to-then -- see above: the tail must advance without blocking this call.
    this.#activityTail = result.then(settleTail, settleTail);

    return result;
  }

  async #loadActivity(): Promise<void> {
    if (this.#activityLoaded) {
      return;
    }

    this.#activity = decodeActivity(
      await this.ctx.storage.get<ActivityRecord>(ACTIVITY_KEY)
    );
    this.#activityLoaded = true;
  }

  /** One serialized transition; the record write rides along inside the lock. */
  async #activityStep(event: ActivityEvent): Promise<ActivityDecision> {
    return await this.#serializeActivity(async () => {
      await this.#loadActivity();

      const decision = stepActivity(this.#activity, event);

      if (decision._tag === "Refused") {
        return decision;
      }

      this.#activity = decision.activity;

      if (decision.persist !== undefined) {
        await this.ctx.storage.put(ACTIVITY_KEY, decision.persist);
      }

      return decision;
    });
  }

  async #touch(): Promise<void> {
    const at = Date.now();

    await this.#activityStep({
      _tag: "Touch",
      at,
      timeoutMs: this.inactivityTimeoutMs,
    });
  }

  /** Teardown clears the idle record and the reap lock (the key is deleted too). */
  async #resetActivity(): Promise<void> {
    await this.#serializeActivity(async () => {
      this.#activity = { _tag: "Absent" };
      this.#activityLoaded = true;
      await this.ctx.storage.delete(ACTIVITY_KEY);
    });
  }

  async #active(): Promise<() => Promise<void>> {
    const at = Date.now();

    const decision = await this.#activityStep({
      _tag: "Begin",
      at,
      timeoutMs: this.inactivityTimeoutMs,
    });

    if (decision._tag === "Refused") {
      // The alarm is reaping this cell: refuse before touching the container.
      throw denied("unavailable");
    }

    let finished = false;

    return async () => {
      if (finished) {
        return;
      }

      finished = true;

      await this.#activityStep({
        _tag: "End",
        at: Date.now(),
        running: this.container.running,
        timeoutMs: this.inactivityTimeoutMs,
      });
    };
  }

  override async configure(options: SandboxOptions): Promise<void> {
    await super.configure(options);
    await this.#activityStep({
      _tag: "Configure",
      timeoutMs: this.inactivityTimeoutMs,
    });
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

  #readable(stream: ReadableStream, bridge?: StreamBridge): ReadableStream {
    const reader = stream.getReader();

    return new ReadableStream(
      {
        cancel: async (reason) => {
          try {
            await reader.cancel(reason);
          } finally {
            await bridge?.close("cancel");
          }
        },
        pull: async (controller) => {
          try {
            const chunk = await reader.read();

            if (chunk.done) {
              controller.close();

              await bridge?.close("done");
            } else {
              // Workers RPC eagerly pumps transferred streams, even if the
              // application never reads them. A pending transport read must
              // not keep an unattended background process alive forever.
              if (bridge === undefined) {
                await this.#touch();
              }

              controller.enqueue(chunk.value);
            }
          } catch (error) {
            controller.error(error);

            await bridge?.close("error");
          }
        },
      },
      { highWaterMark: 0 }
    );
  }

  #writable(stream: WritableStream): WritableStream {
    const writer = stream.getWriter();
    let state: WriteState = { _tag: "Open" };

    const run = async (operation: () => Promise<void>): Promise<void> => {
      const finish = await this.#active();

      try {
        await operation();
      } finally {
        await finish();
      }
    };

    const terminal = async (operation: () => Promise<void>): Promise<void> => {
      if (state._tag === "Closed") {
        return;
      }

      state = closeWrite(state);
      await run(operation);
    };

    return new WritableStream({
      abort: (reason) => terminal(() => writer.abort(reason)),
      close: () => terminal(() => writer.close()),
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

        return new Response(
          this.#readable(result.body, new StreamBridge(finish)),
          result
        );
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

    // A direct `execProcess` (tenant RPC) never goes through
    // `waitForProcessExit`, so it must enter the activity machine itself:
    // `Begin` refuses a cell the alarm is reaping, and the exit settles the
    // count even when nothing waits on the process.
    const finish = await this.#active();

    try {
      const process = await this.container.exec(argv, { ...options });

      // oxlint-disable-next-line promise/prefer-await-to-then -- a lifetime listener, not a wait: the spawn must return while the process runs.
      void process.exitCode.then(finish, finish);

      return process;
    } catch (error) {
      await finish();

      throw error;
    }
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

    const lease = await this.#readLease();

    if (lease._tag === "Pending") {
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

  async #readLease(): Promise<Lease> {
    return decodeLease(await this.ctx.storage.get(LEASE_KEY));
  }

  #facts(): LeaseFacts {
    return {
      container: this.container.running ? "running" : "stopped",
      starting: this.starting,
    };
  }

  async #control(method: AdmissionMethod, generation: string): Promise<void> {
    const result = await bounded(
      this.#admission()[method](this.ctx.id.toString(), generation)
    );

    if (!result.ok) {
      throw denied(result.reason);
    }
  }

  async #saveLease(lease: Lease): Promise<void> {
    const stored = encodeLease(lease);

    if (stored === null) {
      await this.ctx.storage.delete(LEASE_KEY);

      return;
    }

    await this.ctx.storage.put(LEASE_KEY, stored);
  }

  /**
   * Compare-and-clear: a release computed from an older snapshot must never
   * delete a newer lease (that would orphan the newer admission row).
   */
  async #clearLease(generation: string): Promise<void> {
    const lease = await this.#readLease();

    if (lease._tag === "Absent" || lease.generation !== generation) {
      return;
    }

    await this.ctx.storage.delete(LEASE_KEY);
    await this.#resetActivity();
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * Compare-and-set `pending` → `running`. `afterStart` runs outside the lease
   * lock, so a supersede or a stop must win over this write.
   */
  async #markRunning(generation: string): Promise<void> {
    const lease = await this.#readLease();

    if (lease._tag !== "Pending" || lease.generation !== generation) {
      return;
    }

    await this.#saveLease({ _tag: "Running", generation });
  }

  /** Compare-and-set the durable stop mark, for the same reason. */
  async #markStopping(generation: string): Promise<void> {
    const lease = await this.#readLease();

    if (lease._tag === "Absent" || lease.generation !== generation) {
      return;
    }

    await this.#saveLease({ _tag: "Stopping", generation });
  }

  /** Run a lease transition's effects in order; a failure leaves the durable state as the recovery point. */
  async #applyEffect(effect: LeaseEffect): Promise<void> {
    if (effect._tag === "Kill") {
      await this.container.destroy();

      return;
    }

    if (effect._tag === "Destroy") {
      await this.destroy();

      return;
    }

    if (effect._tag === "Admit") {
      await this.#control(effect.method, effect.generation);

      return;
    }

    if (effect._tag === "Persist") {
      await this.#saveLease(effect.lease);

      return;
    }

    if (effect._tag === "MarkStopping") {
      await this.#markStopping(effect.generation);

      return;
    }

    if (effect._tag === "MarkRunning") {
      await this.#markRunning(effect.generation);

      return;
    }

    if (effect._tag === "ReleaseAdmission") {
      await bounded(
        this.#admission().stopped(this.ctx.id.toString(), effect.generation)
      );

      return;
    }

    if (effect._tag === "Clear") {
      await this.#clearLease(effect.generation);

      return;
    }

    if (effect._tag === "ReleaseNow") {
      await this.stopped();

      return;
    }

    if (effect._tag === "Arm") {
      await this.#arm();

      return;
    }

    await this.#touch();
  }

  async #runLease(decision: LeaseDecision): Promise<void> {
    for (const effect of decision.effects) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- effects are ordered: persist before admit, release before clear.
      await this.#applyEffect(effect);
    }
  }

  /**
   * Noite: serialize every lease mutation per cell. The `invoke` path already
   * funnels through one `#setup`, but direct `beforeStart` calls would
   * interleave: two starts could both mint generations, race at `reserve`,
   * and leave the winner's admission entry with no controller lease to ever
   * stop it. The same lock keeps a release from interleaving with a start, so
   * a teardown can never clear a lease a newer start just wrote. Queued, a
   * second start cleanly supersedes the first (`Release` frees its
   * reservation before the new one mints).
   *
   * Not re-entrant: a transition run under this lock must never emit
   * `Destroy` or `ReleaseNow` (both re-enter `stopped()`); only `beforeStart`
   * and `stopped()` take the lock, and neither emits them.
   */
  #serializeLease<T>(operation: () => Promise<T>): Promise<T> {
    // oxlint-disable-next-line promise/prefer-await-to-then -- the queue links continuations; awaiting here would serialize the caller instead of the work.
    const result = this.#startTail.then(operation);
    // oxlint-disable-next-line promise/prefer-await-to-then -- see above: the tail must advance without blocking this call.
    this.#startTail = result.then(settleTail, settleTail);

    return result;
  }

  protected override async beforeStart(): Promise<void> {
    return await this.#serializeLease(async () => {
      // Noite: no `instanceType` assignment — celld sizes from config, and the
      // `container` wrapper strips the `instance` start arg.
      const decision = stepLease(
        await this.#readLease(),
        { _tag: "Start", generation: crypto.randomUUID() },
        this.#facts()
      );

      if (decision._tag === "Next" && decision.lease._tag === "Pending") {
        this.#generation = {};
      }

      await this.#runLease(decision);
    });
  }

  protected override async afterStart(): Promise<void> {
    const decision = stepLease(
      await this.#readLease(),
      { _tag: "Started" },
      this.#facts()
    );

    // A refusal still runs its effects: the container it refuses must not keep
    // running without a durable record to ever stop it.
    await this.#runLease(decision);

    if (decision._tag === "Refused") {
      throw denied("unavailable");
    }
  }

  protected override async beforeUse(): Promise<void> {
    const decision = stepLease(
      await this.#readLease(),
      { _tag: "Use" },
      this.#facts()
    );

    if (decision._tag === "Refused") {
      throw denied("unavailable");
    }

    try {
      await this.#runLease(decision);
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

  /**
   * The base class calls this from `destroy()` after the container is gone.
   * It is the release transition: a stop mark first (so a crash still finds
   * it), the admission receipt, then the keys. It never releases while the
   * container still runs — that would hand a live container's capacity to
   * another cell.
   */
  protected override async stopped(): Promise<void> {
    if (this.#finishing !== undefined) {
      return this.#finishing;
    }

    const pending = this.#serializeLease(async () => {
      const decision = stepLease(
        await this.#readLease(),
        { _tag: "Release" },
        this.#facts()
      );

      if (decision._tag === "Refused") {
        return;
      }

      await this.#runLease(decision);
    });

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
      const lease = await this.#readLease();

      if (lease._tag === "Absent") {
        return;
      }

      if (lease._tag === "Running" && this.container.running) {
        const activity = await this.#activityStep({
          _tag: "Tick",
          now: Date.now(),
          timeoutMs: this.inactivityTimeoutMs,
        });

        if (activity._tag === "Ok" && activity.reap) {
          // The activity lock held only the decision; every later `Begin`
          // sees `Expired` and is refused, so no request races this destroy.
          await this.destroy();

          return;
        }
      }

      await this.#runLease(
        stepLease(lease, { _tag: "Recover" }, this.#facts())
      );
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
      const lease = await this.#readLease();

      if (lease._tag !== "Absent") {
        await this.#arm();
      }
    }
  }
}
