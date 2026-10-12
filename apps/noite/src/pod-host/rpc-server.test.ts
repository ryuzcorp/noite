/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, eslint/class-methods-use-this, eslint/require-await, unicorn/consistent-function-scoping, unicorn/prefer-add-event-listener -- this file is a test double: the page's half of the port and a scripted frame, so its parsers, its casts and its `on`-handlers are the protocol's own shapes rather than production code */
import { beforeAll, describe, expect, test } from "bun:test";

import { Nodepod } from "@r1ck404/nodepod/headless";
import type { NodepodFS } from "@r1ck404/nodepod/headless";

import type {
  PodEvent,
  PodEventKind,
  PodEventMap,
  PodRequestKind,
  PodRequestMap,
} from "../lib/source/pod-protocol";
import { planPreview } from "../lib/source/preview/plan";
import { writeBase, writeObject } from "../lib/source/workspace/checkout";
import { gitBlobSha } from "../lib/source/workspace/git";
import {
  parentDir,
  BASE_FILE,
  projectPath,
} from "../lib/source/workspace/types";
import type {
  OpenPod,
  OpenPodOpener,
  PodOptions,
} from "../lib/source/workspace/types";
import { installDomFixture } from "../testing/dom";
import type { PreviewStarter } from "./preview-runtime";
import { createPodServer } from "./rpc-server";

beforeAll(() => {
  installDomFixture();
});

const ENCODER = new TextEncoder();
const APP_ID = "app1";
const BRANCH = "main";
/** This document's own origin: what a preview URL has to be on. */
const ORIGIN = "https://app-0.preview.demo.example";
/** The preview URL a fake spawner answers with, on that origin. */
const ON_ORIGIN = `${ORIGIN}/__virtual__/pod/5173/`;
/** How long a test waits for an event before saying the frame never sent it:
 * a safety net, not a wait — the test's own signal is the event. */
const EVENT_TIMEOUT_MS = 3000;
/** How long a request may wait for its answer, for the same reason. */
const CALL_TIMEOUT_MS = 5000;
/** Two zero-filled tar blocks: the end-of-archive marker, and a checkout with
 * nothing in it — enough to prove the archive ask end to end. */
const EMPTY_TAR = new ArrayBuffer(1024);

/** A checkout already in the pod: its files, the committed blob of each, and
 * the base index the commit implies. */
const seed = async (
  fs: NodepodFS,
  files: Record<string, string>,
  baseSha = "tip"
): Promise<void> => {
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      const bytes = ENCODER.encode(text);
      const abs = projectPath(path);
      await fs.mkdir(parentDir(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
      const sha = await gitBlobSha(bytes);
      await writeObject(fs, sha, bytes);
      return [path, { mode: "100644", sha }] as const;
    })
  );
  await writeBase(fs, { baseSha, entries: Object.fromEntries(entries) });
};

/** The control page's half of the port, as a test drives it. */
interface Control {
  /** The refs the frame asked for an archive of, in order. */
  archived: string[];
  events: PodEvent[];
  /** The next event of `kind`, waiting for one if none has arrived. */
  next: <K extends PodEventKind>(kind: K) => Promise<PodEventMap[K]>;
  /** The first event of `kind` that `accept`s — for a frame that reports the
   * same kind more than once (a derive, a preview state), the one the test
   * means, whatever order the buffer holds them in. */
  waitFor: <K extends PodEventKind>(
    kind: K,
    accept: (payload: PodEventMap[K]) => boolean
  ) => Promise<PodEventMap[K]>;
  request: <K extends PodRequestKind>(
    kind: K,
    params?: PodRequestMap[K]["p"]
  ) => Promise<PodRequestMap[K]["r"]>;
  /** A kind the protocol does not have: what the frame answers. */
  unknown: (kind: string) => Promise<string>;
}

