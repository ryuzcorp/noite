/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- test doubles: the fake document and DOM stand in for the browser globals render needs, like the fixture in feeds.test.tsx */
/* eslint-disable eslint/max-classes-per-file, eslint/no-use-before-define -- test doubles reference each other circularly, like the fixture in feeds.test.tsx */
import { describe, expect, test } from "bun:test";

import * as Atom from "effect/reactivity/Atom";
import { atom, watch } from "ilha";
import { render } from "ilha/test";

import {
  invalidate,
  nextResourceState,
  resetResource,
  resourceError,
  resourceValue,
  tracked,
} from "./resource";
import type { Resource, ResourceState } from "./resource";
import { clearSwrStore, readSwr, writeSwr } from "./swr-store";

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

const installDomFixture = (): (() => void) => {
  const document = {
    activeElement: null,
    body: new FakeElement("body"),
    createComment: (data: string): FakeCharacterData =>
      new FakeCharacterData(data),
    createDocumentFragment: (): FakeNode => new FakeNode(),
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string): FakeElement =>
      new FakeElement(tag),
    createTextNode: (data: string): FakeCharacterData =>
      new FakeCharacterData(data),
  };

  const globals = globalThis as unknown as {
    document?: unknown;
    window?: unknown;
    HTMLElement?: unknown;
    Element?: unknown;
    Node?: unknown;
  };

  globals.document = document;
  globals.window = {};
  globals.HTMLElement = FakeElement;
  globals.Element = FakeNode;
  globals.Node = FakeNode;

  return () => {
    delete globals.document;
    delete globals.window;
    delete globals.HTMLElement;
    delete globals.Element;
    delete globals.Node;
  };
};

/** Unique resource keys: the shared cache and snapshots persist per file. */
let fetchKey = 0;

const nextKey = (): string => {
  fetchKey += 1;

  return `resource:test:mount-evict:${fetchKey}`;
};

let captured: Resource<string[]> | undefined;
let signalPainted: ((value: string[]) => void) | undefined;
let signalSettled: (() => void) | undefined;

/** Probe inputs: `render` takes the component itself, so each test sets these
 * before mounting (like the feed probes in feeds.test.tsx). */
let probeKey = "";
let probeFetch: () => Promise<string[]> = () => Promise.resolve([]);

/** A mounted `tracked` reader reporting its paint and failure as signals. */
const ResourceProbe = () => {
  const res = tracked<string[]>(probeKey, probeFetch);
  captured = res;
  watch(res.value, (value) => {
    if (value !== undefined) {
      signalPainted?.(value);
    }
  });

  // ilha's `watch` only takes WatchValues, and a resource state carries an
  // `unknown` error; the settled bit is the one reactive projection needed.
  const settled = atom(
    Atom.readable((get) => get(res.state.atom)._tag !== "Loading")
  );

  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- the probe reports the settle through a reactive subscription, not a deferred callback
  watch(settled, (done) => {
    if (done) {
      signalSettled?.();
    }
  });

  return <span />;
};

const nextPainted = (): Promise<string[]> =>
  // oxlint-disable-next-line promise/avoid-new -- the test resolves on the painted signal, never a sleep
  new Promise<string[]>((resolve) => {
    signalPainted = resolve;
  });

const nextSettled = (): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- the test resolves on the settle signal, never a sleep
  new Promise<void>((resolve) => {
    signalSettled = resolve;
  });

const capturedState = (): ResourceState<string[]> => {
  if (captured === undefined) {
    throw new Error("the probe captured no resource");
  }

  return captured.state();
};

const resetSignals = (): void => {
  signalPainted = undefined;
  signalSettled = undefined;
};

