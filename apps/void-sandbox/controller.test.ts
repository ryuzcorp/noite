// Controller: the DO-stub service shape, the tenant-reachable method gate,
// the celld start/exec adaptation, abort→kill, the shim probe, fetch
// activity, and the admission wiring. The classes under test are the real
// bundle classes over the real `void/_sandbox-container` base.
/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- tests narrow unknown RPC results and reach white-box seams; every cast is asserted immediately. */
import { describe, expect, test } from "bun:test";

import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_SANDBOX_INACTIVITY_TIMEOUT_MS,
  SANDBOX_PORT_HEADER,
  SandboxContainer,
} from "void/_sandbox-container";
import type {
  SandboxOptions,
  SandboxProcessWire,
} from "void/_sandbox-container";

import { SandboxController } from "./src/controller.ts";
import {
  FakeAdmission,
  FakeContainer,
  FakeNamespace,
  FakeProcess,
  FakeSandboxStub,
  FakeStorage,
  makeControllerEnv,
  makeCtx,
  makeService,
  succeedExec,
} from "./test-helpers.ts";

interface PrototypeChain {
  readonly accessors: string[];
  readonly methods: string[];
}

/**
 * Prototype-chain methods (RPC-reachable via `inst[method]`) and accessors,
 * base classes included. Private (`#`) members never appear here, matching
 * the dispatcher.
 */
const chain = (ctor: { readonly prototype: object }): PrototypeChain => {
  const methods = new Set<string>();
  const accessors = new Set<string>();
  let proto: object | null = ctor.prototype;

  while (proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(proto, name);

      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- prototype introspection for the method gate, not input parsing.
      if (typeof descriptor?.value === "function") {
        methods.add(name);
      } else if (descriptor?.get ?? descriptor?.set) {
        accessors.add(name);
      }
    }

    proto = Object.getPrototypeOf(proto) as object | null;
  }

  return {
    accessors: [...accessors].toSorted(),
    methods: [...methods].toSorted(),
  };
};

describe("tenant-reachable method gate", () => {
  test("the platform stub base contributes no methods", () => {
    expect(chain(DurableObject)).toEqual({ accessors: [], methods: [] });
  });

  test("SandboxController extends the real void base", () => {
    expect(Object.getPrototypeOf(SandboxController)).toBe(SandboxContainer);
  });

  test("exact RPC-callable method set (fail on any new method)", () => {
    // Under the DO-stub shape every prototype-chain method is tenant-
    // reachable, including `protected` ones (runtime-visible) and anything a
    // void bump adds. If this fails, review the new method for tenant-safety
    // before updating the list — never just append.
    //
    // Reviewed 2026-11-03 against void 1.5.0: `configure`/`destroy`/`fetch`
    // are client-invokable by design; `execProcess` can only exec on a running
    // container the tenant could `invoke('exec')` on anyway (equivalent power,
    // no escalation); the lifecycle warts (`beforeStart`/`afterStart`/
    // `ensureRunning`/`initialize`/`setup`/`alarm`, plus the
    // `waitForProcessExit`/`processContext`/`initializationOutput` plumbing)
    // are idempotent and
    // bounded by admission — self-inflicted at worst. Note `setup` is
    // TypeScript-`private` but runtime-visible, which is why this gate walks
    // the real prototype chain instead of trusting types.
    expect(chain(SandboxController).methods).toEqual([
      "afterStart",
      "alarm",
      "beforeStart",
      "beforeUse",
      "configure",
      "destroy",
      "ensureRunning",
      "execProcess",
      "fetch",
      "initializationOutput",
      "initialize",
      "invoke",
      "processContext",
      "setup",
      "stopped",
      "waitForProcessExit",
    ]);
  });

  test("exact accessor set (a function-valued getter would be reachable too)", () => {
    expect(chain(SandboxController).accessors).toEqual([
      "container",
      "entrypoint",
      "image",
      "inactivityTimeoutMs",
    ]);
  });
});