/** A port the test drives by hand, entangled with its pair.
 *
 * A real `MessageChannel` works, but in this runtime a message queued on a
 * port is delivered only when the loop is woken by something else — an awaited
 * port message alone is not enough — so a test that waits for an answer
 * sometimes waits until its own timeout. Nothing about that is the frame's
 * behaviour: the server answers every request (traced). This delivers on a
 * microtask instead, which is all the protocol needs: one message at a time,
 * in order. */
class LoopbackPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  peer: LoopbackPort | null = null;

  postMessage(data: unknown): void {
    const { peer } = this;
    queueMicrotask(() => {
      peer?.onmessage?.({ data } as MessageEvent);
    });
  }

  close(): void {
    this.peer = null;
  }

  start(): void {
    // `onmessage` is assigned before anything is sent; nothing to start.
  }
}

/** Two entangled ports: `[frame, page]`, as the server and the page use them. */
const loopback = (): [MessagePort, MessagePort] => {
  const frame = new LoopbackPort();
  const page = new LoopbackPort();
  frame.peer = page;
  page.peer = frame;
  return [frame as unknown as MessagePort, page as unknown as MessagePort];
};

/** Drive the port the way the page's client does: requests out, events and
 * reverse asks in. */
const control = (port: MessagePort): Control => {
  let nextId = 1;
  const archived: string[] = [];
  const calls = new Map<
    number,
    { reject: (error: Error) => void; resolve: (value: unknown) => void }
  >();
  const events: PodEvent[] = [];
  const waiting: {
    accept: (payload: unknown) => boolean;
    kind: string;
    resolve: (payload: unknown) => void;
  }[] = [];

  /** Hand one event to the first waiter that takes it, or keep it for the
   * next `waitFor`. */
  const delivered = (received: PodEvent): void => {
    const wanted = waiting.findIndex(
      (entry) => entry.kind === received.ev && entry.accept(received.p)
    );
    if (wanted === -1) {
      events.push(received);
      return;
    }
    waiting.splice(wanted, 1)[0]?.resolve(received.p);
  };

  /** The first event of `kind` that `accept`s, waiting for one if the frame
   * has not sent it yet. The deadline is a safety net for a frame that never
   * does; the wait itself is on the event. */
  const waitFor = async <K extends PodEventKind>(
    kind: K,
    accept: (payload: PodEventMap[K]) => boolean
  ): Promise<PodEventMap[K]> => {
    const taken = (event: PodEvent): PodEventMap[K] =>
      // SAFETY: the kind's own payload came off this event.
      event.p as PodEventMap[K];
    const found = events.findIndex(
      (event) => event.ev === kind && accept(taken(event))
    );
    if (found !== -1) {
      return taken(events.splice(found, 1)[0] as PodEvent);
    }
    const answeredEvent = Promise.withResolvers<PodEventMap[K]>();
    waiting.push({
      accept: (payload) => accept(payload as PodEventMap[K]),
      kind,
      resolve: (payload) => {
        answeredEvent.resolve(payload as PodEventMap[K]);
      },
    });
    const timer = setTimeout(() => {
      answeredEvent.reject(new Error(`the frame sent no ${kind} event`));
    }, EVENT_TIMEOUT_MS);
    try {
      return await answeredEvent.promise;
    } finally {
      clearTimeout(timer);
    }
  };

  port.onmessage = (event: MessageEvent) => {
    // SAFETY: the frame is this test's own server; its messages are the
    // protocol's own shapes.
    const message = event.data as Record<string, unknown>;
    const { ask } = message;
    if (typeof ask === "string") {
      // SAFETY: `archive` is the protocol's only ask, and its params are the
      // ref's sha.
      const { sha } = message["p"] as { sha: string };
      archived.push(sha);
      port.postMessage({
        answer: message["i"],
        ok: true,
        v: { bytes: EMPTY_TAR },
      });
      return;
    }
    const id = message["i"];
    if (typeof id !== "number") {
      const kind = message["ev"];
      const payload = message["p"];
      if (typeof kind !== "string" || typeof payload !== "object") {
        throw new TypeError(
          `not a protocol message: ${JSON.stringify(message)}`
        );
      }
      // SAFETY: the kind and its payload are the protocol's own (the frame
      // sent them).
      delivered({ ev: kind, p: payload } as PodEvent);
      return;
    }
    const call = calls.get(id);
    calls.delete(id);
    if (message["ok"] === true) {
      call?.resolve(message["v"]);
      return;
    }
    // SAFETY: the frame's failure is the protocol's own error shape.
    const failure = message["e"] as { message?: string };
    call?.reject(new Error(failure.message ?? "the frame failed"));
  };

  return {
    archived,
    events,
    next: <K extends PodEventKind>(kind: K) => waitFor(kind, () => true),
    request: async <K extends PodRequestKind>(
      kind: K,
      params?: PodRequestMap[K]["p"]
    ) => {
      const id = nextId;
      nextId += 1;
      const answered = Promise.withResolvers<PodRequestMap[K]["r"]>();
      // A deadline only so a frame that never answers fails the test with the
      // kind that hung, instead of running to the suite's own timeout.
      const timer = setTimeout(() => {
        calls.delete(id);
        answered.reject(new Error(`${kind}: the frame did not answer`));
      }, CALL_TIMEOUT_MS);
      calls.set(id, {
        reject: (error) => {
          clearTimeout(timer);
          answered.reject(error);
        },
        // SAFETY: the answer belongs to this id, and the frame typed it
        // against the same map.
        resolve: (value) => {
          clearTimeout(timer);
          answered.resolve(value as PodRequestMap[K]["r"]);
        },
      });
      port.postMessage({ i: id, k: kind, p: params });
      return await answered.promise;
    },
    unknown: (kind) => {
      const id = nextId;
      nextId += 1;
      const answered = Promise.withResolvers<string>();
      calls.set(id, {
        reject: (error) => answered.resolve(error.message),
        resolve: () => answered.resolve("answered"),
      });
      port.postMessage({ i: id, k: kind, p: undefined });
      return answered.promise;
    },
    waitFor,
  };
};

