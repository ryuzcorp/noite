/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, eslint/class-methods-use-this, eslint/max-classes-per-file, eslint/no-use-before-define -- test doubles: a scripted EventSource, a fake DOM and a hand-fired clock stand in for the browser globals the live feed and ilha's mount read, like the fixtures in lib/resource.test.tsx and lib/feeds.test.tsx */
import { describe, expect, test } from "bun:test";

import { render } from "ilha/test";
import type { TestUi } from "ilha/test";

import type { AppDetail } from "../api-types";
import { resetStreamHub } from "../feeds";
import { resourceError, resourceValue } from "../resource";
import type { Resource } from "../resource";
import { appDetail, keys } from "../resources";
import type { RunnerApp, RunnerAppState, RunnerEnvironment } from "../runner";
import { readSwr } from "../swr-store";
import { AppStateSyncSlot, staleKeys } from "./state-sync";

const app = (patch: Partial<RunnerApp> = {}): RunnerApp => ({
  asleepSince: null,
  autoDeploy: { state: "eligible" },
  createdAt: "2026-10-20T00:00:00Z",
  desiredState: "running",
  fleetBucket: "noite",
  gitPrefix: "git/demo",
  id: "app_1",
  imported: false,
  internalPort: 30_001,
  lastDeploySha: "aaa111",
  lastError: null,
  listenPort: 30_000,
  name: "Demo",
  slug: "demo",
  status: "deploying",
  subdomain: "demo.noite.localhost",
  updatedAt: "2026-10-20T00:00:00Z",
  userId: "u_1",
  wokeAt: null,
  ...patch,
});

const env = (patch: Partial<RunnerEnvironment> = {}): RunnerEnvironment => ({
  appId: "app_1",
  appSlug: "demo",
  asleepSince: null,
  autoDeploy: { state: "eligible" },
  createdAt: "2026-10-20T00:00:00Z",
  createdBy: "u_1",
  desiredState: "running",
  fleetBucket: "noite",
  gitRef: "refs/heads/feature",
  id: "env_1",
  internalPort: 31_001,
  kind: "branch",
  label: "feature",
  lastDeploySha: "bbb222",
  lastDeployedAt: null,
  lastError: null,
  listenPort: 31_000,
  public: false,
  status: "deploying",
  updatedAt: "2026-10-20T00:00:00Z",
  wokeAt: null,
  ...patch,
});

const detail = (patch: Partial<RunnerApp> = {}): AppDetail => ({
  app: app(patch),
  gitHint: "",
  gitRemote: "",
  host: "demo.noite.localhost",
  myRole: "admin",
  s3Endpoint: "",
  username: "u_1",
});

const frame = (
  appPatch: Partial<RunnerApp> = {},
  environments: RunnerEnvironment[] = [env()]
): RunnerAppState => ({ app: app(appPatch), environments });

