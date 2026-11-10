//! The workspace the source UI talks to: open it, and it has checked the
//! branch out (or restored the pod's own copy of it), wired the filesystem's
//! own change notifications to a derive, and answered with the rows the
//! Changes panel renders. Every mutation is a filesystem write — the pod is
//! the single source of truth, and there is no draft store behind it.

import type { Nodepod } from "@r1ck404/nodepod";
import { Data } from "effect";

import { deriveChanges, listCheckout } from "./changes";
import {
  checkout,
  readBase,
  readJournal,
  readObject,
  writeJournal,
} from "./checkout";
import {
  discardChange,
  discardAll as discardAllChanges,
  restoreMove,
} from "./discard";
import { isBinary } from "./git";
import { openPod } from "./pod";
import { markPushed, pushPayload, revertToBase } from "./push";
import {
  PROJECT_ROOT,
  WorkspaceError,
  parentDir,
  projectPath,
  relPath,
} from "./types";
import type {
  BaseIndex,
  HashCache,
  Journal,
  OpenKind,
  PushPayload,
  Workspace,
  WorkspaceChange,
  WorkspaceFs,
  WorkspaceOptions,
  WorkspacePush,
  WorkspaceState,
} from "./types";

export type { Workspace, WorkspaceOptions } from "./types";

/** The workspace as the frame's own runtime talks to it: the shared facade,
 * plus the pod itself — the shell runs on it — and
 * the pod's whole filesystem, where the control page only ever gets the
 * `SourceFs` slice it reads. */
export interface FrameWorkspace extends Omit<Workspace, "fs"> {
  fs: WorkspaceFs;
  pod: Nodepod;
}

/** How long a burst of filesystem events waits before one derive: a keystroke
 * storm is one walk, and a single write still lands well inside a frame. */
const COALESCE_MS = 50;

/** How one open relates the pod's saved base to the browsed ref — the decision
 * `createWorkspace` makes once, before it does anything.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> fresh: no base index in the pod
 *   [*] --> restored: base == browsed commit
 *   [*] --> diverged: base != browsed commit, unpushed rows held
 *   [*] --> replaced: base != browsed commit, nothing unpushed
 * ``` */
export const openDecision = (input: {
  base: BaseIndex | null;
  /** The rows the saved base still holds against the pod. */
  held: number;
  sha: string;
}): OpenKind => {
  const { base, held, sha } = input;

  if (base === null) {
    return "fresh";
  }

  if (base.baseSha === sha) {
    return "restored";
  }

  return held > 0 ? "diverged" : "replaced";
};

/** The derive loop.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> idle
 *   idle --> scheduled: a filesystem event
 *   scheduled --> running: the coalescing timer fires
 *   idle --> running: a verb asked (refresh)
 *   scheduled --> running: a verb asked (refresh)
 *   running --> running: another request arrived mid-pass
 *   running --> idle: no request is newer than the pass
 *   idle --> closed: close
 *   scheduled --> closed: close
 *   running --> closed: close
 * ```
 *
 * `running` is one pass at a time; `want` counts the requests and `published`
 * the pass that answered them, so a caller only lands once a pass that
 * *started after* its request has published (never on one that was already
 * walking the tree when the change arrived). */
export type DeriveLoopState = Data.TaggedEnum<{
  Closed: Record<never, never>;
  Idle: Record<never, never>;
  Running: { pass: number };
  Scheduled: Record<never, never>;
}>;

export type DeriveEvent =
  | { t: "close" }
  | { t: "finish" }
  | { t: "fire" }
  | { t: "request" }
  | { t: "schedule" };

export const Derive = Data.taggedEnum<DeriveLoopState>();

/** The one derive-loop transition. A request is never refused; it only moves
 * the loop to `running` (or leaves it there, where the pass will see it).
 * `closed` is terminal. */
export const deriveTransition = (
  state: DeriveLoopState,
  event: DeriveEvent
): DeriveLoopState => {
  if (event.t === "close") {
    return Derive.Closed();
  }

  return Derive.$match(state, {
    Closed: () => state,
    Idle: () => {
      switch (event.t) {
        case "request": {
          return Derive.Running({ pass: 0 });
        }

        case "schedule": {
          return Derive.Scheduled();
        }

        default: {
          return state;
        }
      }
    },
    Running: () => (event.t === "finish" ? Derive.Idle() : state),
    Scheduled: () => {
      switch (event.t) {
        case "fire":
        case "request": {
          return Derive.Running({ pass: 0 });
        }

        default: {
          return state;
        }
      }
    },
  });
};