describe("getSandbox", () => {
  test("returns the cell stub itself after configuring it", async () => {
    const stub = new FakeSandboxStub();
    const namespace = new FakeNamespace(() => stub);
    const service = makeService(makeControllerEnv({ sandbox: namespace }));

    const returned = await service.getSandbox("cell-1", {
      enableInternet: true,
    });

    expect(returned as unknown).toBe(stub as unknown);
    expect(stub.configured).toEqual([{ enableInternet: true }]);
    expect(namespace.instances.get("cell-1")).toBe(stub);
  });

  test("options default to an empty object", async () => {
    const stub = new FakeSandboxStub();

    const service = makeService(
      makeControllerEnv({ sandbox: new FakeNamespace(() => stub) })
    );

    await service.getSandbox("cell-1");
    expect(stub.configured).toEqual([{}]);
  });

  test("id bounds reject with Void's message", async () => {
    const service = makeService(makeControllerEnv());

    await Promise.all(
      ["", "x".repeat(64)].map(async (id) => {
        await expect(service.getSandbox(id)).rejects.toThrow(TypeError);
        await expect(service.getSandbox(id)).rejects.toThrow(
          "Sandbox id must contain between 1 and 63 characters."
        );
      })
    );

    await expect(service.getSandbox("x".repeat(63))).resolves.toBeDefined();
  });

  test("bad options reject with void's validation", async () => {
    const service = makeService(makeControllerEnv());
    await expect(
      service.getSandbox("cell-1", { inactivityTimeoutMs: 0 })
    ).rejects.toThrow(
      "Sandbox inactivityTimeoutMs must be an integer between 1 and 21600000."
    );
    // SAFETY: intentionally invalid input; the runtime must refuse the key.
    const unknownKey = { bogus: 1 } as unknown as SandboxOptions;
    await expect(service.getSandbox("cell-1", unknownKey)).rejects.toThrow(
      "Unsupported Sandbox option: bogus"
    );
  });

  test("service fetch answers 404", async () => {
    const service = makeService(makeControllerEnv());
    const response = await service.fetch();
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });
});

interface Rig {
  readonly admission: FakeAdmission;
  readonly container: FakeContainer;
  readonly controller: SandboxController;
  readonly storage: FakeStorage;
}

const rig = (
  init: {
    admission?: FakeAdmission;
    container?: FakeContainer;
    storage?: FakeStorage;
  } = {}
): Rig => {
  const storage = init.storage ?? new FakeStorage();
  const container = init.container ?? new FakeContainer();
  const admission = init.admission ?? new FakeAdmission();

  const env = makeControllerEnv({
    admission: new FakeNamespace(() => admission),
  });

  const controller = new SandboxController(
    makeCtx({ container, storage }),
    env
  );

  return { admission, container, controller, storage };
};

describe("celld start", () => {
  test("start drops the Cloudflare-only instance arg", async () => {
    const { container, controller } = rig();
    succeedExec(container);
    await controller.invoke("exec", [["echo", "hi"]]);
    expect(container.starts).toHaveLength(1);
    expect(container.starts[0]).toEqual({
      enableInternet: false,
      image: "fake-image:1",
    });
    expect("instance" in (container.starts[0] as object)).toBe(false);
    expect("entrypoint" in (container.starts[0] as object)).toBe(false);
  });

  test("image follows images.default; internet and labels flow through", async () => {
    const { container, controller } = rig();
    container.images = { default: "custom:tag" };
    succeedExec(container);
    await controller.configure({ enableInternet: true, labels: { team: "a" } });
    await controller.invoke("exec", [["echo", "hi"]]);
    expect(container.starts[0]).toEqual({
      enableInternet: true,
      image: "custom:tag",
      labels: { team: "a" },
    });
  });
});

