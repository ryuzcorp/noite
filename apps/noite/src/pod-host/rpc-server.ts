//! The frame's RPC server: the pod's whole surface, as the page drives it.
//!
//! Everything the control UI used to do in-process — open the workspace, read
//! and write the checkout, derive the Changes rows, watch the filesystem, plan
//! and run the preview, create the shell, push — happens on this side of the
//! port, on the app's preview origin, and answers one request at a time. The
//! wire is `pod-protocol.ts`; the state is one booted pod.
//!
//! Nothing here trusts a message: the port is a channel this document was
//! handed, not a session, so every field read off it is checked before it is
//! used, and every request is answered — a kind nobody serves, a request
//! before the workspace is open, work that threw. The page learns what the pod
//! does through events, which carry the truth the requests do not: the change
//! rows after every derive, a peer tab's edits, a failed save, the preview's
//! state and log, and everything the shell prints.
//!
//! Only two things the page sees come from here without being asked for: the
//! `changes` events (a derive that a filesystem event started) and `fatal`,
//! which says the frame is in a state the page has to tear down. There is no
//! path from this side to the page's own authority: the frame *asks* the page
//! for the one ref's archive while that ref is opening (`archive`), and for
//! nothing else, ever.

import { errorMessage } from "../lib/errors";
import type {
  PodAskMessage,
  PodEvent,
  PodEventKind,
  PodEventMap,
  PodOpenParams,
  PodOpenResult,
  PodPreviewStateEvent,
  PodPreviewView,
  PodRequestKind,
  PodRequestMap,
  PodResponse,
  PushPayload,
  PushSettleParams,
  WorkspacePush,
} from "../lib/source/pod-protocol";
import { parentDir } from "../lib/source/workspace/types";
import type { OpenPodOpener } from "../lib/source/workspace/types";
import { createWorkspace } from "../lib/source/workspace/workspace";
import type { FrameWorkspace } from "../lib/source/workspace/workspace";
import { createPreviewRuntime } from "./preview-runtime";
import type {
  PodPreviewRuntime,
  PreviewPlanner,
  PreviewStarter,
} from "./preview-runtime";
import { createTerminalBackend } from "./terminal-backend";
import type { TerminalBackend } from "./terminal-backend";

/** A request the frame refuses: the code lets the page tell "you asked before
 * opening" from "that work threw". */
class PodRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PodRequestError";
  }
}

/** Every kind the frame serves, each returning the map's own result. A kind
 * that answers nothing is served by a facade method that resolves `void`, so
 * the result is allowed to be nothing at all. */
type PodHandlers = {
  [K in PodRequestKind]: (
    params: PodRequestMap[K]["p"]
  ) => PodRequestMap[K]["r"] | Promise<PodRequestMap[K]["r"]> | Promise<void>;
};

/** Any kind's answer: the dispatcher is the one place that does not care which
 * kind it is serving. */
type PodAnyResult = PodRequestMap[PodRequestKind]["r"];

/** One message off the port: a request to serve, or the page's answer to an
 * ask this frame made. */
type Incoming =
  | { failed: string | null; kind: "answer"; value: unknown; answer: number }
  | { kind: "request"; request: string; i: number; params: unknown };

/** The push the page is committing: `push.prepare` built the payload and this
 * is what the page's own commit answers. Both halves are the facade's one
 * `push`, split at the call the page has to make. */
interface OpenPush {
  /** The push's continuation: `markPushed` (or `revertToBase`) and the derive,
   * which run once the commit has answered. */
  finishing: Promise<void> | null;
  /** Whether the payload reached the page (see `pushPrepare`). */
  handed: boolean;
  /** The page's commit failed, which its own POST already told it. */
  refused: boolean;
  settled: PromiseWithResolvers<{ sha: string }>;
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- a message off the port is I/O: it is parsed field by field here, and every field is checked before anything uses it. */
/** One field of an untrusted message, if it is a string. */
const stringField = (
  fields: Map<string, unknown>,
  name: string
): string | null => {
  const value = fields.get(name);
  return typeof value === "string" ? value : null;
};

/** The `{message}` of an answer's error, or null when it is not one. */
const errorField = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return stringField(new Map(Object.entries(value)), "message");
};

/** A message off the port, or null for anything that is not the protocol's own
 * shape — nothing off this port drives the frame through a field it did not
 * mean, and anything unrecognised is simply not acted on. */
