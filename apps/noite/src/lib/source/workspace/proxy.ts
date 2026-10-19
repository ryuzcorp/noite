//! The source UI's workspace, as a proxy over the pod frame's RPC.
//!
//! The pod — the filesystem, the checkout, the derive, the push — lives in a
//! document on the app's pod host origin (see `pod-client.ts`), and this is what
//! the panes drive: the same `Workspace` the browser has always talked to,
//! with every call answered by that document. Nothing here holds a pod, an SDK
//! type or a worker; `fs` is the small read surface the editor and the tree
//! actually use (`SourceFs`), and everything that writes a path is a verb the
//! frame performs.
//!
//! Two things are the proxy's own rather than the frame's:
//!
//! - **Writes are coalesced per path.** The editor writes on every keystroke;
//!   the frame gets one write per path in flight and one latest value behind
//!   it, so a burst of typing is a handful of writes instead of one per key —
//!   and a caller's promise still resolves only once the pod holds its text.
//! - **The commit.** The frame builds a push payload but can never commit:
//!   this page POSTs it, with the viewer's session cookies, on the user's Push
//!   click alone, and tells the frame how that went.

import { errorMessage } from "../../errors";
import type { TreeEntry } from "../../runner";
import { openPodFrame } from "../pod-client";
import type {
  PodAskAnswer,
  PodConnection,
  PodFrameOptions,
} from "../pod-client";
import type { PodAskMessage } from "../pod-protocol";
import type {
  SaveErrorReporter,
  SourceFs,
  Workspace,
  WorkspaceChange,
  WorkspacePush,
} from "./types";
import { projectPath } from "./types";

/** What the browser hands `openSourceWorkspace`: the ref it is browsing, and
 * the two things only this page can do for it (the archive fetch and the
 * commit), both over the viewer's own session. */
export interface SourceWorkspaceOptions {
  appId: string;
  branch: string;
  /** Read-only refs never persist and refuse every mutation (the frame
   * narrows it further when the pod itself holds a read-only copy). */
  editable: boolean;
  /** Reads the ref's tar; the composition wires the `source/archive` route.
   * The bytes are handed to the frame zero-copy, by transferring the
   * buffer. */
  fetchArchive: (ref: string) => Promise<Uint8Array>;
  /** The ref's listing (`source.tree`): what a fresh checkout stamps as base. */
  files: TreeEntry[];
  /** Where a failed pod-side save is reported; the page shows it. */
  onSaveError: SaveErrorReporter;
  /** The unrecoverable frame failure: the page says so and tears down. */
  onFatal?: (message: string) => void;
  /** How the frame is opened. The default frames the app's pod host and
   * binds a port to it; a test hands in a connection over its own
   * `MessageChannel` pair — and its own scripted frame — which is the only
   * reason it is a parameter. */
  openFrame?: (frame: PodFrameOptions) => Promise<PodConnection>;
  /** The app's pod host origin: the only origin the frame may live on. */
  previewOrigin: string;
  /** The resolved commit of the browsed ref (see `PodOpenParams`). */
  sha: string;
  /** Aborted when the pane goes. A checkout that is still opening has no
   * owner to close it yet (it reaches the browser's map only once it is
   * open), so the frame follows this signal instead — with no `open` deadline
   * to turn to, a boot that hangs would otherwise outlive the page's pane. */
  signal?: AbortSignal;
}

/** An open source workspace: the proxy the panes call, and the frame
 * connection the terminal shares with it. */
export interface SourceCheckout {
  connection: PodConnection;
  workspace: Workspace;
}

/** One path's writes, as the frame receives them: at most one in flight, one
 * latest value behind it, and the callers waiting for a value to land. */
interface PathWrites {
  /** The text of the next write, or null while only the in-flight one is
   * left. A later call replaces it (latest wins). */
  pending: string | null;
  /** The callers whose text this pending value carries (or supersedes). */
  waiting: WaitingWrite[];
  writing: boolean;
}

/** One caller waiting for the pod to hold its text. */
interface WaitingWrite {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a refused write is the frame's own answer, unknown by construction; the caller narrows it to text.
  reject: (error: unknown) => void;
  resolve: () => void;
}

/** Close `connection` when `signal` aborts, and answer the way to stop
 * listening: the frame is removed with it (see `PodConnection.close`), and an
 * already-aborted signal closes it right away. */
const tieToSignal = (
  connection: PodConnection,
  signal: AbortSignal | undefined
): (() => void) => {
  if (signal === undefined) {
    return () => {
      // No signal: nothing was tied, nothing to untie.
    };
  }

  const close = (): void => {
    void connection.close();
  };

  if (signal.aborted) {
    close();

    return () => {
      // Already closed above.
    };
  }

  signal.addEventListener("abort", close, { once: true });

  return () => {
    signal.removeEventListener("abort", close);
  };
};