describe("abort maps to kill", () => {
  test("closing the abort carrier kills the process (end to end)", async () => {
    const { container, controller } = rig();
    const seen: FakeProcess[] = [];
    container.execImpl = (argv: string[]): FakeProcess => {
      const process = new FakeProcess();

      // Setup execs settle; the user process stays live until killed.
      if (argv[0] !== "sleep") {
        process.finish(0);
      }

      seen.push(process);

      return process;
    };

    interface AbortLatch {
      close?: () => void;
    }

    const aborter: AbortLatch = {};

    const abort = new ReadableStream({
      start: (c): void => {
        aborter.close = (): void => {
          c.close();
        };
      },
    });

    const wire = (await controller.invoke("exec", [
      ["sleep", "30"],
      { abort },
    ])) as SandboxProcessWire;

    const user = seen.at(-1) as FakeProcess;
    expect(user.kills).toEqual([]);
    expect(wire.isPty).toBe(false);
    // The carrier, not a serialized signal, is what crosses RPC in production.
    aborter.close?.();
    await expect(wire.capability.invoke("exitCode", [])).resolves.toBe(137);
    expect(user.kills).toEqual([undefined]);

    // celld never saw the carrier: only portable options were forwarded.
    const userCall = container.execCalls.find(
      (call) => call.argv[0] === "sleep"
    );

    expect(userCall?.options).toEqual({ cwd: "/workspace" });
  });

  test("an already-aborted signal kills without relying on a listener", async () => {
    const { container, controller } = rig();
    const seen: FakeProcess[] = [];
    container.execImpl = (): FakeProcess => {
      const process = new FakeProcess();
      process.finish(0);
      seen.push(process);

      return process;
    };

    // SAFETY: white-box call into the protected override to pin the
    // already-aborted branch (a listener alone would never fire post-abort).
    const execProcess = controller as unknown as {
      execProcess: (
        argv: string[],
        options: { signal: AbortSignal }
      ) => Promise<{ exitCode: Promise<number> }>;
    };

    const finished = await execProcess.execProcess(["true"], {
      signal: AbortSignal.abort(),
    });

    await expect(finished.exitCode).resolves.toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kills).toEqual([undefined]);
  });

  test("pty never reaches celld and isPty stays false", async () => {
    const { container, controller } = rig();
    succeedExec(container);

    const wire = (await controller.invoke("exec", [
      ["echo", "hi"],
      { pty: { cols: 80, rows: 24 } },
    ])) as SandboxProcessWire;

    expect(wire.isPty).toBe(false);

    const userCall = container.execCalls.find(
      (call) => call.argv[0] === "echo"
    );

    expect(userCall?.options).toEqual({ cwd: "/workspace" });
  });

  test("capability kill reaches the process and settles the exit", async () => {
    const { container, controller } = rig();
    const seen: FakeProcess[] = [];
    container.execImpl = (argv: string[]): FakeProcess => {
      const process = new FakeProcess();

      if (argv[0] !== "sleep") {
        process.finish(0);
      }

      seen.push(process);

      return process;
    };

    const wire = (await controller.invoke("exec", [
      ["sleep", "30"],
    ])) as SandboxProcessWire;

    await wire.capability.invoke("kill", []);
    const user = seen.at(-1) as FakeProcess;
    expect(user.kills).toEqual([undefined]);
    await expect(wire.capability.invoke("exitCode", [])).resolves.toBe(137);
  });
});

describe("shim probe", () => {
  test("a missing shim fails closed with the contract", async () => {
    const { admission, container, controller } = rig();
    container.execImpl = (argv: string[]): FakeProcess => {
      const process = new FakeProcess();
      process.finish(
        argv.join(" ").includes("test -x /usr/local/bin/sandbox-shim") ? 1 : 0
      );

      return process;
    };

    await expect(controller.invoke("exec", [["echo", "hi"]])).rejects.toThrow(
      /missing \/usr\/local\/bin\/sandbox-shim.*COPY --from/u
    );
    // Failed setup tears the container down and frees admission.
    expect(container.destroys).toBe(1);
    expect(admission.calls.some((call) => call.method === "stopped")).toBe(
      true
    );
  });

  test("a present shim lets the op through, probed over sh", async () => {
    const { container, controller } = rig();
    succeedExec(container);

    const wire = (await controller.invoke("exec", [
      ["echo", "hi"],
    ])) as SandboxProcessWire;

    expect(wire.pid).toBe(4242);

    const probe = container.execCalls.find((call) =>
      call.argv.join(" ").includes("test -x /usr/local/bin/sandbox-shim")
    );

    expect(probe?.argv[0]).toBe("sh");
  });
});