const incoming = (value: unknown): Incoming | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const fields = new Map(Object.entries(value));
  const answer = fields.get("answer");
  if (typeof answer === "number") {
    if (fields.get("ok") === false) {
      return {
        answer,
        failed: errorField(fields.get("e")) ?? "the control refused the ask",
        kind: "answer",
        value: undefined,
      };
    }
    return { answer, failed: null, kind: "answer", value: fields.get("v") };
  }
  const request = stringField(fields, "k");
  const i = fields.get("i");
  if (request === null || typeof i !== "number") {
    return null;
  }
  return { i, kind: "request", params: fields.get("p"), request };
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** The view without its log: what a `preview.state` event carries, while the
 * log arrives line by line as `preview.log`. */
const previewState = (view: PodPreviewView): PodPreviewStateEvent => ({
  detail: view.detail,
  error: view.error,
  plan: view.plan,
  processes: view.processes,
  state: view.state,
  url: view.url,
});

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- the page's answer to an ask is I/O: it is read field by field and checked before anything uses it. */
/** The bytes one `archive` answer carried, or null when it carried none (the
 * page refuses the ask, or answers with something that is not an archive). */
const archiveBytes = (value: unknown): Uint8Array | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const bytes = new Map(Object.entries(value)).get("bytes");
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }
  return bytes instanceof Uint8Array ? bytes : null;
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** What one framed pod serves the page that owns it. */
export interface PodServer {
  /** Land the pod's pending saves now: the frame calls this from its own
   * `pagehide`, where nothing can await. */
  flushPending: () => void;
}

/** Serve the whole pod over `port`, for the ref this frame was opened for.
 * The frame's URL and the `open` request both name the app and the branch, and
 * they have to agree: a port that crossed origins by accident serves nothing.
 * `origin` is this document's own origin (`main.ts` reads it off its own
 * URL): the one origin a preview may be served from. `plan` and `start` are
 * how a preview is planned and launched, handed in from the frame's entry
 * rather than imported here (see `PreviewStarter`). */