/** The one text reader, for the committed side a pane shows read-only. */
const DECODER = new TextDecoder();

/** The journal after a path is renamed: nothing that sat under the old name is
 * left behind, and everything that did points the same way it did. A file's
 * new name gets its entry from the caller — a folder needs none, because a
 * folder is not a change. */
const remapJournal = (journal: Journal, from: string, to: string): Journal => {
  const prefix = `${from}/`;
  const moved: Journal = {};

  for (const [current, committed] of Object.entries(journal)) {
    if (current === from) {
      continue;
    }

    if (current.startsWith(prefix)) {
      moved[`${to}${current.slice(from.length)}`] = committed;
      continue;
    }

    moved[current] = committed;
  }

  return moved;
};

/** The journal without the records of anything that sat at `path` or below it:
 * a removed file has no move left to make. */
const forgetUnder = (journal: Journal, path: string): Journal => {
  const prefix = `${path}/`;
  const kept: Journal = {};

  for (const [current, committed] of Object.entries(journal)) {
    if (current !== path && !current.startsWith(prefix)) {
      kept[current] = committed;
    }
  }

  return kept;
};

/** The checkout-relative path an event names, or null when the event is not
 * about a path the tree shows. */
const relOfEvent = (name: string | null): string | null => {
  if (name === null) {
    return null;
  }

  if (name === PROJECT_ROOT) {
    return "";
  }

  if (name.startsWith(`${PROJECT_ROOT}/`)) {
    return relPath(name);
  }

  return name.startsWith("/") ? null : name;
};

/** Open one branch's workspace: restore what the pod saved, or check the ref
 * out from its archive, and hand back the operations the UI calls. */