/** One frame's server, the pod it was opened on, and what it did to that
 * pod. */
interface Harness {
  control: Control;
  /** Make the pod's metadata writes fail (the settle-after-commit failure). */
  breakMeta: (broken: boolean) => void;
  fs: NodepodFS;
  /** Whether the workspace was closed again. */
  closed: () => boolean;
  /** The hook the frame reported a failed save through. */
  reportSaveError: (error: unknown) => void;
  /** What a spawned preview answered with, and how it was driven. */
  preview: {
    logs: [PodEventMap["preview.log"]["stream"], string][];
    restartFailure?: string;
    url: string;
  };
  /** The pod's own `onPeerChange` notify. */
  peerChanged: (structural: boolean) => void;
}

/** The fake spawner: it reports readiness the way `startPreview` does. */
const fakeStarter =
  (harness: () => Harness): PreviewStarter =>
  async (pod, plan, options) => {
    void pod;
    void plan;
    const script = harness().preview;
    options.onState("installing", "installing the app's dependencies");
    for (const [stream, text] of script.logs) {
      options.onLog(text, stream);
    }
    options.onState("ready", script.url);
    return {
      processes: () => ["npm run dev"],
      restart: () =>
        script.restartFailure === undefined
          ? Promise.resolve()
          : Promise.reject(new Error(script.restartFailure)),
      stop: () => Promise.resolve(),
      url: script.url,
    };
  };