export const createPodServer = (options: {
  appId: string;
  branch: string;
  openPod?: OpenPodOpener;
  origin: string;
  plan: PreviewPlanner;
  port: MessagePort;
  start: PreviewStarter;
}): PodServer => {
  const { appId, branch, openPod, origin, plan, port, start } = options;
  /** The open checkout. Null until `open` has answered, and again once `close`
   * has: every other request is refused in between. */
  let workspace: FrameWorkspace | null = null;
  /** The boot in flight, so a second `open` cannot boot a second pod. */
  let opening: Promise<PodOpenResult> | null = null;
  let preview: PodPreviewRuntime | null = null;
  let terminal: TerminalBackend | null = null;
  /** Bumped by every publish, so the page can order the rows it keeps. */
  let revision = 0;
  /** The page's watches, by the id its own handle names. */
  let nextWatchId = 1;
  const watches = new Map<number, { close: () => void }>();
  /** The asks this frame has out, by their id — `archive` is the only one. */
  let nextAskId = 1;
  const asks = new Map<number, PromiseWithResolvers<unknown>>();
  /** The push the page is committing right now. */
  let push: OpenPush | null = null;
  let nextSessionId = 0;
  /** What the page's own subscriptions stop: the pod's own events are not for
   * a closed frame. */
  const stops: (() => void)[] = [];

  const emit = <K extends PodEventKind>(
    ev: K,
    payload: PodEventMap[K]
  ): void => {
    const event: PodEvent<K> = { ev, p: payload };
    port.postMessage(event);
  };

  const requireWorkspace = (): FrameWorkspace => {
    if (workspace === null) {
      throw new PodRequestError("not-open", "pod: no workspace is open");
    }
    return workspace;
  };

  /** The open checkout, with the ref's own permission: every mutation the page
   * can ask for is refused here for a read-only ref, exactly as the facade
   * refuses its own. */
  const writable = (): FrameWorkspace => {
    const open = requireWorkspace();
    if (!open.editable) {
      throw new PodRequestError(
        "read-only",
        "workspace: this checkout is read-only"
      );
    }
    return open;
  };

  const requirePreview = (): PodPreviewRuntime => {
    if (preview === null) {
      throw new PodRequestError("not-open", "pod: no workspace is open");
    }
    return preview;
  };

  /** Ask the page for one ref's archive, through its own session: the bytes
   * arrive transferred. The page answers this only while an `open` is in
   * flight, so the frame can never use it as a general fetch. */
  const askArchive = async (sha: string): Promise<Uint8Array> => {
    const i = nextAskId;
    nextAskId += 1;
    const answered = Promise.withResolvers<unknown>();
    asks.set(i, answered);
    const ask: PodAskMessage<"archive"> = { ask: "archive", i, p: { sha } };
    port.postMessage(ask);
    const bytes = archiveBytes(await answered.promise);
    if (bytes === null) {
      throw new Error("pod: the archive ask answered no bytes");
    }
    return bytes;
  };

  const publishChanges = (): void => {
    const open = requireWorkspace();
    revision += 1;
    emit("changes", {
      baseSha: open.baseSha,
      changes: open.changes(),
      revision,
    });
  };

  /** Boot (or restore) the pod for the ref `open` named, and wire everything
   * the page will drive to it. */
  const bootWorkspace = async (
    params: PodOpenParams
  ): Promise<PodOpenResult> => {
    if (workspace !== null) {
      throw new PodRequestError(
        "already-open",
        "pod: this frame already holds a workspace"
      );
    }
    if (params.appId !== appId || params.branch !== branch) {
      throw new PodRequestError(
        "forbidden",
        "pod: this frame serves another ref"
      );
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the params came off the port: this is the check, before the boot trusts them.
    if (!Array.isArray(params.files) || typeof params.sha !== "string") {
      throw new PodRequestError(
        "bad-params",
        "pod: an open needs the ref's listing and its commit"
      );
    }
    const open = await createWorkspace({
      appId,
      branch,
      editable: params.editable === true,
      fetchArchive: askArchive,
      files: params.files,
      onSaveError: (error) => {
        emit("saveError", { message: errorMessage(error) });
      },
      openPod,
      sha: params.sha,
    });
    workspace = open;
    const session = createPreviewRuntime({
      origin: () => origin,
      plan,
      start,
    });
    preview = session;
    session.attach(open);
    stops.push(
      open.onChanges(() => {
        publishChanges();
      }),
      open.onPeerChange((structural) => {
        emit("peer", { structural });
      }),
      session.subscribe(() => {
        emit("preview.state", previewState(session.view()));
      }),
      session.onLog((line) => {
        emit("preview.log", line);
      })
    );
    // The rows the open itself derived: the page has its own subscription
    // working, and a workspace with changes is never drawn as clean.
    publishChanges();
    return {
      baseSha: open.baseSha,
      editable: open.editable,
      stale: open.stale,
    };
  };

  const openWorkspace = (params: PodOpenParams): Promise<PodOpenResult> => {
    if (opening !== null) {
      throw new PodRequestError(
        "already-open",
        "pod: this frame already holds a workspace"
      );
    }
    const booting = bootWorkspace(params);
    opening = booting;
    // oxlint-disable-next-line promise/prefer-await-to-then -- the boot's own promise is the request's answer; this only clears the in-flight marker, whichever way it settles.
    void booting.then(
      () => {
        opening = null;
      },
      () => {
        opening = null;
      }
    );
    return booting;
  };

  /** Tear the pod down. The page sends `preview.close` and `terminal.close`
   * first; doing both again here costs nothing and is what a page that died
   * mid-teardown leaves behind. */
  const closeWorkspace = async (): Promise<void> => {
    const open = workspace;
    if (open === null) {
      return;
    }
    const session = preview;
    workspace = null;
    preview = null;
    for (const stop of stops.splice(0)) {
      stop();
    }
    for (const watch of watches.values()) {
      watch.close();
    }
    watches.clear();
    terminal?.close();
    terminal = null;
    push = null;
    // The preview first: its servers are the pod's own children, and the pod
    // is about to go.
    await session?.close();
    await open.close();
  };

  /** Build the payload the page will commit, and hold the push open until
   * `push.settle`: the payload's own continuation — `markPushed` (or
   * `revertToBase`) and the derive — runs only once the page's commit has
   * answered, so the pod is never settled on a commit that did not land. */
  const pushPrepare = async (
    params: WorkspacePush
  ): Promise<{ payload: PushPayload }> => {
    const open = requireWorkspace();
    if (push !== null) {
      throw new PodRequestError(
        "busy",
        "workspace: a push is already in flight"
      );
    }
    const settled = Promise.withResolvers<{ sha: string }>();
    const built = Promise.withResolvers<PushPayload>();
    let handed = false;
    const pending: OpenPush = {
      finishing: null,
      handed: false,
      refused: false,
      settled,
    };
    push = pending;
    pending.finishing = open.push(
      { branch: params.branch, message: params.message, target: params.target },
      async (payload) => {
        handed = true;
        pending.handed = true;
        built.resolve(payload);
        return await settled.promise;
      }
    );
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/prefer-await-to-callbacks, anti-slop/no-unknown-parameters -- the continuation outlives the response the page is waiting for; this only observes how it ended, and a rejection is unknown by construction.
    void pending.finishing.catch((error: unknown) => {
      if (pending.refused) {
        // The page's own commit failed; its POST said so, and the pod is
        // exactly as it was.
        return;
      }
      if (!handed) {
        // The push never reached the page's commit at all: this request's own
        // failure (a read-only ref, a journal that would not read).
        push = null;
        built.reject(error);
        return;
      }
      // The commit landed, so the page's push succeeded and this is the
      // frame's own state that did not settle — nothing else can say so.
      emit("fatal", {
        message: `The push landed, but settling the workspace failed: ${errorMessage(error)}`,
      });
    });
    return { payload: await built.promise };
  };

  /** How the page's commit went: a sha settles the pod on it (which is what
   * publishes the post-push rows), and a failure leaves the pod untouched. */
  const pushSettle = async (params: PushSettleParams): Promise<void> => {
    const pending = push;
    if (pending === null) {
      throw new PodRequestError(
        "busy",
        "workspace: no push is waiting to settle"
      );
    }
    push = null;
    if (params.ok !== true) {
      pending.refused = true;
      pending.settled.reject(new Error(params.error ?? "the commit failed"));
      return;
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the params came off the port; a settled push without a commit id is refused here.
    if (typeof params.sha !== "string" || params.sha === "") {
      throw new PodRequestError(
        "bad-params",
        "pod: a settled push needs the commit it landed"
      );
    }
    pending.settled.resolve({ sha: params.sha });
    // The answer waits for the continuation, so a push that resolved on the
    // page's side means the pod has re-derived. A failure there is the
    // frame's own: `fatal` above has already said so.
    await pending.finishing?.catch(() => {
      // Reported as `fatal` when it happened.
    });
  };

  const handlers = {
    baseText: ({ path }) => requireWorkspace().baseText(path),
    changes: () => requireWorkspace().changes(),
    close: () => closeWorkspace(),
    discard: ({ path }) => requireWorkspace().discard(path),
    discardAll: () => requireWorkspace().discardAll(),
    flush: () => requireWorkspace().flush(),
    "fs.exists": ({ path }) => requireWorkspace().fs.exists(path),
    "fs.mkdir": ({ path, recursive }) =>
      writable().fs.mkdir(path, { recursive: recursive ?? true }),
    "fs.read": ({ path }) => requireWorkspace().fs.readFile(path),
    "fs.readdir": ({ path }) => requireWorkspace().fs.readdir(path),
    "fs.rename": ({ from, to }) => writable().fs.rename(from, to),
    "fs.rm": ({ force, path, recursive }) =>
      writable().fs.rm(path, {
        force: force ?? true,
        recursive: recursive ?? true,
      }),
    "fs.stat": ({ path }) => requireWorkspace().fs.stat(path),
    "fs.unwatch": ({ watchId }) => {
      watches.get(watchId)?.close();
      watches.delete(watchId);
    },
    "fs.watch": ({ path, recursive }) => {
      const open = requireWorkspace();
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the params came off the port: a watch needs a path before the pod's own watcher is asked to follow one.
      if (typeof path !== "string" || path === "") {
        throw new PodRequestError("bad-params", "pod: a watch needs a path");
      }
      const watchId = nextWatchId;
      nextWatchId += 1;
      watches.set(
        watchId,
        open.fs.watch(
          path,
          { recursive: recursive === true },
          (event, filename) => {
            emit("fs.event", { event, filename, watchId });
          }
        )
      );
      return { watchId };
    },
    "fs.write": async ({ data, path }) => {
      const open = writable();
      await open.fs.mkdir(parentDir(path), { recursive: true });
      await open.fs.writeFile(path, data);
    },
    listing: () => requireWorkspace().listing(),
    mkdir: ({ path }) => requireWorkspace().mkdir(path),
    open: (params) => openWorkspace(params),
    "preview.close": async () => {
      const session = requirePreview();
      await session.close();
      return session.view();
    },
    "preview.open": async () => {
      const session = requirePreview();
      await session.open();
      return session.view();
    },
    "preview.restart": async () => {
      const session = requirePreview();
      await session.restart();
      return session.view();
    },
    "preview.stop": async () => {
      const session = requirePreview();
      await session.stop();
      return session.view();
    },
    "preview.view": () => requirePreview().view(),
    "push.prepare": (params) => pushPrepare(params),
    "push.settle": (params) => pushSettle(params),
    refresh: () => requireWorkspace().refresh(),
    remove: ({ path }) => requireWorkspace().remove(path),
    rename: ({ from, to }) => requireWorkspace().rename(from, to),
    restore: ({ path }) => requireWorkspace().restore(path),
    "terminal.close": () => {
      terminal?.close();
      terminal = null;
    },
    "terminal.input": ({ data }) => {
      terminal?.input(data);
    },
    "terminal.open": ({ cols, rows }) => {
      const open = requireWorkspace();
      terminal?.close();
      const backend = createTerminalBackend({
        onWrite: (data) => {
          emit("terminal.write", { data });
        },
        pod: open.pod,
        preview: requirePreview(),
      });
      backend.open(cols, rows);
      terminal = backend;
      nextSessionId += 1;
      return { sessionId: nextSessionId };
    },
    "terminal.resize": ({ cols, rows }) => {
      terminal?.resize(cols, rows);
    },
    writeBytes: ({ bytes, path }) => requireWorkspace().writeBytes(path, bytes),
    writeText: ({ path, text }) => requireWorkspace().writeText(path, text),
  } satisfies PodHandlers;

  /** Serve one request and answer it — in order, and always. */
  const serve = async (request: {
    i: number;
    params: unknown;
    request: string;
  }): Promise<void> => {
    const { i } = request;
    // SAFETY: the kind was checked to be one of the map's own keys, so the
    // lookup is the map's own handler for it.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- justified above.
    const handler = Object.hasOwn(handlers, request.request)
      ? handlers[request.request as PodRequestKind]
      : undefined;
    if (handler === undefined) {
      port.postMessage({
        e: {
          code: "unknown-kind",
          message: `pod: no request named ${request.request}`,
        },
        i,
        ok: false,
      } satisfies PodResponse);
      return;
    }
    try {
      // SAFETY: the kind's own handler is the only one that reads `params`,
      // and its result type is the map's for that same kind.
      /* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters -- the dispatcher's one cast: justified above, and `params` is the handler's own kind's params, unparsed until the handler's own checks. */
      const run = handler as (
        params: unknown
      ) => PodAnyResult | Promise<PodAnyResult>;
      /* oxlint-enable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters */
      const value = await run(request.params);
      port.postMessage({ i, ok: true, v: value } satisfies PodResponse);
    } catch (error) {
      const code = error instanceof PodRequestError ? error.code : undefined;
      port.postMessage({
        e: { code, message: errorMessage(error) },
        i,
        ok: false,
      } satisfies PodResponse);
    }
  };

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- `onmessage` is the port's own API: assigning it is what starts the port, which `addEventListener` does not do.
  port.onmessage = (event: MessageEvent) => {
    const message = incoming(event.data);
    if (message === null) {
      return;
    }
    if (message.kind === "answer") {
      const waiting = asks.get(message.answer);
      if (waiting === undefined) {
        return;
      }
      asks.delete(message.answer);
      if (message.failed === null) {
        waiting.resolve(message.value);
      } else {
        waiting.reject(new Error(message.failed));
      }
      return;
    }
    void serve(message);
  };

  return {
    flushPending: () => {
      // oxlint-disable-next-line promise/prefer-await-to-then -- `pagehide` cannot await: the save is started, and the pod's own retry is all that is left after it.
      void workspace?.flush().catch(() => {
        // The frame is going away: the pod's own retry is all that is left.
      });
    },
  };
};