/** Open the frame for one ref and answer with the workspace over it. */
export const openSourceWorkspace = async (
  options: SourceWorkspaceOptions
): Promise<SourceCheckout> => {
  const {
    appId,
    branch,
    editable,
    fetchArchive,
    files,
    onFatal,
    onSaveError,
    previewOrigin,
    sha,
  } = options;

  /** Whether an `open` request is in flight. The frame may ask for the
   * archive only while it is: an ask at any other time would make this page a
   * general fetch proxy for a compromised frame. */
  let opening = false;

  const onAsk = async (ask: PodAskMessage): Promise<PodAskAnswer> => {
    if (ask.ask !== "archive") {
      throw new Error(`the frame asked for an unsupported "${ask.ask}"`);
    }

    if (!opening) {
      throw new Error("the frame asked for an archive outside an open");
    }

    const bytes = await fetchArchive(ask.p.sha);
    // SAFETY: `fetchSourceArchive` allocates the view over the whole response
    // buffer, so the transfer takes exactly these bytes and nothing else.
    const buffer = bytes.buffer as ArrayBuffer;

    return { transfer: [buffer], value: { bytes: buffer } };
  };

  const connection = await (options.openFrame ?? openPodFrame)({
    appId,
    branch,
    onAsk,
    onFatal,
    previewOrigin,
  });

  // Nothing holds this connection yet — it reaches the caller only when the
  // open answers — so while the open is up, the pane's own signal is what
  // closes the frame if the pane goes. Past the open, the checkout owns it.
  const untie = tieToSignal(connection, options.signal);

  // The state the frame's events keep: the rows (the open's first derive lands
  // as an event, before `open` even answers), the commit they were derived
  // against, and the fs watches the page holds.
  let changes: WorkspaceChange[] = [];
  let base = "";
  const subscribers = new Set<(next: WorkspaceChange[]) => void>();

  const peerSubscribers = new Set<
    (structural: boolean, paths: readonly string[]) => void
  >();

  const watches = new Map<
    number,
    (event: string, filename: string | null) => void
  >();

  connection.on("changes", (event) => {
    const { changes: rows, baseSha } = event;
    changes = rows;
    base = baseSha;

    for (const notify of subscribers) {
      notify(rows);
    }
  });
  connection.on("peer", ({ paths, structural }) => {
    for (const notify of peerSubscribers) {
      notify(structural, paths);
    }
  });
  connection.on("saveError", ({ message }) => {
    onSaveError(new Error(message));
  });
  connection.on("fs.event", ({ event, filename, watchId }) => {
    watches.get(watchId)?.(event, filename);
  });

  let opened: { baseSha: string; editable: boolean; stale: string | null };

  try {
    opening = true;
    opened = await connection.call(
      "open",
      { appId, branch, editable, files, sha },
      // The checkout untars the ref's archive: bounded by the archive, but
      // never by a request deadline.
      { timeout: 0 }
    );
  } catch (error) {
    await connection.close();
    throw error;
  } finally {
    opening = false;
    untie();
  }

  base = opened.baseSha;

  /** Every path's write slot, so a keystroke burst is one write in flight and
   * one latest value behind it. */
  const writers = new Map<string, PathWrites>();

  /** Push one path's writes through: each value is written once, and every
   * caller waiting when the write started learns how it went. A value that
   * arrived while a write was in flight is the next one, so the last text a
   * burst typed is always the text the pod ends up with. */
  const drain = (path: string): void => {
    const writer = writers.get(path);

    if (writer === undefined || writer.writing) {
      return;
    }

    writer.writing = true;
    void (async () => {
      while (writer.pending !== null) {
        const text = writer.pending;
        const { waiting } = writer;
        writer.pending = null;
        writer.waiting = [];

        try {
          // The keystroke path is the facade's own: the page speaks checkout
          // paths, and the frame's `fs.write` is one of the pod-path kinds
          // (`fs.read`, `fs.stat`, …), so the mapping happens here.
          // oxlint-disable-next-line eslint/no-await-in-loop -- the writes for one path are sequential by design: each answer is what lets the next value (or the caller's promise) settle.
          await connection.call("fs.write", {
            data: text,
            path: projectPath(path),
          });

          for (const call of waiting) {
            call.resolve();
          }
        } catch (error) {
          writer.writing = false;
          writers.delete(path);
          // Everything the slot still holds goes with the failed write: the
          // callers this value carried, and the waiters a later keystroke
          // queued behind it. A caller whose promise never settles would hold
          // the editor's own write queue for that path forever.
          const stranded = [...waiting, ...writer.waiting];
          writer.pending = null;
          writer.waiting = [];

          for (const call of stranded) {
            call.reject(error);
          }

          return;
        }
      }

      writer.writing = false;
      writers.delete(path);
    })();
  };

  /** Ship the text `drain` is still holding, one write per path, without
   * waiting for the write already in flight: the port delivers it after that
   * one, so the pod ends up with the newest text. Callers waiting on it settle
   * on this write's own answer (a promise that may never settle if the page
   * goes right away, which is what unload looks like). */
  const shipPending = (): void => {
    for (const [path, writer] of writers) {
      const text = writer.pending;

      if (text === null) {
        continue;
      }

      writer.pending = null;
      const { waiting } = writer;
      writer.waiting = [];
      void (async () => {
        try {
          await connection.call("fs.write", {
            data: text,
            path: projectPath(path),
          });

          for (const call of waiting) {
            call.resolve();
          }
        } catch (error) {
          for (const call of waiting) {
            call.reject(error);
          }
        }
      })();
    }
  };

  /** The write behind `writeText`: the caller's promise lands when the pod
   * holds its text or a later one. */
  const writeText = (path: string, text: string): Promise<void> => {
    const writer = writers.get(path) ?? {
      pending: null,
      waiting: [],
      writing: false,
    };

    writers.set(path, writer);
    // oxlint-disable-next-line typescript/no-invalid-void-type -- the write answers nothing, so `void` is its honest result; the rule reads the generic argument as a declaration.
    const written = Promise.withResolvers<void>();
    writer.pending = text;
    writer.waiting.push({ reject: written.reject, resolve: written.resolve });
    drain(path);

    return written.promise;
  };

  /** Land what this page still holds, then have the frame save it. `drain`
   * keeps a burst's later text here until the write in flight answers, so a
   * flush asked for in between would save what the pod's volume held *then*:
   * the last keystrokes of an edit the UI already counts as a change would be
   * lost by a reload. Both messages go out back to back — the flight's text
   * reaches the pod's volume, and the frame's own save, right behind it on the
   * same port, persists exactly that. */
  const flushWrites = async (): Promise<void> => {
    shipPending();
    // oxlint-disable-next-line unicorn/no-useless-undefined -- the protocol's `flush` takes no params, and the slot is part of one request envelope (see the `workspace` literal below).
    await connection.call("flush", undefined);
  };

  const fs: SourceFs = {
    exists: (path) => connection.call("fs.exists", { path }),
    readFile: (path) => connection.call("fs.read", { path }),
    stat: (path) => connection.call("fs.stat", { path }),
    watch: (path, opts, notify) => {
      let watchId: number | null = null;
      let closed = false;
      void (async () => {
        try {
          const started = await connection.call("fs.watch", {
            path,
            recursive: opts.recursive,
          });

          const { watchId: startedId } = started;
          watchId = startedId;

          if (closed) {
            void connection.call("fs.unwatch", { watchId: startedId });

            return;
          }

          watches.set(startedId, notify);
        } catch {
          // The frame is gone: there is nothing left to watch.
        }
      })();

      return {
        close: () => {
          closed = true;
          const id = watchId;

          if (id !== null) {
            watches.delete(id);
            void connection.call("fs.unwatch", { watchId: id });
          }
        },
      };
    },
  };

  /** The workspace the panes drive: every verb is one request to the frame, and
   * nothing here holds a pod. */
  /* oxlint-disable unicorn/no-useless-undefined -- a kind the protocol gives no params is still called with its (undefined) params slot: the request envelope is one shape on both sides, and the slot is what keeps the frame's own parser from having to special-case a missing one. */
  const workspace: Workspace = {
    get baseSha(): string {
      return base;
    },
    baseText: (path) => connection.call("baseText", { path }),
    changes: () => changes,
    close: async () => {
      // The terminal stops before this (the browser's order), so what is left
      // is the pod's own last save and its teardown.
      try {
        await flushWrites();
      } catch {
        // Nothing left to do about a save that failed: the pod goes away
        // either way, and the frame's own `saveError` already said so.
      }

      try {
        await connection.call("close", undefined, { timeout: 0 });
      } catch {
        // A teardown the frame did not finish is still a frame to remove.
      }

      await connection.close();
    },
    discard: (path) => connection.call("discard", { path }),
    discardAll: () => connection.call("discardAll", undefined),
    editable: opened.editable,
    flush: async () => {
      await flushWrites();
    },
    fs,
    listing: () => connection.call("listing", undefined),
    mkdir: (path) => connection.call("mkdir", { path }),
    onChanges: (notify) => {
      subscribers.add(notify);

      return () => {
        subscribers.delete(notify);
      };
    },
    onPeerChange: (notify) => {
      peerSubscribers.add(notify);

      return () => {
        peerSubscribers.delete(notify);
      };
    },
    push: async (request: WorkspacePush, commit) => {
      const prepared = await connection.call("push.prepare", request, {
        timeout: 0,
      });

      const { target } = request;

      try {
        const { sha: committed } = await commit(prepared.payload);
        await connection.call("push.settle", {
          ok: true,
          sha: committed,
          target,
        });
      } catch (error) {
        try {
          await connection.call("push.settle", {
            error: errorMessage(error),
            ok: false,
            target,
          });
        } catch {
          // The frame is gone, so there is nothing left to settle on.
        }

        throw error;
      }
    },
    refresh: async () => {
      await connection.call("refresh", undefined);
    },
    remove: (path) => connection.call("remove", { path }),
    rename: (from, to) => connection.call("rename", { from, to }),
    restore: (path) => connection.call("restore", { path }),
    stale: opened.stale,
    writeBytes: (path, bytes) => connection.call("writeBytes", { bytes, path }),
    writeText,
  };

  /* oxlint-enable unicorn/no-useless-undefined */
  return { connection, workspace };
};
