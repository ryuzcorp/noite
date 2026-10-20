/* oxlint-disable anti-slop/no-chained-type-assertions, eslint/max-classes-per-file -- test doubles: a fake EventSource and document stand in for the browser globals connectStream reads */
import { afterEach, describe, expect, test } from "bun:test";

import { connectStream } from "./feeds";
import type { EventSourceStatus, StreamHooks } from "./feeds";

type Listener = (event: { data?: string }) => void;

/** Scripted EventSource stand-in: the test fires open/error/message by hand. */
class FakeSource {
  static instances: FakeSource[] = [];

  static reset(): void {
    FakeSource.instances = [];
  }

  readonly url: string;

  readyState = 0;

  closed = false;

  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: "error" | "message" | "open", data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }

  /** Die like an HTTP error response kills a native source: CLOSED, no retry. */
  fail(): void {
    this.readyState = 2;
    this.emit("error");
  }

  /** Drop the transport while staying reconnectable, like a network blip. */
  blip(): void {
    this.readyState = 0;
    this.emit("error");
  }
}

/** Minimal document: hidden flag plus visibilitychange listeners. */
class FakeDocument {
  hidden = false;

  private listeners = new Map<string, (() => void)[]>();

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((live) => live !== listener)
    );
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;

    for (const listener of this.listeners.get("visibilitychange") ?? []) {
      listener();
    }
  }
}

const realSetTimeout = globalThis.setTimeout;

afterEach(() => {
  FakeSource.reset();
  globalThis.setTimeout = realSetTimeout;
  // SAFETY: bun ships no document; the fake only exists inside a test.
  const testGlobals = globalThis as unknown as { document?: unknown };
  delete testGlobals.document;
});

const sleep = (ms: number): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- the test waits out real reconnect timers, which are the behavior under test
  new Promise<void>((resolve) => {
    realSetTimeout(resolve, ms);
  });

const collect = () => {
  const statuses: EventSourceStatus[] = [];
  const messages: string[] = [];

  const hooks: StreamHooks = {
    onMessage: (data) => {
      messages.push(data);
    },
    onStatus: (status) => {
      statuses.push(status);
    },
  };

  return { hooks, messages, statuses };
};

const connect = (hooks: StreamHooks, document_: FakeDocument): (() => void) => {
  // SAFETY: the fake implements the three document members connectStream reads.
  globalThis.document = document_ as unknown as Document;

  // SAFETY: the fake implements the EventSource surface connectStream uses.
  return connectStream("http://localhost/api/apps/stream", hooks, {
    baseMs: 10,
    capMs: 40,
    random: () => 0,
    source: FakeSource as unknown as typeof EventSource,
  });
};

/** Records the delays the next reconnect schedules: exact, with no
 * wall-clock involved (the schedule happens synchronously inside the error
 * listener). */