describe("staleKeys", () => {
  test("a finished deploy makes the cached detail stale, the sidebar's peers follow", () => {
    expect(
      staleKeys(
        "app_1",
        frame({ lastDeploySha: "ccc333", status: "running" }),
        detail(),
        [env()]
      )
    ).toEqual([keys.appDetail("app_1")]);
  });

  test("an environment that changed status makes the environments stale", () => {
    expect(
      staleKeys("app_1", frame({}, [env({ status: "running" })]), detail(), [
        env(),
      ])
    ).toEqual([keys.environments("app_1")]);
  });

  test("an environment created or deleted elsewhere makes the list stale", () => {
    const added = frame({}, [env(), env({ id: "env_2", label: "other" })]);

    expect(staleKeys("app_1", added, detail(), [env()])).toEqual([
      keys.environments("app_1"),
    ]);
    expect(staleKeys("app_1", frame({}, []), detail(), [env()])).toEqual([
      keys.environments("app_1"),
    ]);
  });

  test("a paused automatic budget makes the detail stale so the line appears live", () => {
    expect(
      staleKeys(
        "app_1",
        frame({
          autoDeploy: { failures: 2, sha: "aaa111", state: "exhausted" },
        }),
        detail(),
        [env()]
      )
    ).toEqual([keys.appDetail("app_1")]);
  });

  test("an environment's paused budget repaints its group", () => {
    expect(
      staleKeys(
        "app_1",
        frame({}, [env({ autoDeploy: { sha: "bbb222", state: "stopped" } })]),
        detail(),
        [env()]
      )
    ).toEqual([keys.environments("app_1")]);
  });

  test("a stop or a sleep shows too, not only a deploy", () => {
    expect(
      staleKeys("app_1", frame({ desiredState: "stopped" }), detail(), [env()])
    ).toEqual([keys.appDetail("app_1")]);
    expect(
      staleKeys(
        "app_1",
        frame({ asleepSince: "2026-10-20T01:00:00Z", status: "sleeping" }),
        detail(),
        [env()]
      )
    ).toEqual([keys.appDetail("app_1")]);
  });

  test("a fleet hold appearing, changing or lifting refetches the detail", () => {
    const hold = {
      hold: "crash" as const,
      retryAt: "2026-11-10T16:40:05.000Z",
    };

    // The badge flips to "crashed, retrying" and back: both are shown.
    expect(
      staleKeys("app_1", frame({ fleetHold: hold }), detail(), [env()])
    ).toEqual([keys.appDetail("app_1")]);
    expect(
      staleKeys("app_1", frame(), detail({ fleetHold: hold }), [env()])
    ).toEqual([keys.appDetail("app_1")]);
    // A later attempt (a new deadline, same reason) moves the time.
    expect(
      staleKeys(
        "app_1",
        frame({ fleetHold: { ...hold, retryAt: "2026-11-10T16:41:05.000Z" } }),
        detail({ fleetHold: hold }),
        [env()]
      )
    ).toEqual([keys.appDetail("app_1")]);
    // The same hold at sub-second jitter is not a change.
    expect(
      staleKeys(
        "app_1",
        frame({ fleetHold: { ...hold, retryAt: "2026-11-10T16:40:05.499Z" } }),
        detail({ fleetHold: hold }),
        [env()]
      )
    ).toEqual([]);
  });

  test("bookkeeping a page never shows refetches nothing", () => {
    expect(
      staleKeys(
        "app_1",
        frame({ updatedAt: "2026-10-20T02:00:00Z", wokeAt: "x" }, [
          env({ updatedAt: "2026-10-20T02:00:00Z" }),
        ]),
        detail(),
        [env()]
      )
    ).toEqual([]);
  });

  test("a cache never fetched is left to its own first fetch", () => {
    expect(staleKeys("app_1", frame({ status: "running" }))).toEqual([]);
  });

  test("a role change in the frame invalidates the detail (demoted users lose admin buttons)", () => {
    const demoted = { ...frame(), myRole: "view" as const };

    expect(staleKeys("app_1", demoted, detail(), [env()])).toEqual([
      keys.appDetail("app_1"),
    ]);
  });

  test("a frame without a role never counts as a role change", () => {
    expect(staleKeys("app_1", frame(), detail(), [env()])).toEqual([]);
  });
});

/* The integration doubles below; the pure syncPlan tests above need none of it. */
/** Scripted EventSource stand-in: the test fires open/message by hand. */
class FakeSource {
  static instances: FakeSource[] = [];

  static reset(): void {
    FakeSource.instances = [];
  }

  readonly url: string;

  readyState = 0;

  closed = false;

  private listeners = new Map<string, ((event: { data?: string }) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: { data?: string }) => void
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(
    type: string,
    listener: (event: { data?: string }) => void
  ): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((live) => live !== listener)
    );
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: "open" | "message", data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }
}

/** Minimal tree for ilha's mount: the subset of the DOM surface the test's
 * components touch (a host node, text for markers, fragment plumbing). */
class FakeNode {
  children: FakeNode[] = [];

  parent: FakeNode | null = null;

  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      this.attach(
        typeof node === "string" ? new FakeCharacterData(node) : node
      );
    }
  }

  appendChild<T extends FakeNode>(child: T): T {
    this.attach(child);

    return child;
  }

  hasChildNodes(): boolean {
    return this.children.length > 0;
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
  getAttribute(_name: string): string | null {
    return null;
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

  removeChild<T extends FakeNode>(child: T): T {
    if (child.parent === this) {
      child.remove();
    }

    return child;
  }

  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }

  private attach(child: FakeNode): void {
    child.remove();
    child.parent = this;
    this.children.push(child);
  }
}

