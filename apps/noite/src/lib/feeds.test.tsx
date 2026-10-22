/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, eslint/max-classes-per-file -- test doubles: a fake EventSource, document and mounted DOM stand in for the browser globals liveFeed reads, like the fixture in testing/dom */
import { afterEach, describe, expect, test } from "bun:test";

import { atom } from "ilha";
import type { AtomHandle } from "ilha";
import { render } from "ilha/test";

import {
  connectStream,
  createStreamHub,
  liveFeed,
  paintInitial,
  streamHubUrl,
} from "./feeds";
import type { EventSourceStatus, LiveFeed, StreamHooks } from "./feeds";
import { readSwr, writeSwr } from "./swr-store";

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

/** A hub whose settle runs only when the test flushes it. */
const manualHub = () => {
  const pending: (() => void)[] = [];

  const streams = createStreamHub({
    baseMs: 10,
    capMs: 40,
    random: () => 0,
    settle: (reopen) => {
      pending.push(reopen);
    },
    // SAFETY: the fake implements the EventSource surface connectStream uses.
    source: FakeSource as unknown as typeof EventSource,
  });

  const flush = (): void => {
    for (const reopen of pending.splice(0)) {
      reopen();
    }
  };

  return { flush, streams };
};

/** The fake sources still open. */
const liveSources = (): FakeSource[] =>
  FakeSource.instances.filter((source) => !source.closed);

describe("createStreamHub", () => {
  const LOGS = "/api/apps/a/logs/stream";
  const DEPLOYS = "/api/apps/a/deploys/stream";

  test("every feed of a page shares one connection, and topics route by index", () => {
    const { flush, streams } = manualHub();
    const logs = collect();
    const deploys = collect();
    streams.subscribe(LOGS, logs.hooks);
    streams.subscribe(DEPLOYS, deploys.hooks);
    flush();

    expect(liveSources().map((source) => source.url)).toEqual([
      streamHubUrl([LOGS, DEPLOYS]),
    ]);

    const [source] = liveSources();
    source?.emit("open");
    source?.emit("message", "0:+");
    source?.emit("message", '0:["celld listening"]');
    source?.emit("message", "1:[]");
    expect(logs.messages).toEqual(['["celld listening"]']);
    expect(deploys.messages).toEqual(["[]"]);
    expect(logs.statuses.at(-1)).toBe("open");

    // A second panel on a topic already streaming gets its last frame at
    // once and reuses the connection.
    const sidebar = collect();
    streams.subscribe(LOGS, sidebar.hooks);
    flush();
    expect(sidebar.messages).toEqual(['["celld listening"]']);
    expect(FakeSource.instances).toHaveLength(1);
  });

  test("a dropped topic says retrying while the others stay open", () => {
    const { flush, streams } = manualHub();
    const logs = collect();
    const deploys = collect();
    streams.subscribe(LOGS, logs.hooks);
    streams.subscribe(DEPLOYS, deploys.hooks);
    flush();
    const [source] = liveSources();
    source?.emit("open");
    source?.emit("message", "0:+");
    source?.emit("message", "1:+");

    source?.emit("message", "1:!");
    expect(deploys.statuses.at(-1)).toBe("retrying");
    expect(logs.statuses.at(-1)).toBe("open");

    source?.emit("message", "1:[]");
    expect(deploys.statuses.at(-1)).toBe("open");
    expect(deploys.messages).toEqual(["[]"]);
  });

  test("leaving reopens with the smaller set, and the last one out closes it", () => {
    const { flush, streams } = manualHub();
    const logs = collect();
    const deploys = collect();
    const leaveLogs = streams.subscribe(LOGS, logs.hooks);
    const leaveDeploys = streams.subscribe(DEPLOYS, deploys.hooks);
    flush();

    leaveDeploys();
    flush();
    expect(liveSources().map((source) => source.url)).toEqual([
      streamHubUrl([LOGS]),
    ]);

    leaveLogs();
    flush();
    expect(liveSources()).toEqual([]);
  });

  test("a remount before the set settles keeps the connection and the frame", () => {
    const { flush, streams } = manualHub();
    const first = collect();
    const leave = streams.subscribe(LOGS, first.hooks);
    flush();
    const [source] = liveSources();
    source?.emit("open");
    source?.emit("message", '0:["line"]');

    leave();
    const again = collect();
    streams.subscribe(LOGS, again.hooks);
    flush();

    expect(FakeSource.instances).toHaveLength(1);
    expect(source?.closed).toBe(false);
    expect(again.messages).toEqual(['["line"]']);
    expect(again.statuses.at(-1)).toBe("open");
  });
});

