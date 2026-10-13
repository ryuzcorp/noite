/* eslint-disable max-classes-per-file -- Durable Object test doubles share one harness module */
import { describe, expect, it } from "bun:test";

import type {
  PoderDurableObjectNamespace,
  DurableObjectContext,
} from "../src/durable-objects/namespace.ts";
import { isNumber } from "../src/guards.ts";
import { createPoder } from "../src/index.ts";
import { PoderWebSocket, WebSocketPair } from "../src/websockets.ts";
import { bunDriver, makeProjectDir, makeStateDir } from "./driver.ts";
import * as counterModule from "./fixtures/counter.ts";

interface FetchStub {
  fetch: (request: Request) => Promise<Response>;
}

interface CounterBody {
  n: number;
}

// SAFETY: each probe endpoint returns JSON of the shape the test asserts right after; decoded, not trusted.
const readJson = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

class Sleeper {
  private readonly ctx: DurableObjectContext;

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test double mirrors the DO constructor contract.
  constructor(ctx: DurableObjectContext, _env: Record<string, unknown>) {
    this.ctx = ctx;
  }

  async fetch(): Promise<Response> {
    const stored = await this.ctx.storage.get("n");
    const n = isNumber(stored) ? stored : 0;
    // Real interleave window: without the input gate both callers would read 0.
    await Bun.sleep(50);
    await this.ctx.storage.put("n", n + 1);
    return Response.json({ n: n + 1 });
  }
}

class Calculator {
  // oxlint-disable-next-line eslint/class-methods-use-this, eslint/require-await -- test double mirrors the platform RPC shape.
  async add(a: number, b: number): Promise<number> {
    return a + b;
  }

  // oxlint-disable-next-line eslint/class-methods-use-this, eslint/require-await -- test double mirrors the platform RPC shape.
  async roundtrip(value: {
    at: Date;
    bytes: Uint8Array;
  }): Promise<{ at: Date; bytes: Uint8Array }> {
    return value;
  }

  // oxlint-disable-next-line eslint/class-methods-use-this, eslint/require-await -- test double mirrors the platform fetch shape.
  async fetch(): Promise<Response> {
    return Response.json({ ok: true });
  }
}

class Alarmer {
  private readonly ctx: DurableObjectContext;

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test double mirrors the DO constructor contract.
  constructor(ctx: DurableObjectContext, _env: Record<string, unknown>) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/set") {
      // Real timer: the alarm must fire against the platform clock.
      await this.ctx.storage.setAlarm(Date.now() + 150);
      return Response.json({ set: true });
    }
    const stored = await this.ctx.storage.get("fired");
    return Response.json({ fired: isNumber(stored) ? stored : 0 });
  }

  async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get("fired");
    await this.ctx.storage.put("fired", (isNumber(stored) ? stored : 0) + 1);
  }
}

class StorageProbe {
  private readonly ctx: DurableObjectContext;

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test double mirrors the DO constructor contract.
  constructor(ctx: DurableObjectContext, _env: Record<string, unknown>) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { storage } = this.ctx;
    if (url.pathname === "/kv") {
      await storage.put({ a: 2, b: 1, c: 3 });
      const single = await storage.get("a");
      const batch = await storage.get(["a", "missing"]);
      const listed = await storage.list({ limit: 1, startAfter: "a" });
      const deleted = await storage.delete("c");
      await storage.delete(["a"]);
      const remaining = await storage.list();
      await storage.deleteAll();
      const emptied = await storage.list();
      return Response.json({
        batchKeys: [...batch.keys()],
        deleted,
        emptiedSize: emptied.size,
        listedKeys: [...listed.keys()],
        listedValues: [...listed.values()],
        remainingKeys: [...remaining.keys()],
        single,
      });
    }
    if (url.pathname === "/sql") {
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS k (id INTEGER PRIMARY KEY, v TEXT)"
      );
      storage.sql.exec("INSERT INTO k (v) VALUES (?)", "x");
      const rows = storage.sql.query("SELECT v FROM k");
      return Response.json({ rows });
    }
    if (url.pathname === "/txn") {
      await storage.put("keep", 1);
      try {
        // oxlint-disable-next-line eslint/require-await -- rollback probe throws without awaiting by design.
        await storage.transaction(async (txn) => {
          txn.put("temp", 2);
          throw new Error("boom");
        });
      } catch {
        // Expected: the transaction rolls back.
      }
      const listed = await storage.list();
      const keys = [...listed.keys()].toSorted();
      const synced = storage.transactionSync((txn) => {
        txn.put("sync", 9);
        return txn.get("sync");
      });
      return Response.json({ keys, synced });
    }
    return Response.json({ unknown: true }, { status: 404 });
  }
}