describe("fetch", () => {
  test("a valid port delegates and refreshes the idle deadline", async () => {
    const { container, controller, storage } = rig();
    succeedExec(container);

    const response = await controller.fetch(
      new Request("http://sandbox/", {
        headers: { [SANDBOX_PORT_HEADER]: "8080" },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("fake-port");
    expect(container.tcpFetches).toHaveLength(1);
    expect(container.tcpFetches[0]?.port).toBe(8080);

    // The activity wrap touched: idle deadline is lastActivity + timeout.
    const activity = storage.store.get("__voidSandboxActivity") as
      | { idleDeadline: number; lastActivity: number }
      | undefined;

    expect(activity?.idleDeadline).toBe(
      (activity?.lastActivity ?? 0) + DEFAULT_SANDBOX_INACTIVITY_TIMEOUT_MS
    );
  });

  test("invalid ports answer 400 without touching admission", async () => {
    const { admission, controller } = rig();

    const headerCases: Record<string, string>[] = [
      {},
      { [SANDBOX_PORT_HEADER]: "abc" },
      { [SANDBOX_PORT_HEADER]: "99999" },
    ];

    const responses = await Promise.all(
      headerCases.map((headers) =>
        controller.fetch(new Request("http://sandbox/", { headers }))
      )
    );

    for (const response of responses) {
      expect(response.status).toBe(400);
    }

    expect(admission.calls).toEqual([]);
  });
});

describe("admission wiring", () => {
  test("a denied reserve fails the op with Void's concurrency string", async () => {
    const admission = new FakeAdmission();
    admission.reserveResult = { ok: false, reason: "concurrency" };
    const { container, controller } = rig({ admission });
    succeedExec(container);
    await expect(controller.invoke("exec", [["echo", "hi"]])).rejects.toThrow(
      "VOID_SANDBOX_concurrency"
    );
    // The container never started, but the generation is still released.
    expect(container.destroys).toBe(0);
    const reserve = admission.calls.find((c) => c.method === "reserve");
    const stopped = admission.calls.find((c) => c.method === "stopped");
    expect(reserve).toBeDefined();
    expect(stopped?.generation).toBe(reserve?.generation);
  });

  test("a denied heartbeat fails use and destroys", async () => {
    const admission = new FakeAdmission();
    admission.heartbeatResult = { ok: false, reason: "unavailable" };
    const { container, controller } = rig({ admission });
    succeedExec(container);
    await expect(controller.invoke("exec", [["echo", "hi"]])).rejects.toThrow(
      "VOID_SANDBOX_unavailable"
    );
    expect(container.destroys).toBe(1);
    expect(
      admission.calls.filter((c) => c.method === "heartbeat")
    ).toHaveLength(1);
    expect(admission.calls.some((c) => c.method === "stopped")).toBe(true);
  });

  test("destroy pairs stopped with the reserved generation and clears state", async () => {
    const { admission, container, controller, storage } = rig();
    succeedExec(container);
    await controller.invoke("exec", [["echo", "hi"]]);
    await controller.invoke("destroy", []);
    const reserve = admission.calls.find((c) => c.method === "reserve");
    const stopped = admission.calls.find((c) => c.method === "stopped");
    expect(reserve?.generation).toBeDefined();
    expect(reserve?.id).toBe("test-do-id-1");
    expect(stopped?.generation).toBe(reserve?.generation);
    expect(stopped).toMatchObject({ id: "test-do-id-1", method: "stopped" });
    expect(container.destroys).toBe(1);
    expect(storage.store.has("__voidSandboxLease")).toBe(false);
    expect(storage.store.has("__voidSandboxActivity")).toBe(false);
    expect(storage.alarmAt).toBeNull();
  });

  test("running reports without admission", async () => {
    const { admission, container, controller } = rig();
    await expect(controller.invoke("running", [])).resolves.toBe(false);
    expect(admission.calls).toEqual([]);
    container.running = true;
    await expect(controller.invoke("running", [])).resolves.toBe(true);
    expect(admission.calls).toEqual([]);
  });

  test("unknown ops reject like void", async () => {
    const { controller } = rig();
    await expect(controller.invoke("nope", [])).rejects.toThrow(
      "Unsupported Sandbox operation: nope"
    );
  });

  test("a missing container binding fails closed", async () => {
    const admission = new FakeAdmission();

    const env = makeControllerEnv({
      admission: new FakeNamespace(() => admission),
    });

    const controller = new SandboxController(makeCtx(), env);
    await expect(controller.invoke("exec", [["echo", "hi"]])).rejects.toThrow(
      "Sandbox container binding is missing."
    );
    await expect(controller.invoke("running", [])).rejects.toThrow(
      "Sandbox container binding is missing."
    );
  });
});

describe("lease lifecycle", () => {
  // White-box storage keys: the controller's own lease/activity contract (the
  // same strings Void uses); changing them is a deliberate migration.
  test("a running lease with a live container heartbeats instead of re-reserving", async () => {
    const storage = new FakeStorage();
    const container = new FakeContainer();
    container.running = true;
    storage.store.set("__voidSandboxLease", {
      generation: "gen-old",
      phase: "running",
    });
    const { admission, controller } = rig({ container, storage });
    succeedExec(container);
    await controller.invoke("exec", [["echo", "hi"]]);
    expect(container.starts).toEqual([]);
    expect(admission.calls.map((c) => c.method)).toEqual([
      "heartbeat",
      "heartbeat",
    ]);
    expect(admission.calls[0]).toMatchObject({
      generation: "gen-old",
      id: "test-do-id-1",
    });
  });

  test("a stale pending lease is fenced out and replaced", async () => {
    const storage = new FakeStorage();
    const container = new FakeContainer();
    container.running = true;
    storage.store.set("__voidSandboxLease", {
      generation: "gen-stale",
      phase: "pending",
    });
    const { admission, controller } = rig({ container, storage });
    succeedExec(container);
    await controller.invoke("exec", [["echo", "hi"]]);
    expect(container.destroys).toBe(1);
    const stopped = admission.calls.find((c) => c.method === "stopped");
    const reserve = admission.calls.find((c) => c.method === "reserve");
    expect(stopped?.generation).toBe("gen-stale");
    expect(reserve?.generation).not.toBe("gen-stale");
  });

  test("alarm without a lease is silent; a running lease heartbeats and re-arms", async () => {
    const { admission, container, controller, storage } = rig();
    await controller.alarm();
    expect(admission.calls).toEqual([]);
    container.running = true;
    storage.store.set("__voidSandboxLease", {
      generation: "gen-1",
      phase: "running",
    });
    const now = Date.now();
    storage.store.set("__voidSandboxActivity", {
      idleDeadline: now + 60_000,
      lastActivity: now,
    });
    storage.alarmAt = null;
    await controller.alarm();
    expect(admission.calls.map((c) => c.method)).toEqual(["heartbeat"]);
    expect(storage.alarmAt).not.toBeNull();
  });

  test("an idle past-deadline lease reaps the container", async () => {
    const { admission, container, controller, storage } = rig();
    container.running = true;
    storage.store.set("__voidSandboxLease", {
      generation: "gen-1",
      phase: "running",
    });
    storage.store.set("__voidSandboxActivity", {
      idleDeadline: 2,
      lastActivity: 1,
    });
    await controller.alarm();
    expect(container.destroys).toBe(1);
    expect(admission.calls.some((c) => c.method === "stopped")).toBe(true);
    expect(storage.store.has("__voidSandboxLease")).toBe(false);
  });
});
