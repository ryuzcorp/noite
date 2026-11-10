/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion, unicorn/prefer-add-event-listener -- the worker double receives message events and is keyed by their `type`, which is the DOM's own shape */
import { beforeEach, describe, expect, mock, test } from "bun:test";

/** One worker the client created, as the test drives it. */
interface FakeWorker {
  answer: (id: number, value: unknown) => void;
  fail: (message: string) => void;
  /** The next request of `kind` the client sends, waiting for one if none has
   * arrived yet: the client's restart is async, so a test waits on the
   * request rather than on a clock. */
  next: (kind: string) => Promise<{ id: number }>;
  readonly posted: { id: number; kind: string }[];
  readonly terminated: boolean;
}

const workers: FakeWorker[] = [];

/** The client's worker, as a double: it answers `sync` on its own (the
 * snapshot always installs) and holds every other request until the test
 * answers it. */
const fakeWorker = (): FakeWorker => {
  const posted: { id: number; kind: string }[] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();

  const waiting: {
    kind: string;
    resolve: (request: { id: number }) => void;
  }[] = [];

  let terminated = false;

  const emit = (type: string, event: unknown): void => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
    }
  };

  const worker = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    postMessage: (message: { id: number; kind: string }) => {
      posted.push(message);

      for (const [index, entry] of waiting.entries()) {
        if (entry.kind === message.kind) {
          waiting.splice(index, 1);
          entry.resolve(message);

          break;
        }
      }

      queueMicrotask(() => {
        if (message.kind === "sync") {
          emit("message", {
            data: { id: message.id, ok: true, value: undefined },
          });
        }
      });
    },
    terminate: () => {
      terminated = true;
    },
  };

  const double: FakeWorker = {
    answer: (id, value) => {
      emit("message", { data: { id, ok: true, value } });
    },
    fail: (message) => {
      emit("error", { message });
    },
    next: (kind) => {
      const seen = posted.find((request) => request.kind === kind);

      if (seen !== undefined) {
        return Promise.resolve(seen);
      }

      const { promise, resolve } = Promise.withResolvers<{ id: number }>();
      waiting.push({ kind, resolve });

      return promise;
    },
    get posted() {
      return posted;
    },
    get terminated() {
      return terminated;
    },
  };

  workers.push(double);

  /* oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the double implements the worker surface the client uses; the client's own `Worker` type cannot be described by a test double. */
  return worker as unknown as FakeWorker;
};

mock.module("./ts-worker-client", () => ({
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the double is the worker surface the client uses, and there is no narrower type to name here.
  createIntelWorker: () => fakeWorker() as unknown as Worker,
}));

const { SourceIntel } = await import("./intel");
const { Intel } = await import("./intel");

const bundle = () =>
  Promise.resolve({
    files: [],
    nodeModules: [],
    projectFiles: [],
    types: [],
    versions: {},
  } as never);

const opened = async () => {
  const intel = new SourceIntel();
  await intel.sync(bundle, []);

  return intel;
};

beforeEach(() => {
  workers.splice(0);
});

describe("SourceIntel's worker generation", () => {
  test("a request answers once the worker is ready", async () => {
    const intel = await opened();
    expect(intel.state()).toEqual(Intel.Ready());
    expect(workers).toHaveLength(1);
  });

  test("a dead worker is restarted by the next request", async () => {
    const intel = await opened();
    const [first] = workers;

    first?.fail("the worker crashed");
    expect(intel.state()).toEqual(
      Intel.Broken({ message: "the worker crashed" })
    );

    // Before the restart: the client kept the dead worker, so every request
    // answered null and no second worker was ever built.
    const found = intel.diagnostics("src/a.ts", "const a = 1\n");
    expect(workers).toHaveLength(2);
    const [, second] = workers;
    const ask = await second?.next("diagnostics");
    const { id } = ask ?? { id: 0 };
    second?.answer(id, []);

    expect(await found).toEqual([]);
    expect(intel.state()).toEqual(Intel.Ready());
    expect(first?.terminated).toBe(true);
  });

  test("policy failures come back as empty results, never as throws", async () => {
    const intel = await opened();
    workers[0]?.fail("boom");
    const hover = intel.quickInfo("src/a.ts", "a", 0);
    const [, second] = workers;
    const ask = await second?.next("quickInfo");
    const { id } = ask ?? { id: 0 };
    second?.answer(id, { docs: [], signature: "a: number" });

    expect(await hover).toEqual({ docs: [], signature: "a: number" });
  });
});