// Container (not a bare `let`): keeps the null check sound across the
// stub-fetch boundary, which a narrowed `let` initializer would poison.
// oxlint-disable-next-line anti-slop/no-known-value-widening -- container keeps the null check sound across the stub-fetch boundary.
const held: { pair: WebSocketPair | null } = { pair: null };

class Echo {
  private readonly ctx: DurableObjectContext;

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test double mirrors the DO constructor contract.
  constructor(ctx: DurableObjectContext, _env: Record<string, unknown>) {
    this.ctx = ctx;
  }

  // oxlint-disable-next-line eslint/require-await -- test double mirrors the platform fetch shape; pairing needs no storage read.
  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].addEventListener("message", (event) => {
      // SAFETY: poder dispatches MessageEvent for socket messages; data carries the payload.
      pair[1].send(`echo:${String((event as MessageEvent).data)}`);
    });
    held.pair = pair;
    return Response.json({ paired: true });
  }
}

const workerModule = { Alarmer, Calculator, Echo, Sleeper, StorageProbe };

const bindings = {
  durableObjects: [
    { binding: "SLEEPER", className: "Sleeper" },
    { binding: "CALC", className: "Calculator" },
    { binding: "ALARMER", className: "Alarmer" },
    { binding: "PROBE", className: "StorageProbe" },
    { binding: "ECHO", className: "Echo" },
  ],
};

// SAFETY: each binding is the namespace registered under it at the test boundary.
const namespaceOf = (
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test boundary: env holds caller-defined bindings.
  env: Record<string, unknown>,
  binding: string
): PoderDurableObjectNamespace => env[binding] as PoderDurableObjectNamespace;

// oxlint-disable-next-line anti-slop/no-unknown-returns -- test helper resolves with the next socket payload; the test asserts its type.
const nextMessage = (socket: PoderWebSocket): Promise<unknown> => {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  socket.addEventListener(
    "message",
    (event) => {
      // SAFETY: poder dispatches MessageEvent for socket messages; the test asserts the payload type.
      resolve((event as MessageEvent).data);
    },
    { once: true }
  );
  return promise;
};

const closed = (socket: PoderWebSocket): Promise<CloseEvent> => {
  const { promise, resolve } = Promise.withResolvers<CloseEvent>();
  socket.addEventListener(
    "close",
    (event) => {
      // SAFETY: poder dispatches CloseEvent for socket close; the test reads code.
      resolve(event as CloseEvent);
    },
    {
      once: true,
    }
  );
  return promise;
};

const takeHeldPair = (): WebSocketPair => {
  // Function boundary: reads `held` at call time so the test's reset
  // assignment cannot narrow the result to null.
  if (held.pair === null) {
    throw new Error("test setup failed: no pair held");
  }
  return held.pair;
};

