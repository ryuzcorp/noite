/* eslint-disable max-classes-per-file -- shim mirrors the cloudflare:workers surface in one module */
// The `cloudflare:workers` shim. `createPoder` wires the live env through
// `globalThis`, so this module works whether it is bundled with the worker
// entry or loaded as a separate file next to it.
export { WebSocketPair } from "./websockets.ts";

interface PoderGlobals {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: live env holds caller-defined bindings.
  __poderEnv?: Record<string, unknown>;
  __poderWaitUntil?: (promise: Promise<unknown>) => void;
}
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: env holds caller-defined bindings.
type PoderEnv = Record<string, unknown>;

// SAFETY: createPoder installs __poderEnv/__poderWaitUntil on globalThis before the shim reads them.
const globals = (): PoderGlobals => globalThis as PoderGlobals;

/** Base class for Durable Object implementations (mirrors `cloudflare:workers`). */
export class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: Cloudflare constructs DOs with (ctx, env).
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  fetch?(_request: Request): Promise<Response>;
  alarm?(): Promise<void>;
}

/** Base class for WorkerEntrypoint implementations. */
export class WorkerEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: Cloudflare constructs entrypoints with (ctx, env).
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  fetch?(_request: Request): Promise<Response>;
}

/** Base class for RPC targets passed across stub calls. */
// oxlint-disable-next-line typescript/no-extraneous-class -- mirrors the cloudflare:workers RpcTarget base class.
export class RpcTarget {}

/** The bound env, live-wired by `createPoder`. */
export const env = new Proxy(
  // SAFETY: the proxy intercepts every trap; the placeholder target is never observed.
  {} as PoderEnv,
  {
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- contract: Proxy get trap returns arbitrary binding values.
    get: (_target, property: string): unknown =>
      globals().__poderEnv?.[property],
    getOwnPropertyDescriptor: (
      _target,
      property: string
    ): PropertyDescriptor | undefined => {
      const current = globals().__poderEnv?.[property];
      if (current === undefined) {
        return undefined;
      }
      return {
        configurable: true,
        enumerable: true,
        value: current,
        writable: true,
      };
    },
    has: (_target, property: string): boolean => {
      const current = globals().__poderEnv;
      return current !== undefined && property in current;
    },
  }
);

/** Extends the request/DO lifetime; collected by `createPoder`, settled on `dispose()`. */
export const waitUntil = (promise: Promise<unknown>): void => {
  globals().__poderWaitUntil?.(promise);
};
