/** The workspace proxy over a scripted frame.
 *
 * The fake frame is a real RPC server on the other end of a `MessageChannel`
 * pair — the same transport the page uses — so these tests exercise the
 * protocol as it is written: request ids, `{i, ok, v|e}` answers, events, and
 * the reverse `archive` ask. They cover what the proxy itself owns (write
 * coalescing, the event fan-out, the control-initiated push, the teardown
 * order) and the failure paths a frame can put it in. Nothing here waits on a
 * clock: every wait is the signal the code under test produces — the promise
 * it returns, an event it delivered, a request the frame received. */

/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, eslint/require-await, promise/prefer-await-to-callbacks, typescript/no-invalid-void-type, unicorn/prefer-add-event-listener -- a test double for the port protocol: a message off a `MessagePort` is I/O (its fields are read and checked here), the scripted handlers are untyped by construction, a `void` resolution is a signal with no value, `onmessage` is what starts the port (a listener would need an explicit `start()`), and `refusal` captures a rejection explicitly because bun 1.4.3's `rejects` matcher never settles for a `MessagePort`-delivered rejection that follows another await. */
import { describe, expect, test } from "bun:test";

import { errorMessage } from "../../errors";
import { bindPodPort } from "../pod-client";
import type { PodConnection, PodFrameOptions } from "../pod-client";
import type {
  PodEventMap,
  PushPayload,
  WorkspaceChange,
} from "../pod-protocol";
import { projectPath } from "../workspace/types";
import { openSourceWorkspace } from "./proxy";
import type { SourceCheckout } from "./proxy";

const APP_ID = "app-1";
const PREVIEW_ORIGIN = "https://app-0.preview.example";
const SHA = "c0ffee1";

/** One request the page sent the frame. */
interface SentRequest {
  k: string;
  p: unknown;
}

/** A scripted frame: it answers the kinds a test registered, withholds the
 * ones a test holds, records everything it was asked, and can emit events or
 * ask the control back — all over a real port. */
interface FakeFrame {
  answer: (kind: string, handler: () => unknown) => void;
  /** Ask the control for a ref's archive, as the frame does while `open`
   * runs. */
  askArchive: (sha: string) => Promise<Uint8Array>;
  emit: <K extends keyof PodEventMap>(kind: K, payload: PodEventMap[K]) => void;
  /** Withhold a kind's answers until the returned function answers all of
   * them, oldest first. */
  hold: (kind: string) => () => void;
  /** Resolves once the frame has received its `count`th request of `kind`. */
  received: (kind: string, count?: number) => Promise<void>;
  readonly requests: SentRequest[];
}

/** What the frame received: one of the page's requests, or one of the frame's
 * own asks coming back answered. */
const readMessage = (
  value: unknown
):
  | { answer: number; bytes: unknown; error: string; ok: boolean }
  | { i: number; k: string; p: unknown }
  | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const fields = new Map(Object.entries(value));
  const answer = fields.get("answer");

  if (typeof answer === "number") {
    const v = fields.get("v");

    const bytes =
      typeof v === "object" && v !== null
        ? new Map(Object.entries(v)).get("bytes")
        : undefined;

    const e = fields.get("e");

    return {
      answer,
      bytes,
      error:
        typeof e === "object" && e !== null
          ? String(new Map(Object.entries(e)).get("message"))
          : "the control refused the archive",
      ok: fields.get("ok") === true,
    };
  }

  const i = fields.get("i");
  const k = fields.get("k");

  if (typeof i === "number" && typeof k === "string") {
    return { i, k, p: fields.get("p") };
  }

  return null;
};

/** A test waiting for the nth request of one kind. */
interface Arrival {
  count: number;
  resolve: () => void;
}

