//! The frame's RPC server: the pod's whole surface, as the page drives it.
//!
//! Everything the control UI used to do in-process — open the workspace, read
//! and write the checkout, derive the Changes rows, watch the filesystem,
//! create the shell, push — happens on this side of the
//! port, on the app's pod host origin, and answers one request at a time. The
//! wire is `pod-protocol.ts`; the state is one booted pod.
//!
//! Nothing here trusts a message: the port is a channel this document was
//! handed, not a session, so every field read off it is checked before it is
//! used, and every request is answered — a kind nobody serves, a request
//! before the workspace is open, work that threw. The page learns what the pod
//! does through events, which carry the truth the requests do not: the change
//! rows after every derive, a peer tab's edits, a failed save, and everything
//! the shell prints.
//!
//! Only two things the page sees come from here without being asked for: the
//! `changes` events (a derive that a filesystem event started) and `fatal`,
//! which says the frame is in a state the page has to tear down. There is no
//! path from this side to the page's own authority: the frame *asks* the page
//! for the one ref's archive while that ref is opening (`archive`), and for
//! nothing else, ever.
//!
//! # State
//!
//! The pod's lifecycles are `pod-state.ts`: the pod itself (`closed`,
//! `booting`, `open`, `closing`), the one in-flight push (`idle`, `prepared`,
//! `handed`, `settling`, `refused`, with a lease that returns it to `idle`),
//! and the shell (`closed`, `open`). Each is one value moved by one transition;
//! this module only performs the effects and answers the protocol.

