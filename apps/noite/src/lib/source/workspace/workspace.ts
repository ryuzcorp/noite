//! The workspace the source UI talks to: open it, and it has checked the
//! branch out (or restored the pod's own copy of it), wired the filesystem's
//! own change notifications to a derive, and answered with the rows the
//! Changes panel renders. Every mutation is a filesystem write — the pod is
//! the single source of truth, and there is no draft store behind it.

import type { Nodepod } from "@r1ck404/nodepod";

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
import { PROJECT_ROOT, parentDir, projectPath, relPath } from "./types";
import type {
  HashCache,
  Journal,
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
 * plus the pod itself — the preview's servers and the shell run on it — and
 * the pod's whole filesystem, where the control page only ever gets the
 * `SourceFs` slice it reads. */
export interface FrameWorkspace extends Omit<Workspace, "fs"> {
  fs: WorkspaceFs;
  pod: Nodepod;
}

/** How long a burst of filesystem events waits before one derive: a keystroke
 * storm is one walk, and a single write still lands well inside a frame. */
const COALESCE_MS = 50;

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
  if (base !== null && base.baseSha !== sha) {
    // The ref moved under the saved workspace. Unpushed work is kept — the
    // panel is told the checkout is stale — but a clean pod is simply replaced.
    const held = await deriveChanges({ base, cache, fs, journal });
    if (held.length > 0) {
      stale = sha;
    } else {
      base = null;
    }
  }
  if (base === null) {
    await checkout(fs, { fetchArchive, files, sha });
    base = await readBase(fs);
    if (base === null) {
      throw new Error("workspace: the checkout left no base index behind");
    }
    journal = {};
  }
  const state: WorkspaceState = { base, cache, fs, journal };
  let changes: WorkspaceChange[] = [];
  let running: Promise<void> | null = null;
  let again = false;
  let cooling = false;
  let closed = false;

  const publish = (next: WorkspaceChange[]): void => {
    changes = next;
    for (const subscriber of subscribers) {
      subscriber(next);
    }
  };

  const requireWritable = (): void => {
    if (!canWrite) {
      throw new Error("workspace: this checkout is read-only");
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

  /** Derive now, and never twice at once: a caller that arrives while a derive
   * runs shares it and queues one more, so the last answer is the truth. */
  const refresh = async (): Promise<void> => {
    if (running !== null) {
      again = true;
      await running;
      return;
    }
    running = deriveOnce();
    try {
      await running;
    } finally {
      running = null;
    }
    if (again) {
      again = false;
      await refresh();
    }
  };

  const schedule = (): void => {
    if (cooling) {
      return;
    }
    cooling = true;
    setTimeout(() => {
      cooling = false;
      if (!closed) {
        void refresh();
      }
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
      if (next !== null && !closed) {
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
      closed = true;
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
    listing: () => listCheckout(fs),
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
    onPeerChange: opened.onPeerChange,
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