const newFakeFrame = (port: MessagePort): FakeFrame => {
  const requests: SentRequest[] = [];
  const handlers = new Map<string, () => unknown>();
  /** The kinds whose answers wait for `hold`'s release, and the ids held. */
  const withheld = new Map<string, number[]>();
  const archiveAsks = new Map<number, PromiseWithResolvers<Uint8Array>>();
  const arrived = new Map<string, Arrival[]>();
  let nextAsk = 1;

  const send = (message: unknown): void => port.postMessage(message);

  const announce = (kind: string): void => {
    const count = requests.filter((request) => request.k === kind).length;
    const waiting = arrived.get(kind) ?? [];

    for (const arrival of waiting) {
      if (arrival.count <= count) {
        arrival.resolve();
      }
    }

    arrived.set(
      kind,
      waiting.filter((arrival) => arrival.count > count)
    );
  };

  const respond = async (i: number, k: string): Promise<void> => {
    const held = withheld.get(k);

    if (held !== undefined) {
      held.push(i);

      return;
    }

    const handler = handlers.get(k);

    if (handler === undefined) {
      send({ e: { message: `unhandled ${k}` }, i, ok: false });

      return;
    }

    try {
      send({ i, ok: true, v: await handler() });
    } catch (error) {
      send({ e: { message: errorMessage(error) }, i, ok: false });
    }
  };

  port.onmessage = (event: MessageEvent) => {
    const message = readMessage(event.data);

    if (message === null) {
      return;
    }

    if ("answer" in message) {
      const pending = archiveAsks.get(message.answer);
      archiveAsks.delete(message.answer);

      if (message.ok && message.bytes instanceof ArrayBuffer) {
        pending?.resolve(new Uint8Array(message.bytes));
      } else {
        pending?.reject(new Error(message.error));
      }

      return;
    }

    requests.push({ k: message.k, p: message.p });
    // The answer goes out before a waiting test is told the request arrived:
    // the response is then queued ahead of anything the test sends next, which
    // is the ordering the real frame gives too (its answer is on the port
    // before any later control message).
    void respond(message.i, message.k);
    announce(message.k);
  };

  return {
    answer: (kind, handler) => {
      handlers.set(kind, handler);
    },
    askArchive: (sha) => {
      const id = nextAsk;
      nextAsk += 1;
      const answered = Promise.withResolvers<Uint8Array>();
      archiveAsks.set(id, answered);
      send({ ask: "archive", i: id, p: { sha } });

      return answered.promise;
    },
    emit: (kind, payload) => {
      send({ ev: kind, p: payload });
    },
    hold: (kind) => {
      // The kind's handler (if a test registered one) stays: releasing a hold
      // answers what was held, and the requests that follow still go to it.
      withheld.set(kind, []);

      return () => {
        const held = withheld.get(kind) ?? [];
        withheld.delete(kind);

        for (const i of held) {
          send({ i, ok: true, v: undefined });
        }
      };
    },
    received: (kind, count = 1) => {
      const seen = requests.filter((request) => request.k === kind).length;

      if (seen >= count) {
        return Promise.resolve();
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      arrived.set(kind, [...(arrived.get(kind) ?? []), { count, resolve }]);

      return promise;
    },
    requests,
  };
};

/** A frame plus the things its answers are judged on. */
interface Opened {
  /** What the page read the ref's archive as. */
  readonly archives: string[];
  /** Whether the frame's document was torn down. */
  disposed: () => boolean;
  checkpoint: SourceCheckout;
  frame: FakeFrame;
  /** The first failure the page reported as a failed save. */
  readonly saveReported: Promise<string>;
  /** What the page reported as a failed save. */
  readonly saveErrors: string[];
}

/** The rows one derive published. */
const row = (path: string): WorkspaceChange => ({
  after: `${path}\n`,
  before: "",
  kind: "added",
  path,
});

/** The frame's `open` answer, with the first derive an open always publishes
 * before it answers. */
const openAnswer =
  (frame: FakeFrame) =>
  (): { baseSha: string; editable: boolean; stale: string | null } => {
    frame.emit("changes", { baseSha: SHA, changes: [], revision: 1 });

    return { baseSha: SHA, editable: true, stale: null };
  };

/** Open a workspace over a scripted frame. `beforeOpen` runs with the frame
 * before the open, so a test can script the answer (or an ask) itself. */
const open = async (options?: {
  beforeOpen?: (frame: FakeFrame) => void;
  editable?: boolean;
  sha?: string;
}): Promise<Opened> => {
  const { port1, port2 } = new MessageChannel();
  const frame = newFakeFrame(port2);
  const archives: string[] = [];
  const saveErrors: string[] = [];
  const firstSaveError = Promise.withResolvers<string>();
  let disposed = false;
  frame.answer("open", openAnswer(frame));
  frame.answer("close", () => {});
  frame.answer("flush", () => {});
  options?.beforeOpen?.(frame);

  const checkpoint = await openSourceWorkspace({
    appId: APP_ID,
    branch: "main",
    editable: options?.editable ?? true,
    fetchArchive: (ref) => {
      archives.push(ref);

      return Promise.resolve(new Uint8Array([1, 2, 3, 4]));
    },
    files: [],
    onSaveError: (error) => {
      const message = errorMessage(error);
      saveErrors.push(message);
      firstSaveError.resolve(message);
    },
    openFrame: (frameOptions: PodFrameOptions): Promise<PodConnection> =>
      Promise.resolve(
        bindPodPort({
          dispose: () => {
            disposed = true;
          },
          onAsk: frameOptions.onAsk,
          onFatal: frameOptions.onFatal,
          port: port1,
        })
      ),
    previewOrigin: PREVIEW_ORIGIN,
    sha: options?.sha ?? SHA,
  });

  return {
    archives,
    checkpoint,
    disposed: () => disposed,
    frame,
    saveErrors,
    saveReported: firstSaveError.promise,
  };
};

/** Every `fs.write` the frame received, oldest first. */
const writes = (frame: FakeFrame): { data: unknown; path: unknown }[] =>
  frame.requests
    .filter((request) => request.k === "fs.write")
    .map(
      (request) =>
        // SAFETY: the frame received this kind's own params; the test reads the
        // two fields it asserts on.
        (request.p ?? {}) as { data: unknown; path: unknown }
    );

/** The kinds the frame was asked for, in order. */
const kinds = (frame: FakeFrame): string[] =>
  frame.requests.map((request) => request.k);

/** The message a promise refused with, or null when it resolved.
 *
 * An explicit capture rather than `expect(promise).rejects`: against bun
 * 1.4.3 that matcher never settles for a rejection a `MessagePort` delivered
 * *after* another await in the same test (the test times out while the
 * promise's own refusal is there), which is a runner quirk, not a property of
 * the code under test. */
const refusal = async (promise: Promise<unknown>): Promise<string | null> =>
  promise.then(
    () => null,
    (error: unknown) => errorMessage(error)
  );

/** What the frame was asked to settle the push with. */
const settles = (frame: FakeFrame): unknown[] =>
  frame.requests
    .filter((request) => request.k === "push.settle")
    .map((request) => request.p);

describe("open", () => {
  test("the frame's first derive is the workspace's own state", async () => {
    const { checkpoint, frame } = await open();
    expect(checkpoint.workspace.baseSha).toBe(SHA);
    expect(checkpoint.workspace.editable).toBe(true);
    expect(checkpoint.workspace.stale).toBeNull();
    expect(checkpoint.workspace.changes()).toEqual([]);
    expect(frame.requests[0]).toEqual({
      k: "open",
      p: {
        appId: APP_ID,
        branch: "main",
        editable: true,
        files: [],
        sha: SHA,
      },
    });
  });

  test("an archive asked for while the open is in flight is answered with the ref's bytes", async () => {
    const received: number[] = [];

    const { archives, checkpoint, frame } = await open({
      beforeOpen: (scripted) => {
        scripted.answer("open", async () => {
          const bytes = await scripted.askArchive("deadbeef");
          received.push(bytes.byteLength);
          scripted.emit("changes", { baseSha: SHA, changes: [], revision: 1 });

          return { baseSha: SHA, editable: true, stale: null };
        });
      },
    });

    // The frame asked, the page read the ref, and the bytes came back.
    expect(archives).toEqual(["deadbeef"]);
    expect(received).toEqual([4]);
    expect(checkpoint.workspace.baseSha).toBe(SHA);
    expect(kinds(frame)).toEqual(["open"]);
  });

  test("an archive asked for outside an open is refused", async () => {
    const { archives, frame } = await open();
    expect(await refusal(frame.askArchive("deadbeef"))).toContain(
      "outside an open"
    );
    expect(archives).toEqual([]);
  });
});

describe("write coalescing", () => {
  test("a keystroke burst is one write in flight with the latest text behind it", async () => {
    const { checkpoint, frame } = await open();
    frame.answer("fs.write", () => {});
    const release = frame.hold("fs.write");

    const typed = [
      checkpoint.workspace.writeText("src/a.ts", "a"),
      checkpoint.workspace.writeText("src/a.ts", "ab"),
      checkpoint.workspace.writeText("src/a.ts", "abc"),
    ];

    await frame.received("fs.write");
    // One write went out; the two later keystrokes are the pending value.
    expect(writes(frame)).toEqual([
      { data: "a", path: projectPath("src/a.ts") },
    ]);

    release();
    await frame.received("fs.write", 2);
    // The burst is two writes, not three: the latest text is what lands.
    expect(writes(frame).map((write) => write.data)).toEqual(["a", "abc"]);
    await Promise.all(typed);
  });

  test("another path's write does not wait behind a held one", async () => {
    const { checkpoint, frame } = await open();
    frame.answer("fs.write", () => {});
    const release = frame.hold("fs.write");
    const first = checkpoint.workspace.writeText("src/a.ts", "a");
    const second = checkpoint.workspace.writeText("src/b.ts", "b");
    await frame.received("fs.write", 2);
    expect(writes(frame)).toEqual([
      { data: "a", path: projectPath("src/a.ts") },
      { data: "b", path: projectPath("src/b.ts") },
    ]);
    release();
    await Promise.all([first, second]);
  });

  test("a write the frame refused rejects the caller and frees the path", async () => {
    const { checkpoint, frame } = await open();
    frame.answer("fs.write", () => {
      throw new Error("no room on the volume");
    });
    expect(await refusal(checkpoint.workspace.writeText("src/a.ts", "a"))).toBe(
      "no room on the volume"
    );
    // The failed path holds nothing: the next write reaches the frame.
    frame.answer("fs.write", () => {});
    await checkpoint.workspace.writeText("src/a.ts", "b");
    expect(writes(frame).map((write) => write.data)).toEqual(["a", "b"]);
  });
});

describe("the frame's events", () => {
  test("a derive republishes the rows and the commit behind them", async () => {
    const { checkpoint, frame } = await open();
    const published = Promise.withResolvers<readonly WorkspaceChange[]>();
    checkpoint.workspace.onChanges((next) => {
      published.resolve(next);
    });
    frame.emit("changes", {
      baseSha: "beef2",
      changes: [row("src/a.ts"), row("src/b.ts")],
      revision: 2,
    });
    expect(await published.promise).toHaveLength(2);
    expect(checkpoint.workspace.changes()).toHaveLength(2);
    // The commit moved under the page: the base follows the event, not the
    // open alone.
    expect(checkpoint.workspace.baseSha).toBe("beef2");
  });

  test("another tab's structural change reaches the tree", async () => {
    const { checkpoint, frame } = await open();

    const last = Promise.withResolvers<{
      paths: readonly string[];
      structural: boolean;
    }>();

    checkpoint.workspace.onPeerChange((structural, paths) => {
      last.resolve({ paths, structural });
    });
    frame.emit("peer", { paths: ["a.txt"], structural: true });
    expect(await last.promise).toEqual({ paths: ["a.txt"], structural: true });
  });

  test("a save the frame could not write is reported to the page", async () => {
    const { frame, saveErrors, saveReported } = await open();
    frame.emit("saveError", { message: "the quota was exceeded" });
    expect(await saveReported).toBe("the quota was exceeded");
    expect(saveErrors).toEqual(["the quota was exceeded"]);
  });

  test("a filesystem event reaches the watch it names", async () => {
    const { checkpoint, frame } = await open();
    frame.answer("fs.watch", () => ({ watchId: 7 }));
    frame.answer("fs.unwatch", () => {});
    const arrived = Promise.withResolvers<string>();

    const watch = checkpoint.workspace.fs.watch(
      "/home/project",
      { recursive: true },
      (event, filename) => {
        arrived.resolve(`${event}:${filename ?? ""}`);
      }
    );

    await frame.received("fs.watch");
    frame.emit("fs.event", {
      event: "rename",
      filename: "/home/project/src/a.ts",
      watchId: 7,
    });
    expect(await arrived.promise).toBe("rename:/home/project/src/a.ts");
    watch.close();
    await frame.received("fs.unwatch");
  });

  test("a fatal error fails what is in flight and tears the frame down", async () => {
    const fatal: string[] = [];
    const { port1, port2 } = new MessageChannel();
    const frame = newFakeFrame(port2);
    frame.answer("open", openAnswer(frame));
    let disposed = false;

    const checkpoint = await openSourceWorkspace({
      appId: APP_ID,
      branch: "main",
      editable: true,
      fetchArchive: () => Promise.resolve(new Uint8Array()),
      files: [],
      onFatal: (message) => {
        fatal.push(message);
      },
      onSaveError: () => {},
      openFrame: (frameOptions) =>
        Promise.resolve(
          bindPodPort({
            dispose: () => {
              disposed = true;
            },
            onAsk: frameOptions.onAsk,
            onFatal: frameOptions.onFatal,
            port: port1,
          })
        ),
      previewOrigin: PREVIEW_ORIGIN,
      sha: SHA,
    });

    const pending = checkpoint.workspace.listing();
    frame.emit("fatal", { message: "the pod's volume went away" });
    expect(await refusal(pending)).toBe("the pod's volume went away");
    expect(fatal).toEqual(["the pod's volume went away"]);
    expect(disposed).toBe(true);
    // A torn-down frame refuses rather than hanging.
    expect(await refusal(checkpoint.workspace.listing())).toBe(
      "the pod frame is closed"
    );
  });
});

describe("push", () => {
  const payload: PushPayload = {
    deletes: [],
    files: [{ content: "x\n", path: "src/a.ts" }],
    moves: [],
  };

  test("the frame prepares, this page commits, the frame settles", async () => {
    const { checkpoint, frame } = await open({
      beforeOpen: (scripted) => {
        scripted.answer("push.prepare", () => ({ payload }));
        scripted.answer("push.settle", () => {});
      },
    });

    const committed: PushPayload[] = [];
    await checkpoint.workspace.push(
      { branch: "feat", message: "Web edit", target: "feat" },
      (next) => {
        committed.push(next);

        return Promise.resolve({ sha: "beef2" });
      }
    );
    // The frame built the payload; this page is what committed it.
    expect(committed).toEqual([payload]);
    expect(settles(frame)).toEqual([
      { ok: true, sha: "beef2", target: "feat" },
    ]);
  });

  test("a commit that failed settles the frame with the error and rejects", async () => {
    const { checkpoint, frame } = await open({
      beforeOpen: (scripted) => {
        scripted.answer("push.prepare", () => ({ payload }));
        scripted.answer("push.settle", () => {});
      },
    });

    const pushed = checkpoint.workspace.push(
      { message: "Web edit", target: "main" },
      () => Promise.reject(new Error("commit failed: 413 too large"))
    );

    expect(await refusal(pushed)).toBe("commit failed: 413 too large");
    // The pod is told the push is over: nothing is left half-open in it.
    expect(settles(frame)).toEqual([
      {
        error: "commit failed: 413 too large",
        ok: false,
        target: "main",
      },
    ]);
  });
});

describe("teardown", () => {
  test("the pod's last save and its teardown come before the frame goes", async () => {
    const { checkpoint, disposed, frame } = await open();
    await checkpoint.workspace.close();
    expect(kinds(frame).slice(-2)).toEqual(["flush", "close"]);
    expect(disposed()).toBe(true);
  });

  test("a flush the frame refused does not keep the frame alive", async () => {
    const { checkpoint, disposed, frame } = await open();
    frame.answer("flush", () => {
      throw new Error("the volume is gone");
    });
    await checkpoint.workspace.close();
    expect(kinds(frame).slice(-2)).toEqual(["flush", "close"]);
    expect(disposed()).toBe(true);
  });
});

describe("the frame that answers wrongly", () => {
  test("a failed response reaches the caller with the frame's message", async () => {
    const { checkpoint, frame } = await open();
    frame.answer("listing", () => {
      throw new Error("the walk refused");
    });
    expect(await refusal(checkpoint.workspace.listing())).toBe(
      "the walk refused"
    );
  });

  test("a kind the frame does not answer fails the caller, never hangs", async () => {
    const { checkpoint } = await open();
    expect(await refusal(checkpoint.workspace.listing())).toBe(
      "unhandled listing"
    );
  });
});