/** Let the Effect runtime's promises settle (microtasks, not a wall clock). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- draining microtasks in order
    await Promise.resolve();
  }
};

describe("account epoch", () => {
  test("a lookup that started before an auth reset never writes the old account's snapshot", async () => {
    const restoreDom = installDomFixture();

    try {
      const key = nextKey();
      const slow = Promise.withResolvers<string[]>();
      let calls = 0;
      probeKey = key;
      probeFetch = () => {
        calls += 1;

        return calls === 1 ? slow.promise : Promise.resolve(["account-b"]);
      };

      const ui = render(ResourceProbe);
      await ui.settled();
      expect(calls).toBe(1);

      // The account changes while account A's fetch is still in flight:
      // resetUserCaches() forgets the store and reloads every key.
      clearSwrStore();
      const settledAgain = nextSettled();
      invalidate(key);
      await settledAgain;
      await ui.settled();
      expect(calls).toBe(2);

      // Account A's response lands late: it must not overwrite B's snapshot.
      slow.resolve(["account-a"]);
      await flush();

      expect(readSwr<string[]>(key)).toEqual(["account-b"]);
      ui.unmount();
    } finally {
      resetSignals();
      restoreDom();
    }
  });

  test("a late lookup writes nothing once the store was forgotten", async () => {
    const restoreDom = installDomFixture();

    try {
      const key = nextKey();
      const slow = Promise.withResolvers<string[]>();
      probeKey = key;
      probeFetch = () => slow.promise;

      const ui = render(ResourceProbe);
      await ui.settled();

      // No reload: only the store reset (the panel is gone with the user).
      clearSwrStore();
      ui.unmount();
      slow.resolve(["account-a"]);
      await flush();

      expect(readSwr<string[]>(key)).toBeUndefined();
    } finally {
      resetSignals();
      restoreDom();
    }
  });
});

describe("auth reset", () => {
  test("a reset blanks the reader to cold instead of painting the old value", async () => {
    const restoreDom = installDomFixture();

    try {
      const key = nextKey();
      const slow = Promise.withResolvers<string[]>();
      let calls = 0;
      probeKey = key;
      probeFetch = () => {
        calls += 1;

        return calls === 1 ? Promise.resolve(["account-a"]) : slow.promise;
      };

      const painted = nextPainted();
      const ui = render(ResourceProbe);
      expect(await painted).toEqual(["account-a"]);
      await ui.settled();

      const settledAgain = nextSettled();
      resetResource(key);
      await ui.settled();

      // Immediately after the reset the reader is cold: no A value, no
      // "reloading with A" paint while B's fetch is in flight.
      expect(resourceValue(capturedState())).toBeUndefined();
      expect(capturedState()._tag).toBe("Loading");

      slow.resolve(["account-b"]);
      await settledAgain;
      expect(resourceValue(capturedState())).toEqual(["account-b"]);
      ui.unmount();
    } finally {
      resetSignals();
      restoreDom();
    }
  });
});

describe("resource state machine", () => {
  test("a reload and a failure keep the last value; only a cold load is Loading", () => {
    const loaded = nextResourceState<string[]>(
      { _tag: "Loading" },
      { kind: "loaded", value: ["a"] }
    );

    expect(loaded._tag).toBe("Ready");

    const reloading = nextResourceState(loaded, { kind: "reload" });
    expect(reloading).toEqual({ _tag: "Reloading", value: ["a"] });

    const failed = nextResourceState<string[]>(reloading, {
      error: new Error("D1 is down"),
      kind: "failed",
    });

    expect(failed._tag).toBe("Failed");
    expect(resourceValue(failed)).toEqual(["a"]);
    expect(resourceError(failed)).toBeInstanceOf(Error);

    // A cold reload is the only skeleton.
    expect(
      nextResourceState<string[]>({ _tag: "Loading" }, { kind: "reload" })._tag
    ).toBe("Loading");
  });
});

describe("tracked mount failures", () => {
  test("a failed mount load surfaces the error and never retries on its own", async () => {
    const restoreDom = installDomFixture();

    try {
      let calls = 0;
      probeKey = nextKey();
      probeFetch = () => {
        calls += 1;

        return Promise.reject(new Error("Request timed out"));
      };

      const settledOnce = nextSettled();
      const ui = render(ResourceProbe);

      try {
        await ui.settled();
        await settledOnce;
        await ui.settled();
        expect(calls).toBe(1);
        expect(resourceValue(capturedState())).toBeUndefined();
        expect(resourceError(capturedState())).toBeInstanceOf(Error);
        expect(capturedState()._tag).not.toBe("Loading");
      } finally {
        ui.unmount();
      }
    } finally {
      resetSignals();
      restoreDom();
    }
  });

  test("a failed mount load evicts the failure so a remount refetches", async () => {
    const restoreDom = installDomFixture();

    try {
      let calls = 0;
      probeKey = nextKey();
      probeFetch = () => {
        calls += 1;

        return calls === 1
          ? Promise.reject(new Error("Request timed out"))
          : Promise.resolve(["fresh"]);
      };

      const settledOnce = nextSettled();
      const first = render(ResourceProbe);

      try {
        await first.settled();
        await settledOnce;
        await first.settled();
        expect(calls).toBe(1);
        expect(resourceError(capturedState())).toBeInstanceOf(Error);
      } finally {
        first.unmount();
      }

      // The failure was evicted when it landed, so mounting the same key
      // again starts a fresh lookup instead of re-serving the error.
      const painted = nextPainted();
      const second = render(ResourceProbe);

      try {
        await second.settled();
        expect(await painted).toEqual(["fresh"]);
        await second.settled();
        expect(calls).toBe(2);
        expect(resourceValue(capturedState())).toEqual(["fresh"]);
        expect(resourceError(capturedState())).toBeUndefined();
        expect(capturedState()._tag).not.toBe("Loading");
      } finally {
        second.unmount();
      }
    } finally {
      resetSignals();
      restoreDom();
    }
  });

  test("a reader seeded from a stale snapshot repaints the fresh fetch", async () => {
    const restoreDom = installDomFixture();

    try {
      const key = nextKey();
      // What a reload paints first: the previous document's last-good value
      // (an invitation the other browser has since accepted).
      writeSwr(key, ["accepted-invite"]);
      probeKey = key;
      probeFetch = () => Promise.resolve([]);

      const fresh = Promise.withResolvers<string[]>();
      signalPainted = (value) => {
        if (value.length === 0) {
          fresh.resolve(value);
        }
      };

      const ui = render(ResourceProbe);

      try {
        await ui.settled();
        expect(await fresh.promise).toEqual([]);
        expect(readSwr<string[]>(key)).toEqual([]);
      } finally {
        ui.unmount();
      }
    } finally {
      resetSignals();
      restoreDom();
    }
  });

  test("a successful mount load fetches once", async () => {
    const restoreDom = installDomFixture();

    try {
      let calls = 0;
      probeKey = nextKey();
      probeFetch = () => {
        calls += 1;

        return Promise.resolve(["rows"]);
      };

      const painted = nextPainted();
      const ui = render(ResourceProbe);

      try {
        await ui.settled();
        expect(await painted).toEqual(["rows"]);
        expect(calls).toBe(1);
      } finally {
        ui.unmount();
      }
    } finally {
      resetSignals();
      restoreDom();
    }
  });
});