describe("Durable Objects", () => {
  it("derives deterministic ids and round-trips strings", async () => {
    const stateDir = makeStateDir();
    const options = {
      bindings,
      projectDir: makeProjectDir(),
      sqlite: bunDriver,
      stateDir,
      workerModule,
    };
    const first = await createPoder(options);
    const second = await createPoder(options);
    try {
      const a = namespaceOf(first.env, "SLEEPER");
      const b = namespaceOf(second.env, "SLEEPER");
      expect(a.idFromName("x").toString()).toBe(b.idFromName("x").toString());
      expect(a.idFromName("x").toString()).not.toBe(
        a.idFromName("y").toString()
      );
      const id = a.idFromName("x");
      expect(a.idFromString(id.toString()).equals(id)).toBe(true);
      expect(a.newUniqueId().toString()).not.toBe(a.newUniqueId().toString());
      expect(() => a.idFromString("nope")).toThrow();
      expect(a.jurisdiction("eu")).toBe(a);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it("runs one request at a time per object (no interleaved read-modify-write)", async () => {
    const poder = await createPoder({
      bindings,
      projectDir: makeProjectDir(),
      sqlite: bunDriver,
      stateDir: makeStateDir(),
      workerModule,
    });
    try {
      const ns = namespaceOf(poder.env, "SLEEPER");
      // SAFETY: the Sleeper double exposes fetch; the stub names that slice of the namespace.
      const stub = ns.get(ns.idFromName("one")) as FetchStub;
      const [first, second] = await Promise.all([
        stub.fetch(new Request("https://pod/")),
        stub.fetch(new Request("https://pod/")),
      ]);
      // SAFETY: the counter endpoint returns JSON { n: number }; decoded, not trusted.
      const firstBody = (await first.json()) as CounterBody;
      // SAFETY: the counter endpoint returns JSON { n: number }; decoded, not trusted.
      const secondBody = (await second.json()) as CounterBody;
      const bodies = [firstBody, secondBody];
      expect(bodies.map((body) => body.n).toSorted()).toEqual([1, 2]);
      const read = await stub.fetch(new Request("https://pod/"));
      // SAFETY: the counter endpoint returns JSON { n: number }; decoded, not trusted.
      const readBody = (await read.json()) as CounterBody;
      expect(readBody.n).toBe(3);
    } finally {
      await poder.dispose();
    }
  });

  it("shares one instance between get and getByName", async () => {
    const poder = await createPoder({
      bindings,
      projectDir: makeProjectDir(),
      sqlite: bunDriver,
      stateDir: makeStateDir(),
      workerModule,
    });
    try {
      const ns = namespaceOf(poder.env, "SLEEPER");
      // SAFETY: the Sleeper double exposes fetch; the stub names that slice of the namespace.
      const direct = ns.get(ns.idFromName("shared")) as FetchStub;
      // SAFETY: the Sleeper double exposes fetch; the stub names that slice of the namespace.
      const named = ns.getByName("shared") as FetchStub;
      await direct.fetch(new Request("https://pod/"));
      const seen = await named.fetch(new Request("https://pod/"));
      // SAFETY: the counter endpoint returns JSON { n: number }; decoded, not trusted.
      const seenBody = (await seen.json()) as CounterBody;
      expect(seenBody.n).toBe(2);
    } finally {
      await poder.dispose();
    }
  });

  it("supports storage KV batch ops, list windows and deleteAll", async () => {
    const poder = await createPoder({
      bindings,
      projectDir: makeProjectDir(),
      sqlite: bunDriver,
      stateDir: makeStateDir(),
      workerModule,
    });
    try {
      const ns = namespaceOf(poder.env, "PROBE");
      // SAFETY: the probe double exposes fetch; the stub names that slice of the namespace.
      const stub = ns.get(ns.newUniqueId()) as FetchStub;
      const response = await stub.fetch(new Request("https://pod/kv"));
      const body = await readJson<{
        single: number;
        batchKeys: string[];
        listedKeys: string[];
        listedValues: number[];
        deleted: boolean;
        remainingKeys: string[];
        emptiedSize: number;
      }>(response);
      expect(body.single).toBe(2);
      expect(body.batchKeys).toEqual(["a"]);
      expect(body.listedKeys).toEqual(["b"]);
      expect(body.listedValues).toEqual([1]);
      expect(body.deleted).toBe(true);
      expect(body.remainingKeys).toEqual(["b"]);
      expect(body.emptiedSize).toBe(0);
    } finally {
      await poder.dispose();
    }
  });

  it("supports storage SQL and transaction rollback", async () => {
    const poder = await createPoder({
      bindings,
      projectDir: makeProjectDir(),
      sqlite: bunDriver,
      stateDir: makeStateDir(),
      workerModule,
    });
    try {
      const ns = namespaceOf(poder.env, "PROBE");
      // SAFETY: the probe double exposes fetch; the stub names that slice of the namespace.
      const stub = ns.get(ns.newUniqueId()) as FetchStub;
      const sqlResponse = await stub.fetch(new Request("https://pod/sql"));
      const sql = await readJson<{ rows: { v: string }[] }>(sqlResponse);
      expect(sql.rows).toEqual([{ v: "x" }]);
      const txnResponse = await stub.fetch(new Request("https://pod/txn"));
      const txn = await readJson<{
        keys: string[];
        synced: number;
      }>(txnResponse);
      expect(txn.keys).toEqual(["keep"]);
      expect(txn.synced).toBe(9);
    } finally {
      await poder.dispose();
    }
  });

  it("fires alarms and re-arms them after recreate", async () => {
    const stateDir = makeStateDir();
    const options = {
      bindings,
      projectDir: makeProjectDir(),
      sqlite: bunDriver,
      stateDir,
      workerModule,
    };
    const first = await createPoder(options);
    const ns = namespaceOf(first.env, "ALARMER");
    const id = ns.idFromName("wake");
    // SAFETY: the Alarmer double exposes fetch; the stub names that slice of the namespace.
    const setter = ns.get(id) as FetchStub;
    await setter.fetch(new Request("https://pod/set"));
    await first.dispose();

    const second = await createPoder(options);
    try {
      const namespaces = namespaceOf(second.env, "ALARMER");
      // SAFETY: the Alarmer double exposes fetch; the stub names that slice of the namespace.
      const stub = namespaces.get(
        namespaces.idFromString(id.toString())
      ) as FetchStub;
      let fired = 0;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- poll loop awaits sequentially until the alarm fires or the deadline hits.
        const response = await stub.fetch(new Request("https://pod/"));
        // oxlint-disable-next-line eslint/no-await-in-loop -- poll loop decodes each attempt sequentially by design.
        const body = await readJson<{ fired: number }>(response);
        ({ fired } = body);
        if (fired === 1) {
          break;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- poll loop waits sequentially between attempts.
        await Bun.sleep(50);
      }
      expect(fired).toBe(1);
    } finally {
      await second.dispose();
    }
  });

  it("calls RPC methods with structured-cloned args and results", async () => {
    const poder = await createPoder({
      bindings,
      projectDir: makeProjectDir(),
      sqlite: bunDriver,
      stateDir: makeStateDir(),
      workerModule,
    });
    try {
      const ns = namespaceOf(poder.env, "CALC");
      // SAFETY: the Calculator double exposes these RPC methods; the stub names that slice of the namespace.
      const stub = ns.get(ns.newUniqueId()) as {
        add: (a: number, b: number) => Promise<number>;
        roundtrip: (value: {
          at: Date;
          bytes: Uint8Array;
        }) => Promise<{ at: Date; bytes: Uint8Array }>;
        fetch: (request: Request) => Promise<Response>;
      };
      expect(await stub.add(20, 22)).toBe(42);
      const echoed = await stub.roundtrip({
        at: new Date("2026-01-02T03:04:05.000Z"),
        bytes: new Uint8Array([1, 2, 3]),
      });
      expect(echoed.at).toBeInstanceOf(Date);
      expect(echoed.at.toISOString()).toBe("2026-01-02T03:04:05.000Z");
      expect([...echoed.bytes]).toEqual([1, 2, 3]);
      const response = await stub.fetch(new Request("https://pod/"));
      const ok = await readJson<{ ok: boolean }>(response);
      expect(ok.ok).toBe(true);
    } finally {
      await poder.dispose();
    }
  });

  it("accepts sockets and echoes messages both ways", async () => {
    const pair = new WebSocketPair();
    const serverEvents: string[] = [];
    pair[1].addEventListener("message", (event) => {
      // SAFETY: poder dispatches MessageEvent for socket messages; the test stores the payload.
      serverEvents.push(String((event as MessageEvent).data));
    });
    pair[1].accept();
    pair[0].send("hello");
    const clientEcho = nextMessage(pair[0]);
    pair[1].send("world");
    expect(await nextMessage(pair[1])).toBe("hello");
    expect(await clientEcho).toBe("world");
    const binary = nextMessage(pair[0]);
    pair[1].send(new Uint8Array([1, 2, 3]));
    // SAFETY: the server just sent these bytes; the pair delivers binary as ArrayBuffer.
    const received = (await binary) as ArrayBuffer;
    expect([...new Uint8Array(received)]).toEqual([1, 2, 3]);
    const serverClosed = closed(pair[1]);
    pair[0].close(1000, "bye");
    const event = await serverClosed;
    expect(event.code).toBe(1000);
    expect(pair[0].readyState).toBe(PoderWebSocket.CLOSED);
  });

  it("accepts a socket inside a stub fetch and echoes", async () => {
    held.pair = null;
    const poder = await createPoder({
      bindings,
      projectDir: makeProjectDir(),
      sqlite: bunDriver,
      stateDir: makeStateDir(),
      workerModule,
    });
    try {
      const ns = namespaceOf(poder.env, "ECHO");
      // SAFETY: the Echo double exposes fetch; the stub names that slice of the namespace.
      const stub = ns.get(ns.newUniqueId()) as FetchStub;
      const response = await stub.fetch(new Request("https://pod/"));
      const paired = await readJson<{ paired: boolean }>(response);
      expect(paired.paired).toBe(true);
      // oxlint-disable-next-line eslint/prefer-destructuring -- WebSocketPair is indexable but not iterable; [0] is the only access.
      const client = takeHeldPair()[0];
      const incoming = nextMessage(client);
      client.send("ping");
      expect(await incoming).toBe("echo:ping");
    } finally {
      await poder.dispose();
    }
  });
});

describe("test-app Counter", () => {
  it("increments across requests and persists across instances", async () => {
    const stateDir = makeStateDir();
    const options = {
      bindings: {
        durableObjects: [{ binding: "COUNTER", className: "Counter" }],
      },
      projectDir: makeProjectDir(),
      sqlite: bunDriver,
      stateDir,
      // SAFETY: the fixture module's exports match the worker-module shape createPoder reads at the test boundary.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- test boundary: fixture module narrowed to the worker-module contract.
      workerModule: counterModule as unknown as Record<string, unknown>,
    };
    const first = await createPoder(options);
    const oneResponse = await first.fetch(
      new Request("https://pod/?name=visits")
    );
    const one = await readJson<CounterBody>(oneResponse);
    expect(one.n).toBe(1);
    const twoResponse = await first.fetch(
      new Request("https://pod/?name=visits")
    );
    const two = await readJson<CounterBody>(twoResponse);
    expect(two.n).toBe(2);
    const probeResponse = await first.fetch(
      new Request("https://pod/?name=visits&read=1")
    );
    const probe = await readJson<CounterBody>(probeResponse);
    expect(probe.n).toBe(2);
    await first.dispose();

    const second = await createPoder(options);
    try {
      const threeResponse = await second.fetch(
        new Request("https://pod/?name=visits")
      );
      const three = await readJson<CounterBody>(threeResponse);
      expect(three.n).toBe(3);
    } finally {
      await second.dispose();
    }
  });
});