const scheduledDelays = (fire: () => void): number[] => {
  const delays: number[] = [];
  // SAFETY: the wrapper records the delay, then delegates to the real timer.
  globalThis.setTimeout = ((handler: () => void, delay?: number) => {
    if (delay !== undefined) {
      delays.push(delay);
    }

    return realSetTimeout(handler, delay);
  }) as typeof setTimeout;

  try {
    fire();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  return delays;
};

describe("connectStream", () => {
  test("recovers from a CLOSED source with capped backoff, reset on open", async () => {
    const document_ = new FakeDocument();
    const { hooks, messages, statuses } = collect();
    const dispose = connect(hooks, document_);

    expect(FakeSource.instances).toHaveLength(1);
    expect(statuses).toEqual(["connecting"]);

    FakeSource.instances[0]?.emit("open");
    expect(statuses).toEqual(["connecting", "open"]);

    // Transient 404: the source dies CLOSED; the connector schedules a
    // reopen instead of waiting on a native retry that never comes.
    expect(scheduledDelays(() => FakeSource.instances[0]?.fail())).toEqual([
      10,
    ]);
    expect(statuses).toEqual(["connecting", "open", "retrying"]);

    await sleep(30);
    expect(FakeSource.instances).toHaveLength(2);

    expect(scheduledDelays(() => FakeSource.instances[1]?.fail())).toEqual([
      20,
    ]);
    await sleep(40);
    expect(FakeSource.instances).toHaveLength(3);

    // Backoff caps instead of doubling forever.
    expect(scheduledDelays(() => FakeSource.instances[2]?.fail())).toEqual([
      40,
    ]);
    await sleep(60);
    expect(FakeSource.instances).toHaveLength(4);
    expect(scheduledDelays(() => FakeSource.instances[3]?.fail())).toEqual([
      40,
    ]);

    // Recovery resets the backoff: the next failure starts at the base again.
    await sleep(60);
    expect(FakeSource.instances).toHaveLength(5);
    FakeSource.instances[4]?.emit("open");
    expect(scheduledDelays(() => FakeSource.instances[4]?.fail())).toEqual([
      10,
    ]);

    // The recovered stream delivers frames.
    await sleep(30);
    expect(FakeSource.instances).toHaveLength(6);
    FakeSource.instances[5]?.emit("open");
    FakeSource.instances[5]?.emit("message", '{"ok":true}');
    expect(statuses).toContain("open");
    expect(messages).toEqual(['{"ok":true}']);

    // At most one live source throughout the whole dance.
    expect(
      FakeSource.instances.filter((source) => source.readyState !== 2)
    ).toHaveLength(1);

    dispose();
  });

  test("leaves native retry alone while the source is still open", async () => {
    const document_ = new FakeDocument();
    const { hooks, statuses } = collect();
    const dispose = connect(hooks, document_);

    FakeSource.instances[0]?.emit("open");
    // Transport blip: readyState stays open, so the native retry owns it —
    // no scheduled reopen, no second source.
    expect(scheduledDelays(() => FakeSource.instances[0]?.blip())).toEqual([]);
    expect(statuses).toEqual(["connecting", "open", "retrying"]);

    await sleep(30);
    expect(FakeSource.instances).toHaveLength(1);

    dispose();
  });

  test("closes on hidden tabs and reopens when visible", async () => {
    const document_ = new FakeDocument();
    const { hooks, statuses } = collect();
    const dispose = connect(hooks, document_);

    FakeSource.instances[0]?.emit("open");

    document_.setHidden(true);
    expect(FakeSource.instances[0]?.closed).toBe(true);
    expect(statuses).toEqual(["connecting", "open", "closed"]);

    // No reconnect while hidden, even past the backoff.
    await sleep(40);
    expect(FakeSource.instances).toHaveLength(1);

    document_.setHidden(false);
    expect(FakeSource.instances).toHaveLength(2);
    expect(statuses).toEqual(["connecting", "open", "closed", "connecting"]);

    dispose();
  });

  test("dispose closes a live source and drops its listeners", () => {
    const document_ = new FakeDocument();
    const { hooks } = collect();
    const dispose = connect(hooks, document_);

    expect(document_.listenerCount("visibilitychange")).toBe(1);

    FakeSource.instances[0]?.emit("open");
    dispose();

    expect(FakeSource.instances[0]?.closed).toBe(true);
    expect(document_.listenerCount("visibilitychange")).toBe(0);

    dispose();
  });

  test("dispose cancels a pending retry", async () => {
    const document_ = new FakeDocument();
    const { hooks } = collect();
    const dispose = connect(hooks, document_);

    FakeSource.instances[0]?.fail();
    dispose();

    // The scheduled reopen never fires.
    await sleep(40);
    expect(FakeSource.instances).toHaveLength(1);

    dispose();
  });

  test("answers closed when no EventSource exists", () => {
    const { hooks, statuses } = collect();

    const dispose = connectStream("http://localhost/api/apps/stream", hooks, {
      source: undefined,
    });

    expect(statuses).toEqual(["closed"]);

    dispose();
  });
});