/** Unique feed keys: swr snapshots and the shared page hub persist per file. */
let initialKey = 0;

const nextInitialKey = (): string => {
  initialKey += 1;

  return `feed:test:initial:${initialKey}`;
};

let probeKey = "";
let probeUrl = "";
let probeFetch: () => Promise<string[]> = () => Promise.resolve([]);
let capturedFeed: LiveFeed<string[]> | undefined;

const readFeed = (): LiveFeed<string[]> | undefined => capturedFeed;

/** Enough DOM for ilha's mount: the probes render one static span and only
 * read atoms, so element creation, tree assembly, selection and teardown
 * are faked — no layout, no events, no serialization. */
/* eslint-disable eslint/no-use-before-define, eslint/class-methods-use-this, anti-slop/no-runtime-typeof -- test double: circular fake-DOM classes with DOM-shaped no-op methods; the string wrap mirrors Node.append */

class FakeNode {
  parent: FakeNode | null = null;

  children: FakeNode[] = [];

  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      this.attach(
        typeof node === "string" ? new FakeCharacterData(node) : node
      );
    }
  }

  prepend(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes.toReversed()) {
      const child =
        typeof node === "string" ? new FakeCharacterData(node) : node;

      child.remove();
      child.parent = this;
      this.children.unshift(child);
    }
  }

  hasChildNodes(): boolean {
    return this.children.length > 0;
  }

  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    if (this.parent === null) {
      return null;
    }

    const siblings = this.parent.children;

    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  appendChild<T extends FakeNode>(child: T): T {
    this.attach(child);

    return child;
  }

  insertBefore<T extends FakeNode>(child: T, reference: FakeNode | null): T {
    child.remove();
    child.parent = this;
    const at = reference === null ? -1 : this.children.indexOf(reference);

    if (at === -1) {
      this.children.push(child);
    } else {
      this.children.splice(at, 0, child);
    }

    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    if (child.parent === this) {
      child.remove();
    }

    return child;
  }

  remove(): void {
    if (this.parent === null) {
      return;
    }

    const siblings = this.parent.children;
    const at = siblings.indexOf(this);

    if (at !== -1) {
      siblings.splice(at, 1);
    }

    this.parent = null;
  }

  addEventListener(): void {}

  removeEventListener(): void {}

  private attach(child: FakeNode): void {
    child.remove();
    child.parent = this;
    this.children.push(child);
  }
}

class FakeElement extends FakeNode {
  attributes = new Map<string, string>();

  tagName: string;