/** Boot the pod the server serves, open the port, and tear it all down. */
const withServer = async (
  run: (harness: Harness) => Promise<void>
): Promise<void> => {
  const pod = await Nodepod.boot();
  // SAFETY: `Object.create` keeps the pod's own prototype methods and lets the
  // test make one of them fail on demand.
  const fs = Object.create(pod.fs) as NodepodFS;
  let breakMeta = false;
  const writeFile = pod.fs.writeFile.bind(pod.fs);
  fs.writeFile = async (path: string, data: string | Uint8Array) => {
    if (breakMeta) {
      throw new Error("the pod's store is full");
    }
    await writeFile(path, data);
  };
  let reportSaveError: (error: unknown) => void = () => {
    throw new Error(
      "the frame reported a save error before a workspace opened"
    );
  };
  let peerChanged: (structural: boolean) => void = () => {
    throw new Error("the frame reported a peer change before one opened");
  };
  let closed = false;
  let openedOnce = false;
  const opener: OpenPodOpener = (opened: PodOptions): Promise<OpenPod> => {
    openedOnce = true;
    reportSaveError = (error) => {
      opened.onSaveError(error);
    };
    return Promise.resolve({
      close: () => {
        closed = true;
        return pod.teardown();
      },
      editable: opened.editable,
      flush: () => Promise.resolve(),
      fs,
      // The notify the frame subscribes to is what the test fires.
      onPeerChange: (notify) => {
        peerChanged = notify;
        return () => {
          peerChanged = () => {};
        };
      },
      persistence: null,
      pod,
    });
  };
  const [port2, port1] = loopback();
  const harness: Harness = {
    breakMeta: (broken) => {
      breakMeta = broken;
    },
    closed: () => closed,
    control: control(port1),
    fs,
    peerChanged: (structural) => {
      peerChanged(structural);
    },
    preview: { logs: [], url: ON_ORIGIN },
    reportSaveError: (error) => {
      reportSaveError(error);
    },
  };
  createPodServer({
    appId: APP_ID,
    branch: BRANCH,
    openPod: opener,
    origin: ORIGIN,
    plan: planPreview,
    port: port2,
    start: fakeStarter(() => harness),
  });
  try {
    await run(harness);
  } finally {
    // The page's own order: the workspace closes (its watchers and derives
    // stop) before the frame — and with it the pod — goes.
    if (openedOnce && !closed) {
      await harness.control.request("close");
    }
    port1.close();
    port2.close();
    if (!closed) {
      await pod.teardown();
    }
  }
};

/** The params a page opens a ref with. */
const opening = (
  sha = "tip",
  files: PodRequestMap["open"]["p"]["files"] = []
) =>
  ({
    appId: APP_ID,
    branch: BRANCH,
    editable: true,
    files,
    sha,
  }) satisfies PodRequestMap["open"]["p"];