export const createWorkspace = async (
  options: WorkspaceOptions
): Promise<FrameWorkspace> => {
  const { appId, branch, editable, fetchArchive, files, onSaveError, sha } =
    options;

  const opened = await (options.openPod ?? openPod)({
    appId,
    branch,
    editable,
    onSaveError,
  });

  const { fs } = opened;
  const canWrite = editable && opened.editable;
  const cache: HashCache = new Map();
  const subscribers = new Set<(changes: WorkspaceChange[]) => void>();
  let stale: string | null = null;
  let base = await readBase(fs);
  let journal = base === null ? {} : await readJournal(fs);

  // The ref moved under the saved workspace. Unpushed work is kept — the panel
  // is told the checkout is stale — but a clean pod is simply replaced. The
  // decision is one value (`openDecision`), taken once, before anything is
  // written.
  let held = 0;

  if (base !== null && base.baseSha !== sha) {
    const rows = await deriveChanges({ base, cache, fs, journal });
    held = rows.length;
  }

  const kind = openDecision({ base, held, sha });

  if (kind === "diverged") {
    stale = sha;
  }

  if (kind === "fresh" || kind === "replaced") {
    base = null;
  }

  if (base === null) {
    await checkout(fs, { fetchArchive, files, sha });
    base = await readBase(fs);

    if (base === null) {
      throw new WorkspaceError(
        "not-open",
        "workspace: the checkout left no base index behind"
      );
    }

    journal = {};
  }

  const state: WorkspaceState = { base, cache, fs, journal };
  let changes: WorkspaceChange[] = [];
  /** The derive loop (see `DeriveLoopState`). */
  let loop: DeriveLoopState = Derive.Idle();
  /** Requests made, and the pass that answered them. A caller's promise
   * settles only when `published` has caught up with its own request. */
  let want = 0;
  let published = 0;
  let failure: Error | null = null;

  let waiting: {
    reject: (error: Error) => void;
    resolve: () => void;
    want: number;
  }[] = [];

  let cooling: ReturnType<typeof setTimeout> | undefined;
  /** A filesystem event arrived while a pass was running: one more pass has to
   * follow it (the pass may have walked the tree before the write landed). */
  let dirty = false;

  const closed = (): boolean => Derive.$is("Closed")(loop);

  const publish = (next: WorkspaceChange[]): void => {
    changes = next;

    for (const subscriber of subscribers) {
      subscriber(next);
    }
  };

  const requireWritable = (): void => {
    if (!canWrite) {
      throw new WorkspaceError(
        "read-only",
        "workspace: this checkout is read-only"
      );
    }
  };

  /** Save whatever the pod still owes IndexedDB. The pod's own save is
   * debounced, and the page has already reported (or is about to report) what
   * it wrote: a reload or a closed tab inside that window would lose an edit
   * the UI counted. The rejection is swallowed *here* only because the boot's
   * own `persistence.on("error")` subscription has already reported the same
   * failure to the page (`onSaveError`); a following tab's refusal before it
   * holds the lock is expected and reported by neither. */
  const savePending = async (): Promise<void> => {
    if (
      opened.persistence === null ||
      opened.persistence.pendingChanges === 0
    ) {
      return;
    }

    try {
      await opened.flush();
    } catch {
      // Reported through the pod's error event (see above).
    }
  };

  const deriveOnce = async (): Promise<void> => {
    state.journal = await readJournal(fs);
    const next = await deriveChanges(state);
    await savePending();
    publish(next);
  };

  /** Wake every caller whose own request a published pass has answered, and
   * every caller a failed pass can never answer. */
  const settle = (): void => {
    const remaining: typeof waiting = [];

    for (const waiter of waiting) {
      if (published >= waiter.want) {
        waiter.resolve();
      } else if (failure === null) {
        remaining.push(waiter);
      } else {
        waiter.reject(failure);
      }
    }

    waiting = remaining;
  };

  /** One pass over the filesystem per round of requests. The walk reads a live
   * filesystem — the terminal and an installer write to it while the pass
   * runs — so a file that went away between the listing and the read is
   * ordinary: the pass keeps the rows it last published (the panel is stale,
   * never half-updated) and the next filesystem event, or the next operation,
   * derives again. A failed pass reports itself to the callers waiting on it
   * and leaves the loop `idle`: nothing here may escape as an unhandled
   * rejection. */
  const drive = async (): Promise<void> => {
    while (!Derive.$is("Closed")(loop)) {
      if (dirty) {
        dirty = false;
        want += 1;
      }

      if (published >= want) {
        loop = deriveTransition(loop, { t: "finish" });
        settle();

        return;
      }

      const pass = want;

      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one pass at a time is the whole point: the next round is what answers a request that arrived during this one.
        await deriveOnce();
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        break;
      }

      failure = null;
      published = pass;
      settle();
    }

    if (Derive.$is("Running")(loop)) {
      loop = deriveTransition(loop, { t: "finish" });
    }

    settle();
  };

  /** Derive now, and answer once a pass that started after this request has
   * published: a caller is never answered by the pass that was already walking
   * the tree when its change landed. */
  const refresh = (): Promise<void> => {
    if (closed()) {
      return Promise.reject(
        new WorkspaceError("closed", "workspace: this checkout is closed")
      );
    }

    want += 1;
    const mine = want;
    const answered = Promise.withResolvers<undefined>();
    waiting.push({
      reject: answered.reject,
      resolve: () => answered.resolve(),
      want: mine,
    });

    if (!Derive.$is("Running")(loop)) {
      if (cooling !== undefined) {
        clearTimeout(cooling);
        cooling = undefined;
      }

      loop = deriveTransition(loop, { t: "request" });
      void drive();
    }

    return answered.promise;
  };

  /** Coalesce a burst of filesystem events into one pass (see `COALESCE_MS`),
   * and never arm a second timer: the loop's `scheduled` state is the one timer
   * this workspace has. */
  const schedule = (): void => {
    if (closed()) {
      return;
    }

    if (Derive.$is("Running")(loop)) {
      dirty = true;

      return;
    }

    if (!Derive.$is("Idle")(loop)) {
      return;
    }

    loop = deriveTransition(loop, { t: "schedule" });
    cooling = setTimeout(() => {
      cooling = undefined;
      want += 1;
      loop = deriveTransition(loop, { t: "fire" });
      void drive();
    }, COALESCE_MS);
  };

  const watching = fs.watch(
    PROJECT_ROOT,
    { recursive: true },
    (_event, filename) => {
      const path = relOfEvent(filename);

      // An install writes thousands of dependency files the walk skips anyway.
      if (path?.split("/").includes("node_modules")) {
        return;
      }

      // The size+mtime key already guards a stale id; dropping the path (or
      // everything, when the event names no path) closes the one gap left —
      // two writes of the same length inside the same millisecond.
      if (path === null || path === "") {
        cache.clear();
      } else {
        cache.delete(path);
      }

      schedule();
    }
  );

  // Another tab's push moves the base index under this one: the derive has to
  // diff against what the pod holds now, not the base it opened with.
  const stopPeers = opened.onPeerChange(() => {
    void (async () => {
      const next = await readBase(fs);

      if (next !== null && !closed()) {
        state.base = next;
        schedule();
      }
    })();
  });

  const write = async (
    path: string,
    data: string | Uint8Array
  ): Promise<void> => {
    requireWritable();
    const abs = projectPath(path);
    await fs.mkdir(parentDir(abs), { recursive: true });
    await fs.writeFile(abs, data);
  };

  await refresh();

  return {
    get baseSha(): string {
      return state.base.baseSha;
    },
    /** The commit's text, out of the pod's own blob cache: a pane showing a
     * file the checkout no longer has (a staged deletion) reads it from here,
     * and never from the network. */
    baseText: async (path: string): Promise<string | null> => {
      const entry = state.base.entries[path];

      if (entry === undefined) {
        return null;
      }

      const bytes = await readObject(fs, entry.sha);

      return bytes === null || isBinary(bytes) ? null : DECODER.decode(bytes);
    },
    changes: () => changes,
    close: async () => {
      loop = deriveTransition(loop, { t: "close" });
      clearTimeout(cooling);
      cooling = undefined;
      failure = new WorkspaceError(
        "closed",
        "workspace: this checkout is closed"
      );
      settle();
      watching.close();
      stopPeers();

      // The pod's last save is debounced too: what the last keystroke left is
      // saved before the handle goes (a save that fails here is the pod's own
      // to retry, and `opened.close()` still captures what is left).
      try {
        await opened.flush();
      } catch {
        // Nothing left to do about it: the pod is going away either way.
      }

      await opened.close();
    },
    discard: async (path: string) => {
      requireWritable();
      const change = changes.find((row) => row.path === path);

      if (change !== undefined) {
        await discardChange(state, change);
        await refresh();
      }
    },
    discardAll: async () => {
      requireWritable();
      await discardAllChanges(state, changes);
      await refresh();
    },
    editable: canWrite,
    flush: async () => {
      await opened.flush();
    },
    fs,
    listing: () => listCheckout(fs, state.base),
    mkdir: async (path: string) => {
      requireWritable();
      await fs.mkdir(projectPath(path), { recursive: true });
    },
    onChanges: (notify: (next: WorkspaceChange[]) => void) => {
      subscribers.add(notify);

      return () => {
        subscribers.delete(notify);
      };
    },
    /** The peer paths arrive as pod paths; this facade speaks
     * checkout-relative ones (see `./types`). */
    onPeerChange: (notify) =>
      opened.onPeerChange((structural, paths) =>
        notify(
          structural,
          paths.map((path) => relPath(path))
        )
      ),
    pod: opened.pod,
    push: async (
      request: WorkspacePush,
      commit: (payload: PushPayload) => Promise<{ sha: string }>
    ) => {
      requireWritable();
      state.journal = await readJournal(fs);
      const { sha: committed } = await commit(await pushPayload(state));
      // The commit only moves this pod when it landed on this pod's own
      // branch; pushed to any other branch, the changes live there now and the
      // pod goes back to its base (see `revertToBase`). `request.branch` and
      // `request.message` are the caller's commit form, not the pod's.
      await (request.target === branch
        ? markPushed(state, committed)
        : revertToBase(state));
      // The pod's state after the push is the truth to report — and to save,
      // which `refresh` does before it publishes.
      await refresh();
    },
    refresh,
    remove: async (path: string) => {
      requireWritable();
      await fs.rm(projectPath(path), { force: true, recursive: true });
      state.journal = forgetUnder(state.journal, path);
      await writeJournal(fs, state.journal);
      // The pod's watcher does report a removal — but only sometimes, and a
      // staged deletion has to reach the panel either way.
      await refresh();
    },
    rename: async (from: string, to: string) => {
      requireWritable();
      const origin = state.journal[from] ?? from;
      await fs.rename(projectPath(from), projectPath(to));
      const moved = await fs.stat(projectPath(to));
      state.journal = remapJournal(state.journal, from, to);

      if (!moved.isDirectory) {
        state.journal[to] = origin;
      }

      await writeJournal(fs, state.journal);
    },
    restore: async (path: string) => {
      requireWritable();
      const change = changes.find((row) => row.path === path);

      if (change === undefined) {
        return;
      }

      await (change.kind === "moved"
        ? restoreMove(state, change)
        : discardChange(state, change));
      await refresh();
    },
    stale,
    writeBytes: (path: string, bytes: Uint8Array) => write(path, bytes),
    writeText: (path: string, text: string) => write(path, text),
  };
};