class FakeElement extends FakeNode {
  attributes = new Map<string, string>();

  style = { cssText: "" };

  tagName: string;

  constructor(tag: string) {
    super();
    this.tagName = tag;
  }

  get childNodes(): FakeNode[] {
    return this.children;
  }

  override getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttributeNames(): string[] {
    return [...this.attributes.keys()];
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  toggleAttribute(name: string, force?: boolean): void {
    if (force === undefined) {
      if (this.attributes.has(name)) {
        this.attributes.delete(name);
      } else {
        this.attributes.set(name, "");
      }

      return;
    }

    if (force) {
      this.attributes.set(name, "");
    } else {
      this.attributes.delete(name);
    }
  }

  checked = false;

  value = "";
}

class FakeCharacterData extends FakeNode {
  data: string;

  constructor(data: string) {
    super();
    this.data = data;
  }
}

class FakeDocument extends FakeNode {
  hidden = false;

  body = new FakeElement("body");

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

  createComment(data: string): FakeCharacterData {
    return new FakeCharacterData(data);
  }

  createDocumentFragment(): FakeNode {
    return new FakeNode();
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  createElementNS(_ns: string, tag: string): FakeElement {
    return new FakeElement(tag);
  }

  createTextNode(data: string): FakeCharacterData {
    return new FakeCharacterData(data);
  }
}

/** The browser members a fixture installs and puts back by value. */
interface BrowserGlobals {
  document?: unknown;
  Element?: unknown;
  HTMLElement?: unknown;
  HTMLInputElement?: unknown;
  HTMLSelectElement?: unknown;
  HTMLTextAreaElement?: unknown;
  Node?: unknown;
  window?: unknown;
}

/** The browser globals the slot and its reader touch: the DOM ilha mounts
 * into. The undo restores what was there *by value* instead of deleting the
 * names — one `bun test` run shares one global object, so a fixture that left
 * `window` behind made the next file's SSR render take the browser branch and
 * throw in `appUrl()` (`window.location` was absent) instead of painting the
 * header. `src/testing/leaked-globals.ts` fails the leaking test instead. */
const BROWSER_GLOBALS = [
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Node",
  "document",
  "window",
] as const satisfies readonly (keyof BrowserGlobals)[];

const installBrowserGlobals = (): (() => void) => {
  // SAFETY: the process global object's optional browser members; only the documented fixture keys are read and set.
  const globals = globalThis as unknown as BrowserGlobals;

  const saved = BROWSER_GLOBALS.map(
    (name) => [name, name in globals, globals[name]] as const
  );

  Object.assign(globalThis, {
    document: new FakeDocument(),
    Element: FakeNode,
    HTMLInputElement: FakeElement,
    HTMLSelectElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
    HTMLElement: FakeElement,
    Node: FakeNode,
    // The sync schedules its failure re-drive through `window`; the wrappers
    // read the global at call time, so a hand-fired clock installed after
    // this fixture still owns them.
    window: {
      clearTimeout: (id?: number) => globalThis.clearTimeout(id),
      setTimeout: (handler: () => void, ms?: number) =>
        globalThis.setTimeout(handler, ms),
    },
  });

  return () => {
    for (const [name, had, value] of saved) {
      if (had) {
        globals[name] = value;
      } else {
        Reflect.deleteProperty(globals, name);
      }
    }
  };
};

/** Drain the Effect runtime's promises (microtasks, not a wall clock). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- draining microtasks in order
    await Promise.resolve();
  }
};

/** Hand-fired clock for the hub settle, the retry backoff and the
 * failed-settle re-drive: `setTimeout` calls are captured with their delay,
 * never run; the test fires them by hand, so no test waits out a real
 * delay. `clearTimeout` removes a captured timer, so a test can prove an
 * unmount cancelled one. */
const installManualClock = () => {
  const queue: { delayMs: number; handler: () => void; id: number }[] = [];
  let nextId = 0;

  // SAFETY: the test fires every captured timer by hand below.
  globalThis.setTimeout = ((handler: () => void, delayMs = 0) => {
    nextId += 1;
    const id = nextId;
    queue.push({ delayMs, handler, id });

    return id;
  }) as unknown as typeof setTimeout;
  // SAFETY: removes an entry from the queue above; the id is the one
  // `setTimeout` returned.
  globalThis.clearTimeout = ((id?: number) => {
    const at = queue.findIndex((timer) => timer.id === id);

    if (at !== -1) {
      queue.splice(at, 1);
    }
  }) as unknown as typeof clearTimeout;

  const fire = (): void => {
    const next = queue.shift();

    if (next === undefined) {
      throw new Error("no timer scheduled");
    }

    next.handler();
  };

  return { fire, queue };
};

/** Install the browser/EventSource/fetch doubles, mount one app page and
 * fire the hub's settle so the stream is open. `respond` sees the 1-based
 * fetch call number; the caller restores in a `finally`. */
const mountAppSync = async (
  id: string,
  respond: (call: number) => Response
) => {
  // SAFETY: the process global object as a bag; only EventSource and fetch are read here.
  const testGlobals = globalThis as unknown as {
    EventSource?: unknown;
    fetch?: unknown;
  };

  const realEventSource = testGlobals.EventSource;
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let restoreBrowserGlobals: (() => void) | undefined;
  let ui: TestUi | undefined;

  // Built before any setup step can throw: a failed render or a setup guard
  // still closes the root (if one exists) and puts every double back, so the
  // shared test process is never left with a fake global.
  const restore = (): void => {
    ui?.unmount();
    ui = undefined;
    resetStreamHub();
    FakeSource.reset();
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;

    if (realEventSource === undefined) {
      delete testGlobals.EventSource;
    } else {
      testGlobals.EventSource = realEventSource;
    }

    restoreBrowserGlobals?.();
  };

  try {
    restoreBrowserGlobals = installBrowserGlobals();
    // SAFETY: the fake implements the EventSource surface connectStream reads.
    testGlobals.EventSource = FakeSource as unknown as typeof EventSource;
    const clock = installManualClock();

    FakeSource.reset();

    const calls = { value: 0 };
    // SAFETY: the test only needs the (url, init) call shape, like the fetch
    // doubles in http/recovery and routes/envelope.
    testGlobals.fetch = ((
      _url: string | URL | Request,
      _init?: RequestInit
    ): Promise<Response> => {
      calls.value += 1;

      return Promise.resolve(respond(calls.value));
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch, matching the repo's established stubs.
    }) as unknown as typeof fetch;

    let capturedRes: Resource<AppDetail> | undefined;

    const Probe = () => {
      const res = appDetail(id);
      capturedRes = res;

      return <span />;
    };

    const Page = () => (
      <>
        <Probe />
        <AppStateSyncSlot appId={id} />
      </>
    );

    const mounted = render(Page);
    ui = mounted;
    await mounted.settled();
    await flush();

    if (capturedRes === undefined) {
      throw new Error("the probe captured no app row resource");
    }

    clock.fire();
    const [source] = FakeSource.instances;

    if (source === undefined) {
      throw new Error("the sync opened no state stream");
    }

    source.emit("open");

    return {
      calls,
      clock,
      res: capturedRes,
      restore,
      source,
      ui: mounted,
    };
  } catch (error) {
    restore();
    throw error;
  }
};

describe("AppStateSync post-settle re-compare", () => {
  test("a stale load that lands after a newer frame refetches against it", async () => {
    // SAFETY: the process global object as a bag; only EventSource and fetch are read here.
    const testGlobals = globalThis as unknown as {
      EventSource?: unknown;
      fetch?: unknown;
    };

    const realEventSource = testGlobals.EventSource;
    const realFetch = globalThis.fetch;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const restoreBrowserGlobals = installBrowserGlobals();
    // SAFETY: the fake implements the EventSource surface connectStream reads.
    testGlobals.EventSource = FakeSource as unknown as typeof EventSource;
    const clock = installManualClock();

    try {
      FakeSource.reset();
      const id = "app-sync-race";

      const running = detail({
        desiredState: "running",
        id,
        slug: "sync-race",
        status: "running",
      });

      const stopped = detail({
        desiredState: "stopped",
        id,
        slug: "sync-race",
        status: "stopped",
      });

      const stoppedFrame = JSON.stringify(
        frame(
          { desiredState: "stopped", id, slug: "sync-race", status: "stopped" },
          [env({ appId: id, appSlug: "sync-race" })]
        )
      );

      const runningFrame = JSON.stringify(
        frame(
          { desiredState: "running", id, slug: "sync-race", status: "running" },
          [env({ appId: id, appSlug: "sync-race" })]
        )
      );

      let calls = 0;
      // SAFETY: the test only needs the (url, init) call shape, like the
      // fetch doubles in http/recovery and routes/envelope.
      testGlobals.fetch = ((
        _url: string | URL | Request,
        _init?: RequestInit
      ): Promise<Response> => {
        calls += 1;

        if (calls === 1) {
          return Promise.resolve(Response.json(running, { status: 200 }));
        }

        if (calls === 2) {
          return Promise.resolve(
            Response.json({ error: "boom" }, { status: 500 })
          );
        }

        if (calls === 3) {
          // The retry reads while the row is still stopped (stale read racing
          // the runner).
          return Promise.resolve(Response.json(stopped, { status: 200 }));
        }

        // A load that starts after the frame reads current truth.
        return Promise.resolve(Response.json(running, { status: 200 }));
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch, matching the repo's established stubs.
      }) as unknown as typeof fetch;

      let capturedRes: Resource<AppDetail> | undefined;

      const Probe = () => {
        const res = appDetail(id);
        capturedRes = res;

        return <span />;
      };

      const Page = () => (
        <>
          <Probe />
          <AppStateSyncSlot appId={id} />
        </>
      );

      const ui = render(Page);
      await ui.settled();
      await flush();

      if (capturedRes === undefined) {
        throw new Error("the probe captured no app row resource");
      }

      const res = capturedRes;

      const painted = (): AppDetail | undefined => resourceValue(res.state());

      expect(calls).toBe(1);
      expect(painted()).toEqual(running);

      // Fire the hub's settle: the topic opens and the stopped frame starts
      // the slow load (call 2 fails, then backs off on the manual clock).
      clock.fire();
      expect(FakeSource.instances).toHaveLength(1);
      const [source] = FakeSource.instances;
      source?.emit("open");
      source?.emit("message", "0:+");
      source?.emit("message", `0:${stoppedFrame}`);
      await ui.settled();
      await flush();
      expect(calls).toBe(2);
      // The refetch failed and backs off; the badge still shows running.
      expect(painted()).toEqual(running);

      // The runner restarts while the retry backs off: the running frame
      // agrees with the store, so nothing refetches yet.
      source?.emit("message", `0:${runningFrame}`);
      await ui.settled();
      await flush();
      expect(calls).toBe(2);
      expect(painted()).toEqual(running);

      // The retry answers with its stale read — then the post-settle
      // re-compare sees the store disagree with the latest frame and
      // refetches once, converging back on running.
      clock.fire();
      await ui.settled();
      await flush();
      expect(calls).toBe(4);
      expect(painted()).toEqual(running);
      expect(resourceError(res.state())).toBeUndefined();
      expect(readSwr<AppDetail>(keys.appDetail(id))).toEqual(running);

      // Fire any leftover backoff: nothing further may fetch.
      for (let i = 0; i < 5 && clock.queue.length > 0; i += 1) {
        clock.fire();
      }

      await ui.settled();
      await flush();
      expect(calls).toBe(4);
      expect(painted()).toEqual(running);
      expect(resourceError(res.state())).toBeUndefined();
      expect(readSwr<AppDetail>(keys.appDetail(id))).toEqual(running);
      ui.unmount();
    } finally {
      resetStreamHub();
      FakeSource.reset();
      globalThis.fetch = realFetch;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;

      if (realEventSource === undefined) {
        delete testGlobals.EventSource;
      } else {
        testGlobals.EventSource = realEventSource;
      }

      restoreBrowserGlobals();
    }
  });

  test("agreeing frames never fetch per-frame: one in-flight load costs at most one extra fetch", async () => {
    // SAFETY: the process global object as a bag; only EventSource and fetch are read here.
    const testGlobals = globalThis as unknown as {
      EventSource?: unknown;
      fetch?: unknown;
    };

    const realEventSource = testGlobals.EventSource;
    const realFetch = globalThis.fetch;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const restoreBrowserGlobals = installBrowserGlobals();
    // SAFETY: the fake implements the EventSource surface connectStream reads.
    testGlobals.EventSource = FakeSource as unknown as typeof EventSource;
    const clock = installManualClock();

    try {
      FakeSource.reset();
      const id = "app-sync-bound";

      const running = detail({
        desiredState: "running",
        id,
        slug: "sync-bound",
        status: "running",
      });

      const stopped = detail({
        desiredState: "stopped",
        id,
        slug: "sync-bound",
        status: "stopped",
      });

      const frameFor = (status: "running" | "stopped"): string =>
        JSON.stringify(
          frame({ desiredState: status, id, slug: "sync-bound", status }, [
            env({ appId: id, appSlug: "sync-bound" }),
          ])
        );

      let calls = 0;
      // SAFETY: the test only needs the (url, init) call shape, like the
      // fetch doubles in http/recovery and routes/envelope.
      testGlobals.fetch = ((
        _url: string | URL | Request,
        _init?: RequestInit
      ): Promise<Response> => {
        calls += 1;

        if (calls === 1) {
          return Promise.resolve(Response.json(running, { status: 200 }));
        }

        if (calls === 2) {
          return Promise.resolve(
            Response.json({ error: "boom" }, { status: 500 })
          );
        }

        if (calls === 3) {
          return Promise.resolve(Response.json(stopped, { status: 200 }));
        }

        return Promise.resolve(Response.json(running, { status: 200 }));
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch, matching the repo's established stubs.
      }) as unknown as typeof fetch;

      let capturedRes: Resource<AppDetail> | undefined;

      const Probe = () => {
        const res = appDetail(id);
        capturedRes = res;

        return <span />;
      };

      const Page = () => (
        <>
          <Probe />
          <AppStateSyncSlot appId={id} />
        </>
      );

      const ui = render(Page);
      await ui.settled();
      await flush();
      expect(calls).toBe(1);

      if (capturedRes === undefined) {
        throw new Error("the probe captured no app row resource");
      }

      const res = capturedRes;

      const painted = (): AppDetail | undefined => resourceValue(res.state());

      clock.fire();
      expect(FakeSource.instances).toHaveLength(1);
      const [source] = FakeSource.instances;
      source?.emit("open");
      source?.emit("message", "0:+");

      // An agreeing stream with no load in flight fetches nothing.
      for (let i = 0; i < 5; i += 1) {
        source?.emit("message", `0:${frameFor("running")}`);
      }

      await ui.settled();
      await flush();
      expect(calls).toBe(1);
      expect(painted()).toEqual(running);

      // One stopped frame starts the slow load; five agreeing frames arrive
      // while it backs off, and none of them may start its own fetch.
      source?.emit("message", `0:${frameFor("stopped")}`);
      await ui.settled();
      await flush();
      expect(calls).toBe(2);

      for (let i = 0; i < 5; i += 1) {
        source?.emit("message", `0:${frameFor("running")}`);
      }

      await ui.settled();
      await flush();
      expect(calls).toBe(2);
      expect(painted()).toEqual(running);

      // The stale retry lands, the post-settle re-compare refetches once,
      // and the badge converges: 4 calls total, however many frames flowed.
      clock.fire();
      await ui.settled();
      await flush();
      expect(calls).toBe(4);
      expect(painted()).toEqual(running);
      expect(resourceError(res.state())).toBeUndefined();
      expect(readSwr<AppDetail>(keys.appDetail(id))).toEqual(running);
      ui.unmount();
    } finally {
      resetStreamHub();
      FakeSource.reset();
      globalThis.fetch = realFetch;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;

      if (realEventSource === undefined) {
        delete testGlobals.EventSource;
      } else {
        testGlobals.EventSource = realEventSource;
      }

      restoreBrowserGlobals();
    }
  });
});

describe("AppStateSync failed-settle re-drive", () => {
  test("a refetch that fails every attempt is re-driven on a backoff until the frame's truth lands", async () => {
    const id = "app-sync-failed";
    const slug = "sync-failed";

    const running = detail({
      desiredState: "running",
      id,
      slug,
      status: "running",
    });

    const stopped = detail({
      desiredState: "stopped",
      id,
      slug,
      status: "stopped",
    });

    const stoppedFrame = JSON.stringify(
      frame({ desiredState: "stopped", id, slug, status: "stopped" }, [
        env({ appId: id, appSlug: slug }),
      ])
    );

    const harness = await mountAppSync(id, (call) => {
      if (call === 1) {
        return Response.json(running, { status: 200 });
      }

      if (call <= 5) {
        return Response.json({ error: "boom" }, { status: 500 });
      }

      return Response.json(stopped, { status: 200 });
    });

    try {
      const { clock, res, source, ui } = harness;
      const painted = (): AppDetail | undefined => resourceValue(res.state());

      expect(harness.calls.value).toBe(1);
      expect(painted()).toEqual(running);

      // One frame disagrees; its refetch spends all four attempts (1 s,
      // 2 s and 4 s of backoff) against a failing control plane.
      source.emit("message", "0:+");
      source.emit("message", `0:${stoppedFrame}`);
      await ui.settled();
      await flush();
      expect(harness.calls.value).toBe(2);

      for (let retry = 0; retry < 3; retry += 1) {
        clock.fire();
        // oxlint-disable-next-line eslint/no-await-in-loop -- one retry attempt per fired backoff
        await ui.settled();
        // oxlint-disable-next-line eslint/no-await-in-loop -- one retry attempt per fired backoff
        await flush();
      }

      expect(harness.calls.value).toBe(5);
      expect(painted()).toEqual(running);
      expect(resourceError(res.state())).toBeDefined();

      // The settle failed after its own budget: one re-drive is scheduled
      // at the base delay, and nothing polls before it.
      expect(clock.queue).toHaveLength(1);
      expect(clock.queue[0]?.delayMs).toBe(5000);

      // No new frame arrives: the re-drive refetches against the frame,
      // which now reads current truth, and the badge converges.
      clock.fire();
      await ui.settled();
      await flush();
      expect(harness.calls.value).toBe(6);
      expect(painted()).toEqual(stopped);
      expect(resourceError(res.state())).toBeUndefined();
      expect(readSwr<AppDetail>(keys.appDetail(id))).toEqual(stopped);
      // An agreeing settle ended the series: no timer is left behind.
      expect(clock.queue).toHaveLength(0);
    } finally {
      harness.restore();
    }
  });

  test("unmount clears the pending re-drive", async () => {
    const id = "app-sync-unmount";
    const slug = "sync-unmount";

    const running = detail({
      desiredState: "running",
      id,
      slug,
      status: "running",
    });

    const stoppedFrame = JSON.stringify(
      frame({ desiredState: "stopped", id, slug, status: "stopped" }, [
        env({ appId: id, appSlug: slug }),
      ])
    );

    const harness = await mountAppSync(id, (call) =>
      call === 1
        ? Response.json(running, { status: 200 })
        : Response.json({ error: "boom" }, { status: 500 })
    );

    try {
      const { clock, source, ui } = harness;

      source.emit("message", "0:+");
      source.emit("message", `0:${stoppedFrame}`);
      await ui.settled();
      await flush();

      for (let retry = 0; retry < 3; retry += 1) {
        clock.fire();
        // oxlint-disable-next-line eslint/no-await-in-loop -- one retry attempt per fired backoff
        await ui.settled();
        // oxlint-disable-next-line eslint/no-await-in-loop -- one retry attempt per fired backoff
        await flush();
      }

      expect(harness.calls.value).toBe(5);
      expect(clock.queue).toHaveLength(1);
      expect(clock.queue[0]?.delayMs).toBe(5000);

      ui.unmount();
      await flush();

      // Teardown leaves the hub's own settle timer behind, never the
      // re-drive: only `clearTimeout` removes an entry from this clock.
      expect(clock.queue.some((timer) => timer.delayMs === 5000)).toBe(false);
      expect(harness.calls.value).toBe(5);
    } finally {
      harness.restore();
    }
  });
});