describe("the frame's RPC server", () => {
  test("refuses anything before a workspace is open", async () => {
    await withServer(async ({ control: page }) => {
      await expect(page.request("changes")).rejects.toThrow(
        "no workspace is open"
      );
      await expect(page.request("close")).resolves.toBeUndefined();
    });
  });

  test("refuses an unknown kind, and an open for another ref", async () => {
    await withServer(async ({ control: page }) => {
      await expect(page.unknown("fs.snapshot")).resolves.toBe(
        "pod: no request named fs.snapshot"
      );
      await expect(
        page.request("open", { ...opening(), branch: "other" })
      ).rejects.toThrow("another ref");
      await expect(
        page.request("open", { ...opening(), appId: "app2" })
      ).rejects.toThrow("another ref");
    });
  });

  test("checks the ref out from the page's own archive, and answers its rows", async () => {
    await withServer(async ({ control: page }) => {
      const opened = await page.request("open", opening("commit1"));
      // The frame read the ref's archive through the page, and never by
      // itself.
      expect(page.archived).toEqual(["commit1"]);
      expect(opened).toEqual({
        baseSha: "commit1",
        editable: true,
        stale: null,
      });
      // The rows the open derived arrive as an event, before or after the
      // answer; a clean checkout has none.
      expect(await page.next("changes")).toMatchObject({
        baseSha: "commit1",
        changes: [],
        revision: 1,
      });
      await expect(page.request("listing")).resolves.toEqual({
        dirs: [],
        files: [],
      });
    });
  });

  test("restores what the pod holds and reports it stale when the ref moved", async () => {
    await withServer(async ({ control: page, fs }) => {
      await seed(fs, { "a.txt": "one\n" }, "base1");
      await fs.writeFile(projectPath("a.txt"), ENCODER.encode("edited\n"));
      const opened = await page.request("open", opening("commit2"));
      expect(opened).toEqual({
        baseSha: "base1",
        editable: true,
        stale: "commit2",
      });
      expect(await page.next("changes")).toMatchObject({
        baseSha: "base1",
        revision: 1,
      });
      expect(page.archived).toEqual([]);
    });
  });

  test("serves the whole facade, and refuses a read-only ref's writes", async () => {
    await withServer(async ({ control: page, fs }) => {
      await seed(fs, { "a.txt": "one\n" });
      await page.request("open", opening());
      await page.next("changes");

      expect(
        await page.request("fs.exists", { path: projectPath("a.txt") })
      ).toBe(true);
      expect(
        await page.request("fs.read", { path: projectPath("a.txt") })
      ).toEqual(ENCODER.encode("one\n"));
      expect(
        await page.request("fs.stat", { path: projectPath("a.txt") })
      ).toMatchObject({ isDirectory: false, isFile: true, size: 4 });
      expect(
        await page.request("fs.readdir", { path: projectPath("") })
      ).toContain("a.txt");

      await page.request("writeText", { path: "a.txt", text: "two\n" });
      expect(
        await page.waitFor("changes", (payload) => payload.changes.length === 1)
      ).toMatchObject({
        baseSha: "tip",
        changes: [
          { after: "two\n", before: "one\n", kind: "modified", path: "a.txt" },
        ],
      });
      expect(await page.request("baseText", { path: "a.txt" })).toBe("one\n");
      expect(await page.request("changes")).toHaveLength(1);

      await page.request("discard", { path: "a.txt" });
      expect(
        await page.waitFor("changes", (payload) => payload.changes.length === 0)
      ).toMatchObject({ changes: [] });
      await page.request("fs.write", {
        data: ENCODER.encode("three\n"),
        path: projectPath("a.txt"),
      });
      expect(
        await page.waitFor("changes", (payload) => payload.changes.length === 1)
      ).toMatchObject({
        changes: [{ after: "three\n", kind: "modified" }],
      });
      await page.request("discardAll");
      expect(
        await page.waitFor("changes", (payload) => payload.changes.length === 0)
      ).toMatchObject({ changes: [] });

      await page.request("mkdir", { path: "empty" });
      expect(await page.request("listing")).toEqual({
        dirs: ["empty"],
        files: ["a.txt"],
      });
      // A rename is only a row once a derive has run: the panel's `restore`
      // looks the row up by path.
      await page.request("rename", { from: "a.txt", to: "b.txt" });
      expect(
        await page.waitFor(
          "changes",
          (payload) => payload.changes[0]?.kind === "moved"
        )
      ).toMatchObject({
        changes: [{ kind: "moved", movedFrom: "a.txt", path: "b.txt" }],
      });
      await page.request("restore", { path: "b.txt" });
      expect(
        await page.waitFor("changes", (payload) => payload.changes.length === 0)
      ).toMatchObject({ changes: [] });
      // A removal is derived by the verb itself, not by the watcher.
      await page.request("remove", { path: "empty" });
      await page.next("changes");
      await expect(page.request("refresh")).resolves.toBeUndefined();
      await expect(page.request("flush")).resolves.toBeUndefined();
      expect(await page.request("changes")).toEqual([]);
    });

    await withServer(async ({ control: page, fs }) => {
      await seed(fs, { "a.txt": "one\n" });
      await page.request("open", { ...opening(), editable: false });
      expect(await page.next("changes")).toMatchObject({ revision: 1 });
      await expect(
        page.request("writeText", { path: "a.txt", text: "x" })
      ).rejects.toThrow("read-only");
      await expect(
        page.request("fs.write", {
          data: ENCODER.encode("x"),
          path: projectPath("a.txt"),
        })
      ).rejects.toThrow("read-only");
    });
  });

  test("follows a path the page watches, and stops when it unwatches", async () => {
    await withServer(async ({ control: page, fs }) => {
      await seed(fs, { "a.txt": "one\n" });
      await page.request("open", opening());
      const { watchId } = await page.request("fs.watch", {
        path: projectPath(""),
        recursive: true,
      });
      await fs.writeFile(projectPath("a.txt"), ENCODER.encode("watched\n"));
      // The pod's own watcher reports the checkout-relative name and the
      // event it saw.
      expect(await page.next("fs.event")).toMatchObject({
        event: "change",
        filename: "a.txt",
        watchId,
      });
      await page.request("fs.unwatch", { watchId });
      await fs.writeFile(projectPath("a.txt"), ENCODER.encode("quiet\n"));
      // A round trip on the same port is ordered after anything that write
      // emitted: whatever the watcher would have said is here by now.
      await page.request("refresh");
      expect(page.events.filter((event) => event.ev === "fs.event")).toEqual(
        []
      );
    });
  });

  test("streams the pod's own reports: a failed save, a peer's edits", async () => {
    await withServer(
      async ({ control: page, fs, peerChanged, reportSaveError }) => {
        await seed(fs, { "a.txt": "one\n" });
        await page.request("open", opening());
        reportSaveError(new Error("QuotaExceededError"));
        expect(await page.next("saveError")).toEqual({
          message: "QuotaExceededError",
        });
        peerChanged(true);
        expect(await page.next("peer")).toEqual({ structural: true });
      }
    );
  });

  test("pushes through the page's own commit, and settles on what it answers", async () => {
    await withServer(async ({ control: page, fs }) => {
      await seed(fs, { "a.txt": "one\n" });
      await page.request("open", opening());
      // The open's own derive, before anything is written.
      expect(await page.next("changes")).toMatchObject({ revision: 1 });
      await page.request("writeText", { path: "a.txt", text: "pushed\n" });
      expect(
        await page.waitFor("changes", (payload) => payload.changes.length === 1)
      ).toMatchObject({ revision: 2 });

      const { payload } = await page.request("push.prepare", {
        message: "a push",
        target: BRANCH,
      });
      expect(payload).toEqual({
        deletes: [],
        files: [{ content: "pushed\n", path: "a.txt" }],
        moves: [],
      });
      // The pod is not settled until the page says how its commit went.
      expect(await page.request("changes")).toHaveLength(1);
      await page.request("push.settle", {
        ok: true,
        sha: "commit2",
        target: BRANCH,
      });
      expect(
        await page.waitFor("changes", (rows) => rows.baseSha === "commit2")
      ).toMatchObject({
        baseSha: "commit2",
        changes: [],
      });
      expect(await fs.readFile(projectPath("a.txt"), "utf-8")).toBe("pushed\n");
    });
  });

  test("leaves the pod as it was when the page's commit failed", async () => {
    await withServer(async ({ control: page, fs }) => {
      await seed(fs, { "a.txt": "one\n" });
      await page.request("open", opening());
      await page.next("changes");
      await page.request("writeText", { path: "a.txt", text: "pushed\n" });
      await page.waitFor("changes", (payload) => payload.changes.length === 1);
      await page.request("push.prepare", {
        message: "a push",
        target: BRANCH,
      });
      await page.request("push.settle", {
        error: "the branch moved",
        ok: false,
        target: BRANCH,
      });
      expect(await page.request("changes")).toHaveLength(1);
      const base = await fs.readFile(BASE_FILE, "utf-8");
      expect(base).toContain('"tip"');
    });
  });

  test("refuses a second push at once, and a settle with no push", async () => {
    await withServer(async ({ control: page, fs }) => {
      await seed(fs, { "a.txt": "one\n" });
      await page.request("open", opening());
      await page.next("changes");
      await page.request("writeText", { path: "a.txt", text: "pushed\n" });
      await page.waitFor("changes", (payload) => payload.changes.length === 1);
      await expect(
        page.request("push.settle", { ok: true, sha: "x", target: BRANCH })
      ).rejects.toThrow("no push is waiting to settle");
      await page.request("push.prepare", { message: "a push", target: BRANCH });
      await expect(
        page.request("push.prepare", { message: "again", target: BRANCH })
      ).rejects.toThrow("a push is already in flight");
      await page.request("push.settle", {
        ok: true,
        sha: "commit2",
        target: BRANCH,
      });
      expect(
        await page.waitFor("changes", (rows) => rows.baseSha === "commit2")
      ).toMatchObject({ baseSha: "commit2" });
    });
  });

  test("says so in the page's words when a committed push cannot settle", async () => {
    await withServer(async ({ control: page, fs, breakMeta }) => {
      await seed(fs, { "a.txt": "one\n" });
      await page.request("open", opening());
      await page.next("changes");
      await page.request("writeText", { path: "a.txt", text: "pushed\n" });
      await page.waitFor("changes", (payload) => payload.changes.length === 1);
      await page.request("push.prepare", { message: "a push", target: BRANCH });
      breakMeta(true);
      await page.request("push.settle", {
        ok: true,
        sha: "commit2",
        target: BRANCH,
      });
      // The commit landed, so the push itself answered; what could not settle
      // is the frame's own, and nobody else can report it.
      expect(await page.next("fatal")).toEqual({
        message:
          "The push landed, but settling the workspace failed: the pod's store is full",
      });
    });
  });

  test("gives the page a shell that echoes what it types", async () => {
    await withServer(async ({ control: page, fs }) => {
      await seed(fs, { "a.txt": "one\n" });
      await page.request("open", opening());
      const opened = await page.request("terminal.open", {
        cols: 100,
        rows: 30,
      });
      expect(opened).toEqual({ sessionId: 1 });
      const prompt = await page.next("terminal.write");
      expect(prompt.data).toEndWith("$ ");
      await page.request("terminal.input", { data: "l" });
      const echo = await page.next("terminal.write");
      expect(echo.data).toBe("l");
      await page.request("terminal.resize", { cols: 120, rows: 40 });
      await page.request("terminal.close");
      await page.request("terminal.input", { data: "gone" });
      // The answer means the input was served; a write would have been posted
      // before it.
      expect(
        page.events.filter((event) => event.ev === "terminal.write")
      ).toEqual([]);
    });
  });

  test("runs the preview the page asked for, and streams its state and log", async () => {
    await withServer(async ({ control: page, fs, preview }) => {
      await seed(fs, {
        "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      });
      preview.logs = [["stdout", "ready in 120ms"]];
      await page.request("open", opening());
      await expect(page.request("preview.view")).resolves.toMatchObject({
        logs: [],
        state: "idle",
        url: "",
      });
      await page.request("preview.open");
      expect(await page.next("preview.log")).toEqual({
        stream: "stdout",
        text: "ready in 120ms",
      });
      const view = await page.request("preview.view");
      expect(view.state).toBe("ready");
      expect(view.url).toBe(ON_ORIGIN);
      expect(view.processes).toEqual(["npm run dev"]);
      await page.request("preview.stop");
      expect(
        await page.waitFor(
          "preview.state",
          (payload) => payload.state === "idle"
        )
      ).toMatchObject({ state: "idle" });
      await page.request("preview.restart");
      // The verb's own answer is the view after it: the panel gets the same
      // news as an event, and this is the deterministic half.
      await expect(page.request("preview.view")).resolves.toMatchObject({
        state: "ready",
        url: ON_ORIGIN,
      });
      await expect(page.request("preview.close")).resolves.toMatchObject({
        state: "idle",
        url: "",
      });
    });
  });

  test("tears the pod down on close, and refuses everything after", async () => {
    await withServer(async ({ control: page, closed, fs }) => {
      await seed(fs, { "a.txt": "one\n" });
      await page.request("open", opening());
      await expect(page.request("close")).resolves.toBeUndefined();
      expect(closed()).toBe(true);
      await expect(page.request("changes")).rejects.toThrow(
        "no workspace is open"
      );
    });
  });
});
