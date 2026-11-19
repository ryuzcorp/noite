/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, eslint/class-methods-use-this, eslint/max-classes-per-file, eslint/no-use-before-define -- test doubles: a scripted EventSource, a fake DOM and a hand-fired clock stand in for the browser globals the live feed and ilha's mount read, like the fixtures in lib/resource.test.tsx and lib/feeds.test.tsx */
import { describe, expect, test } from "bun:test";

import { render } from "ilha/test";

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

/** Drain the Effect runtime's promises (microtasks, not a wall clock). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- draining microtasks in order
    await Promise.resolve();
  }
};

/** Hand-fired clock for the hub settle and the retry backoff: `setTimeout`
 * calls are captured, never run; the test fires them by hand, so no test
 * waits out a real delay. */
const installManualClock = () => {
  const queue: (() => void)[] = [];
  // SAFETY: the test fires every captured timer by hand below.
  globalThis.setTimeout = ((handler: () => void) => {
    queue.push(handler);

    return queue.length;
  }) as unknown as typeof setTimeout;

  const fire = (): void => {
    const next = queue.shift();

    if (next === undefined) {
      throw new Error("no timer scheduled");
    }

    next();
  };

  return { fire, queue };
};

describe("AppStateSync supersede", () => {
  test("a frame that lands mid-load supersedes the stale load", async () => {
    const testGlobals = globalThis as unknown as {
      Element?: unknown;
      EventSource?: unknown;
      HTMLElement?: unknown;
      HTMLInputElement?: unknown;
      HTMLSelectElement?: unknown;
      HTMLTextAreaElement?: unknown;
      Node?: unknown;
      document?: unknown;
      fetch?: unknown;
      window?: unknown;
    };

    const realEventSource = testGlobals.EventSource;
    const realFetch = globalThis.fetch;
    const realSetTimeout = globalThis.setTimeout;
    testGlobals.document = new FakeDocument();
    testGlobals.window = {};
    testGlobals.HTMLElement = FakeElement;
    testGlobals.Element = FakeNode;
    testGlobals.Node = FakeNode;
    testGlobals.HTMLInputElement = FakeElement;
    testGlobals.HTMLSelectElement = FakeElement;
    testGlobals.HTMLTextAreaElement = FakeElement;
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
      let retryFired = false;
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

        // The retry reads while the row is still stopped (stale read racing
        // the runner); a superseding load reads after the frame.
        return Promise.resolve(
          Response.json(retryFired ? stopped : running, { status: 200 })
        );
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
      // agrees with the store, so only a supersede saves the badge.
      source?.emit("message", `0:${runningFrame}`);
      await ui.settled();
      await flush();
      expect(calls).toBe(3);
      expect(painted()).toEqual(running);
      expect(resourceError(res.state())).toBeUndefined();

      // Fire the orphaned backoff: the aborted retry must not answer, and a
      // retry that does answer after the frame still loses to fresh truth.
      retryFired = true;

      for (let i = 0; i < 5 && clock.queue.length > 0; i += 1) {
        clock.fire();
      }

      await flush();
      expect(calls).toBe(3);
      expect(painted()).toEqual(running);
      expect(resourceError(res.state())).toBeUndefined();
      expect(readSwr<AppDetail>(keys.appDetail(id))).toEqual(running);
      ui.unmount();
    } finally {
      resetStreamHub();
      FakeSource.reset();
      globalThis.fetch = realFetch;
      globalThis.setTimeout = realSetTimeout;

      if (realEventSource === undefined) {
        delete testGlobals.EventSource;
      } else {
        testGlobals.EventSource = realEventSource;
      }

      delete testGlobals.document;
    }
  });
});
