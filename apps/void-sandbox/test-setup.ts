/**
 * Test preload: stubs the `cloudflare:workers` platform module for `bun test`
 * (see package.json `test`: `bun test --preload ./test-setup.ts`).
 *
 * The stub is deliberately method-free — constructor plus `ctx`/`env` fields,
 * like the real base classes — so the tests run the REAL controller classes
 * over the REAL `void/_sandbox-container` base, with only the platform
 * bindings faked. `controller.test.ts` asserts the stub stays method-free so
 * it can never pollute the method-set gate.
 *
 * Never ships: the image build bundles from `worker.ts`, which never imports
 * this file.
 */
/* oxlint-disable eslint/max-classes-per-file -- three stub bases share the mock factory module */
import { mock } from "bun:test";

class StubDurableObject<Env> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

class StubWorkerEntrypoint<Env> {
  protected ctx: ExecutionContext;
  protected env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

// oxlint-disable-next-line typescript/no-extraneous-class -- the mock must provide a constructible `RpcTarget` base.
class StubRpcTarget {}

mock.module("cloudflare:workers", () => ({
  DurableObject: StubDurableObject,
  RpcTarget: StubRpcTarget,
  WorkerEntrypoint: StubWorkerEntrypoint,
}));