  constructor(tag: string) {
    super();
    this.tagName = tag;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

class FakeCharacterData extends FakeNode {
  data: string;

  constructor(data: string) {
    super();
    this.data = data;
  }
}

/* eslint-enable eslint/no-use-before-define, eslint/class-methods-use-this, anti-slop/no-runtime-typeof */

const installDomFixture = (): (() => void) => {
  const body = new FakeElement("body");

  const document = {
    activeElement: null,
    addEventListener: (): void => {},
    body,
    createComment: (data: string): FakeCharacterData =>
      new FakeCharacterData(data),
    createDocumentFragment: (): FakeNode => new FakeNode(),
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string): FakeElement =>
      new FakeElement(tag),
    createRange: () => ({
      createContextualFragment: (_html: string): FakeNode => new FakeNode(),
    }),
    createTextNode: (data: string): FakeCharacterData =>
      new FakeCharacterData(data),
    removeEventListener: (): void => {},
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = document;
  globals.window = {
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  globals.HTMLElement = FakeElement;
  globals.Element = FakeNode;
  globals.Node = FakeNode;
  globals.getSelection = () => null;
  globals.requestAnimationFrame = (frame: (time: number) => void): number => {
    frame(0);

    return 0;
  };

  // SAFETY: the fake implements the EventSource surface liveFeed uses.
  globals.EventSource = FakeSource as unknown as typeof EventSource;

  return () => {
    delete globals.document;
    delete globals.window;
    delete globals.HTMLElement;
    delete globals.Element;
    delete globals.Node;
    delete globals.getSelection;
    delete globals.requestAnimationFrame;
    delete globals.EventSource;
  };
};

/** Atoms and feeds run at the top level of a component: the probes capture
 * the handles for the test to drive. */
const FeedProbe = () => {
  capturedFeed = liveFeed<string[]>(
    probeKey,
    probeUrl,
    // SAFETY: the test frames are JSON string arrays by construction.
    (raw: string) => JSON.parse(raw) as string[],
    { initial: probeFetch }
  );

  return <span />;
};

let capturedAtoms: AtomHandle<string[] | undefined>[] = [];

const AtomProbe = () => {
  // oxlint-disable-next-line unicorn/no-useless-undefined -- the probe starts valueless; undefined is the seed
  capturedAtoms.push(atom<string[] | undefined>(undefined));

  return <span />;
};

const captureAtom = async (): Promise<{
  latest: AtomHandle<string[] | undefined>;
  unmount: () => void;
}> => {
  capturedAtoms = [];
  const ui = render(AtomProbe);
  await ui.settled();

  const [latest] = capturedAtoms;

  if (latest === undefined) {
    throw new Error("the probe did not capture an atom");
  }

  return {
    latest,
    unmount: () => {
      ui.unmount();
    },
  };
};

describe("liveFeed initial snapshot", () => {
  test("a cold key paints the initial fetch when the stream never emits", async () => {
    const restore = installDomFixture();

    try {
      probeKey = nextInitialKey();
      probeUrl = `/api/apps/a/logs/stream:${initialKey}`;
      probeFetch = () => Promise.resolve(["a", "b"]);
      capturedFeed = undefined;
      const ui = render(FeedProbe);
      await ui.settled();

      const feed = readFeed();

      if (feed === undefined) {
        throw new Error("the probe did not capture a feed");
      }

      expect(feed.latest()).toEqual(["a", "b"]);
      expect(readSwr<string[]>(probeKey)).toEqual(["a", "b"]);
      ui.unmount();
    } finally {
      restore();
    }
  });

  test("a stream frame wins over a slower initial fetch", async () => {
    const restore = installDomFixture();

    try {
      const key = nextInitialKey();
      const { latest, unmount } = await captureAtom();
      // The stream already delivered: the atom holds its frame.
      latest.set(["stream"]);

      let calls = 0;
      await paintInitial(key, latest, {
        initial: () => {
          calls += 1;

          return Promise.resolve(["stale"]);
        },
      });

      expect(calls).toBe(1);
      expect(latest()).toEqual(["stream"]);
      expect(readSwr<string[]>(key)).toBeUndefined();
      unmount();
    } finally {
      restore();
    }
  });

  test("a failed initial fetch is ignored and leaves the stream live", async () => {
    const restore = installDomFixture();

    try {
      const key = nextInitialKey();
      const { latest, unmount } = await captureAtom();

      await paintInitial(key, latest, {
        initial: () => Promise.reject(new Error("runner away")),
      });

      expect(latest()).toBeUndefined();
      expect(readSwr<string[]>(key)).toBeUndefined();
      unmount();
    } finally {
      restore();
    }
  });

  test("a warm key never fetches", async () => {
    const restore = installDomFixture();

    try {
      const key = nextInitialKey();
      writeSwr(key, ["cached"]);
      const { latest, unmount } = await captureAtom();

      let calls = 0;
      await paintInitial(key, latest, {
        initial: () => {
          calls += 1;

          return Promise.resolve(["fresh"]);
        },
      });

      expect(calls).toBe(0);
      expect(latest()).toBeUndefined();
      unmount();
    } finally {
      restore();
    }
  });

  test("panels on one key share one fetch", async () => {
    const restore = installDomFixture();

    try {
      const key = nextInitialKey();
      const { latest: first, unmount: unmountFirst } = await captureAtom();
      const { latest: second, unmount: unmountSecond } = await captureAtom();

      let calls = 0;
      // One pending fetch both panels attach to: the second sees the
      // in-flight entry and shares it instead of fetching again.
      const shared = Promise.resolve(["shared"]);

      const initial = (): Promise<string[]> => {
        calls += 1;

        return shared;
      };

      await Promise.all([
        paintInitial(key, first, { initial }),
        paintInitial(key, second, { initial }),
      ]);

      expect(calls).toBe(1);
      expect(first()).toEqual(["shared"]);
      expect(second()).toEqual(["shared"]);
      unmountFirst();
      unmountSecond();
    } finally {
      restore();
    }
  });
});
