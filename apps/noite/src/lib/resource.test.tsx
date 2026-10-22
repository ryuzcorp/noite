/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- test doubles: the fake document and DOM stand in for the browser globals render needs, like the fixture in feeds.test.tsx */
/* eslint-disable eslint/max-classes-per-file, eslint/no-use-before-define -- test doubles reference each other circularly, like the fixture in feeds.test.tsx */
import { describe, expect, test } from "bun:test";

import { watch } from "ilha";
import { render } from "ilha/test";

import { tracked } from "./resource";
import type { Resource } from "./resource";

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

/** Deterministic retry clock: the mount retry queues here instead of on the
 * event loop, so the test fires retries by hand and never sleeps. */
const installManualTimers = () => {
  const queue: (() => void)[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void): number => {
    queue.push(handler);

    return queue.length;
  }) as typeof setTimeout;

  return {
    fire: (): void => {
      const due = queue.splice(0);

      for (const run of due) {
        run();
      }
    },
    pending: (): number => queue.length,
    restore: (): void => {
      globalThis.setTimeout = realSetTimeout;
    },
  };
};

/** Unique resource keys: the shared cache and snapshots persist per file. */
let fetchKey = 0;

const nextKey = (): string => {
  fetchKey += 1;

  return `resource:test:mount-retry:${fetchKey}`;
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
  const res = tracked<string[]>(probeKey, probeFetch, { mountRetryMs: 1000 });
  captured = res;
  watch(res.data, (value) => {
    if (value !== undefined) {
      signalPainted?.(value);
    }
  });
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- the probe reports the settle through a reactive subscription, not a deferred callback
  watch(res.loading, (loading) => {
    if (!loading) {
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

const resetSignals = (): void => {
  signalPainted = undefined;
  signalSettled = undefined;
};

describe("tracked mount retry", () => {
  test("a failed mount load retries with a fresh lookup and paints", async () => {
    const restoreDom = installDomFixture();
    const timers = installManualTimers();

    try {
      let calls = 0;
      probeKey = nextKey();
      probeFetch = () => {
        calls += 1;

        return calls === 1
          ? Promise.reject(new Error("Request timed out"))
          : Promise.resolve(["fresh"]);
      };

      const painted = nextPainted();
      const settledOnce = nextSettled();
      const ui = render(ResourceProbe);

      try {
        await ui.settled();
        await settledOnce;
        await ui.settled();
        expect(calls).toBe(1);
        expect(captured?.data()).toBeUndefined();
        expect(timers.pending()).toBe(1);

        timers.fire();
        expect(await painted).toEqual(["fresh"]);
        await ui.settled();
        expect(calls).toBe(2);
        expect(captured?.data()).toEqual(["fresh"]);
        expect(captured?.error()).toBeUndefined();
        expect(captured?.loading()).toBe(false);
        expect(timers.pending()).toBe(0);
      } finally {
        ui.unmount();
      }
    } finally {
      resetSignals();
      timers.restore();
      restoreDom();
    }
  });

  test("a persistently failing mount load settles the error after bounded retries", async () => {
    const restoreDom = installDomFixture();
    const timers = installManualTimers();

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
        expect(calls).toBe(1);

        const settledTwice = nextSettled();
        timers.fire();
        await settledTwice;
        await ui.settled();
        expect(calls).toBe(2);

        const settledThrice = nextSettled();
        timers.fire();
        await settledThrice;
        await ui.settled();
        expect(calls).toBe(3);
        expect(captured?.data()).toBeUndefined();
        expect(captured?.error()).toBeInstanceOf(Error);
        expect(captured?.loading()).toBe(false);
        expect(timers.pending()).toBe(0);
      } finally {
        ui.unmount();
      }
    } finally {
      resetSignals();
      timers.restore();
      restoreDom();
    }
  });

  test("an unmounted reader stands its retry down", async () => {
    const restoreDom = installDomFixture();
    const timers = installManualTimers();

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
      const ui = render(ResourceProbe);
      await ui.settled();
      await settledOnce;
      await ui.settled();
      expect(timers.pending()).toBe(1);

      ui.unmount();
      timers.fire();
      await ui.settled();
      expect(calls).toBe(1);
    } finally {
      resetSignals();
      timers.restore();
      restoreDom();
    }
  });

  test("a successful mount load fetches once", async () => {
    const restoreDom = installDomFixture();
    const timers = installManualTimers();

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
        expect(timers.pending()).toBe(0);
      } finally {
        ui.unmount();
      }
    } finally {
      resetSignals();
      timers.restore();
      restoreDom();
    }
  });
});