import { errorMessage } from "../lib/errors";
import type {
  PodAskMessage,
  PodEvent,
  PodEventKind,
  PodEventMap,
  PodOpenParams,
  PodOpenResult,
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
import {
  Pod,
  Push,
  Terminal,
  defaultPushLease,
  podTransition,
  pushTransition,
  terminalTransition,
} from "./pod-state";
import type {
  PodPhase,
  PushLease,
  PushState,
  TerminalState,
} from "./pod-state";
import { createTerminalBackend } from "./terminal-backend";

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
  | { answer: number; failed: string | null; kind: "answer"; value: unknown }
  | { i: number; kind: "request"; params: unknown; request: string };

/** The push the page is committing: `push.prepare` built the payload and this
 * is what the page's own commit answers. Both halves are the facade's one
 * `push`, split at the call the page has to make. */
interface OpenPush {
  /** Set when the lease expired: the page never said how its commit went. */
  expired: boolean;
  /** The push's continuation: `markPushed` (or `revertToBase`) and the derive,
   * which run once the commit has answered. */
  finishing: Promise<void> | null;
  /** The lease this push holds; a stale timer cannot move a newer push. */
  lease: number;
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

/** The wire's failure code for one thrown value: a request the frame refused
 * names its own, and the facade's typed refusals (`workspace/types.ts`) carry
 * theirs, so the page never has to match the message. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- a caught value is unknown by construction: this is the boundary that turns it into the wire's code, after the shape check. */
const requestCode = (error: unknown): string | undefined => {
  if (error instanceof PodRequestError) {
    return error.code;
  }

  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;

    return typeof code === "string" && code !== "" ? code : undefined;
  }

  return undefined;
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** Serve the whole pod over `port`, for the ref this frame was opened for.
 * The frame's URL and the `open` request both name the app and the branch, and
 * they have to agree: a port that crossed origins by accident serves nothing. */
export const createPodServer = (options: {
  appId: string;
  branch: string;
  /** The push lease's timer; a test replaces it to expire the lease itself. */
  lease?: PushLease;
  openPod?: OpenPodOpener;
  port: MessagePort;
}): PodServer => {
  const { appId, branch, lease = defaultPushLease(), openPod, port } = options;
  /** The pod: closed until `open`, booting while it boots, open with the
   * workspace inside the state, closing on teardown. */
  let phase: PodPhase = Pod.Closed();
  /** The one push the page may have in flight. */
  let push: PushState = Push.Idle();
  /** The shell on the open pod. */
  let terminal: TerminalState = Terminal.Closed();
  let pushLeaseId = 0;
  let cancelLease: (() => void) | null = null;
  /** The push the page is committing right now; owned by the push's lease. */
  let openPush: OpenPush | null = null;
  /** Bumped by every publish, so the page can order the rows it keeps. */
  let revision = 0;
  /** The page's watches, by the id its own handle names. */
  let nextWatchId = 1;
  const watches = new Map<number, { close: () => void }>();
  /** The asks this frame has out, by their id — `archive` is the only one. */
  let nextAskId = 1;
  const asks = new Map<number, PromiseWithResolvers<unknown>>();
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
    if (!Pod.$is("Open")(phase)) {
      throw new PodRequestError("not-open", "pod: no workspace is open");
    }

    return phase.workspace;
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
   * the page will drive to it. `install` moves the phase to `open` with the
   * workspace, or tears the workspace down when the page closed under the
   * boot (see `openWorkspace`). */
  const bootWorkspace = async (
    params: PodOpenParams,
    install: (open: FrameWorkspace) => void
  ): Promise<PodOpenResult> => {
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

    install(open);
    stops.push(
      open.onChanges(() => {
        publishChanges();
      }),
      open.onPeerChange((structural, paths) => {
        emit("peer", { paths, structural });
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
    if (!Pod.$is("Closed")(phase)) {
      throw new PodRequestError(
        "already-open",
        "pod: this frame already holds a workspace"
      );
    }

    const settled = Promise.withResolvers<undefined>();

    const installing = bootWorkspace(params, (open) => {
      const next = podTransition(phase, { t: "booted", workspace: open });

      if (Pod.$is("Open")(next)) {
        phase = next;

        return;
      }

      // The page closed while the boot was still running: the workspace must
      // not outlive the request that gave up on it (it holds the saved copy's
      // lock). `closeWorkspace` finishes the phase.
      void open.close();
    });

    phase = podTransition(phase, { boot: settled.promise, t: "open" });

    // oxlint-disable-next-line promise/prefer-await-to-then -- the boot's own promise is the request's answer; this only settles the phase marker, whichever way it ended.
    void installing.then(
      () => {
        settled.resolve();
      },
      () => {
        phase = podTransition(phase, { t: "boot-failed" });
        settled.resolve();
      }
    );

    return installing;
  };

  /** Tear the pod down. The page sends `terminal.close` first; doing it again
   * here costs nothing and is what a page that died mid-teardown leaves
   * behind. A boot that is still in flight (a `close` right behind an `open`
   * the page gave up on) lands a live workspace: it is waited for and torn
   * down too, rather than left holding the saved copy's lock. */
  const closeWorkspace = async (): Promise<void> => {
    if (Pod.$is("Booting")(phase)) {
      await phase.boot;
    }

    if (!Pod.$is("Open")(phase)) {
      // A boot that was still running when this close arrived is torn down by
      // the boot's own install; the phase only has to be finished here.
      if (Pod.$is("Closing")(phase)) {
        phase = podTransition(phase, { t: "closed" });
      }

      return;
    }

    const open = phase.workspace;
    phase = podTransition(phase, { t: "close" });

    for (const stop of stops.splice(0)) {
      stop();
    }

    for (const watch of watches.values()) {
      watch.close();
    }

    watches.clear();
    terminal = terminalTransition(terminal, { t: "close" });
    cancelLease?.();
    cancelLease = null;
    openPush = null;
    push = Push.Idle();
    await open.close();
    phase = podTransition(phase, { t: "closed" });
  };

  /** Return the push slot to `idle` when the page never settled: the commit's
   * outcome is unknown, so the pod is left exactly as it was and the page is
   * told to reload (which restores the saved copy and re-derives). */
  const abandonPush = (pending: OpenPush): void => {
    pending.expired = true;
    openPush = null;
    push = Push.Idle();
    pending.settled.reject(
      new Error("workspace: the page never reported how the commit went")
    );
  };

  /** Take the next lease id for one push, and arm it. A stale timer (an older
   * push's id) does nothing. */
  const armLease = (pending: OpenPush): void => {
    pushLeaseId += 1;
    pending.lease = pushLeaseId;
    cancelLease?.();
    cancelLease = lease.after(() => {
      if (openPush !== pending || push === Push.Idle()) {
        return;
      }

      abandonPush(pending);
      emit("fatal", {
        message:
          "The push was never confirmed, so the workspace could not be settled on it. Reload to continue.",
      });
    });
  };

  /** Build the payload the page will commit, and hold the push open until
   * `push.settle`: the payload's own continuation — `markPushed` (or
   * `revertToBase`) and the derive — runs only once the page's commit has
   * answered, so the pod is never settled on a commit that did not land. */
  const pushPrepare = async (
    params: WorkspacePush
  ): Promise<{ payload: PushPayload }> => {
    const open = requireWorkspace();

    if (!Push.$is("Idle")(push)) {
      throw new PodRequestError(
        "busy",
        "workspace: a push is already in flight"
      );
    }

    const settled = Promise.withResolvers<{ sha: string }>();
    const built = Promise.withResolvers<PushPayload>();

    const pending: OpenPush = {
      expired: false,
      finishing: null,
      handed: false,
      lease: 0,
      refused: false,
      settled,
    };

    openPush = pending;
    armLease(pending);
    push = pushTransition(push, { lease: pending.lease, t: "prepare" });

    pending.finishing = open.push(
      { branch: params.branch, message: params.message, target: params.target },
      async (payload) => {
        pending.handed = true;
        push = pushTransition(push, { lease: pending.lease, t: "hand" });
        built.resolve(payload);

        return await settled.promise;
      }
    );
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/prefer-await-to-callbacks, anti-slop/no-unknown-parameters -- the continuation outlives the response the page is waiting for; this only observes how it ended, and a rejection is unknown by construction.
    void pending.finishing.catch((error: unknown) => {
      if (pending.refused || pending.expired) {
        // The page's own commit failed (its POST said so), or its lease
        // expired: the pod is exactly as it was, and `fatal` already spoke.
        return;
      }

      if (!pending.handed) {
        // The push never reached the page's commit at all: this request's own
        // failure (a read-only ref, a journal that would not read).
        openPush = null;
        push = Push.Idle();
        cancelLease?.();
        cancelLease = null;
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
   * publishes the post-push rows), and a failure leaves the pod untouched.
   * A settle that names no commit is refused *before* the push is released, so
   * the page can answer again instead of leaving the facade's continuation
   * waiting forever. */
  const pushSettle = async (params: PushSettleParams): Promise<void> => {
    const pending = openPush;

    if (pending === null || !Push.$is("Handed")(push)) {
      throw new PodRequestError(
        "busy",
        "workspace: no push is waiting to settle"
      );
    }

    if (params.ok !== true) {
      push = pushTransition(push, { lease: pending.lease, t: "refuse" });
      pending.refused = true;
      pending.settled.reject(new Error(params.error ?? "the commit failed"));

      return;
    }

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the params came off the port; a settled push without a commit id is refused here, while `push` still holds the page's slot.
    if (typeof params.sha !== "string" || params.sha === "") {
      throw new PodRequestError(
        "bad-params",
        "pod: a settled push needs the commit it landed"
      );
    }

    push = pushTransition(push, { lease: pending.lease, t: "settle" });
    pending.settled.resolve({ sha: params.sha });
    // The answer waits for the continuation, so a push that resolved on the
    // page's side means the pod has re-derived. A failure there is the
    // frame's own: `fatal` above has already said so.
    await pending.finishing?.catch(() => {
      // Reported as `fatal` when it happened.
    });
    cancelLease?.();
    cancelLease = null;
    openPush = null;
    push = pushTransition(push, { t: "finish" });
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
    "push.prepare": (params) => pushPrepare(params),
    "push.settle": (params) => pushSettle(params),
    refresh: () => requireWorkspace().refresh(),
    remove: ({ path }) => requireWorkspace().remove(path),
    rename: ({ from, to }) => requireWorkspace().rename(from, to),
    restore: ({ path }) => requireWorkspace().restore(path),
    "terminal.close": () => {
      if (Terminal.$is("Open")(terminal)) {
        terminal.backend.close();
      }

      terminal = terminalTransition(terminal, { t: "close" });
    },
    "terminal.input": ({ data }) => {
      if (Terminal.$is("Open")(terminal)) {
        terminal.backend.input(data);
      }
    },
    "terminal.open": ({ cols, rows }) => {
      const open = requireWorkspace();

      if (Terminal.$is("Open")(terminal)) {
        terminal.backend.close();
      }

      const backend = createTerminalBackend({
        onWrite: (data) => {
          emit("terminal.write", { data });
        },
        pod: open.pod,
      });

      backend.open(cols, rows);
      nextSessionId += 1;
      terminal = terminalTransition(terminal, {
        backend,
        cols,
        rows,
        sessionId: nextSessionId,
        t: "open",
      });

      return { sessionId: nextSessionId };
    },
    "terminal.resize": ({ cols, rows }) => {
      if (Terminal.$is("Open")(terminal)) {
        terminal.backend.resize(cols, rows);
        terminal = terminalTransition(terminal, { cols, rows, t: "resize" });
      }
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
      port.postMessage({
        e: { code: requestCode(error), message: errorMessage(error) },
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
      if (!Pod.$is("Open")(phase)) {
        return;
      }

      const open = phase.workspace;
      // oxlint-disable-next-line promise/prefer-await-to-then -- `pagehide` cannot await: the save is started, and the pod's own retry is all that is left after it.
      void open.flush().catch(() => {
        // The frame is going away: the pod's own retry is all that is left.
      });
    },
  };
};
