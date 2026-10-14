//! Keeping one branch's workspace in step across the tabs that have it open.
//!
//! Every tab runs its own pod, and only one of them — the tab holding the
//! pod's persistence lock — saves it to IndexedDB. The others are just as
//! editable: each tab sends the checkout's mutations (the project tree and the
//! base index, move journal and blob cache beside it) to the others over a
//! `BroadcastChannel`, and applies theirs. A tab that opens second asks the
//! saving tab to flush, restores the saved copy, and only then applies what
//! arrived in the meantime, so nothing slips between the two. Concurrent
//! writes to one file resolve as last write wins.
//!
//! What never crosses: `node_modules` (each tab installs its own) and
//! everything outside the checkout — the pod's own runtime state.
//!
//! This module never imports the pod SDK (see `pod.ts`): the volume is the
//! structural slice it needs, and mutations arrive already classified.

import {
  BASE_FILE,
  JOURNAL_FILE,
  OBJECTS_DIR,
  PROJECT_ROOT,
  parentDir,
} from "./types";

/** The volume's mutation journal, as far as the sync reads it — the SDK's
 * `VolumeMutation` is assignable to it, so the pod's volume is passed as is.
 * `link` and `mount` are never forwarded: the checkout makes no hard links,
 * and a mount is a restore the peers already have. */
export type SyncMutation =
  | { from: string; op: "rename"; to: string }
  | { mode?: number; op: "meta"; path: string }
  | { op: "link" }
  | { op: "mount" }
  | { op: "mkdir" | "remove" | "symlink" | "write"; path: string };

/** The slice of the pod's volume the sync needs — every call synchronous, so
 * a mutation the sync applies is told apart from one this tab made. The pod's
 * `MemoryVolume` is one. */
export interface SyncVolume {
  lchmodSync: (path: string, mode: number) => void;
  mkdirSync: (path: string, options: { recursive: true }) => string | undefined;
  onMutation: (callback: (mutation: SyncMutation) => void) => () => void;
  readFileSync: (path: string) => Uint8Array;
  readlinkSync: (path: string) => string;
  removeTreeSync: (path: string) => void;
  renameSync: (from: string, to: string) => void;
  symlinkSync: (target: string, path: string) => void;
  writeFileSync: (path: string, data: Uint8Array) => void;
}

/** One mutation as it travels: a write carries its bytes, a symlink its
 * target, so the receiving tab never reads anything back. */
type SyncOp =
  | { bytes: Uint8Array; op: "write"; path: string }
  | { from: string; op: "rename"; to: string }
  | { mode: number; op: "mode"; path: string }
  | { op: "mkdir" | "remove"; path: string }
  | { op: "symlink"; path: string; target: string };

type SyncMessage =
  | { from: string; kind: "flush" }
  | { kind: "flushed"; to: string }
  | { from: string; kind: "op"; op: SyncOp };

/** The channel the tabs talk over (`BroadcastChannel` in the page). */
export interface SyncChannel {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent) => void
  ) => void;
  close: () => void;
  postMessage: (message: SyncMessage) => void;
}

export interface TabSync {
  close: () => void;
  /** Ask whichever tab saves the workspace to flush it, so a restore that
   * follows reads every write that tab made. Resolves on its answer, or after
   * `timeoutMs` when no tab answers (none is saving). */
  flushPeers: (timeoutMs: number) => Promise<void>;
  /** Called after peer mutations land; `structural` when a path came, went
   * or moved (a plain rewrite of a file is not), and `paths` the
   * checkout-relative paths that batch touched (a rename reports its
   * destination). A tab holding unsaved edits to one of them has been
   * overwritten by the peer. */
  onApplied: (
    notify: (structural: boolean, paths: readonly string[]) => void
  ) => () => void;
  /** Answer the other tabs' flush requests: this tab saves the workspace. */
  serveFlush: (flush: () => Promise<void>) => void;
  /** Start sending this tab's mutations and applying the peers', the ones
   * that arrived before this first. */
  start: () => void;
}

/** The channel name of one saved workspace. */
export const syncChannelName = (id: string): string => `noite:sync:${id}`;

const NODE_MODULES = "node_modules";

/** Whether a pod path is part of what the tabs share. */
export const isSynced = (path: string): boolean => {
  if (path === BASE_FILE || path === JOURNAL_FILE) {
    return true;
  }
  if (path.startsWith(`${OBJECTS_DIR}/`)) {
    return true;
  }
  if (path !== PROJECT_ROOT && !path.startsWith(`${PROJECT_ROOT}/`)) {
    return false;
  }
  return !path.split("/").includes(NODE_MODULES);
};

/** Messages come from same-origin tabs only, but a peer on another build of
 * the UI may speak another shape: anything unrecognised is dropped, and an op
 * that does not apply is skipped where it is applied (see `apply`). */
const isMessage = (value: unknown): value is SyncMessage => {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  if (value.kind === "flushed") {
    return "to" in value && typeof value.to === "string";
  }
  if (!("from" in value) || typeof value.from !== "string") {
    return false;
  }
  return (
    value.kind === "flush" ||
    (value.kind === "op" &&
      "op" in value &&
      typeof value.op === "object" &&
      value.op !== null)
  );
};

/** A local mutation as the message that replays it, or null when it is not
 * shared (or names a path already gone again). */
const toOp = (volume: SyncVolume, mutation: SyncMutation): SyncOp | null => {
  if (mutation.op === "link" || mutation.op === "mount") {
    return null;
  }
  if (mutation.op === "rename") {
    const from = isSynced(mutation.from);
    const to = isSynced(mutation.to);
    if (from && to) {
      return { from: mutation.from, op: "rename", to: mutation.to };
    }
    if (from) {
      return { op: "remove", path: mutation.from };
    }
    // Moved in from outside: what lands is new to the peers.
    return to ? toOp(volume, { op: "write", path: mutation.to }) : null;
  }
  if (!isSynced(mutation.path)) {
    return null;
  }
  if (mutation.op === "mkdir" || mutation.op === "remove") {
    return { op: mutation.op, path: mutation.path };
  }
  if (mutation.op === "meta") {
    return mutation.mode === undefined
      ? null
      : { mode: mutation.mode, op: "mode", path: mutation.path };
  }
  try {
    return mutation.op === "write"
      ? {
          bytes: volume.readFileSync(mutation.path),
          op: "write",
          path: mutation.path,
        }
      : {
          op: "symlink",
          path: mutation.path,
          target: volume.readlinkSync(mutation.path),
        };
  } catch {
    // Written and gone again inside one tick (a directory written over, a
    // temporary): the removal that follows says what is left.
    return null;
  }
};

/** Replay one peer mutation. A step that cannot apply (the path is already
 * gone, a folder sits where a file goes) leaves the volume as it is: the
 * peer's next mutation of that path brings it back in step. */
const apply = (volume: SyncVolume, op: SyncOp): boolean => {
  try {
    switch (op.op) {
      case "write": {
        volume.mkdirSync(parentDir(op.path), { recursive: true });
        volume.writeFileSync(op.path, op.bytes);
        return false;
      }
      case "mkdir": {
        volume.mkdirSync(op.path, { recursive: true });
        return true;
      }
      case "remove": {
        volume.removeTreeSync(op.path);
        return true;
      }
      case "rename": {
        volume.mkdirSync(parentDir(op.to), { recursive: true });
        volume.renameSync(op.from, op.to);
        return true;
      }
      case "symlink": {
        volume.mkdirSync(parentDir(op.path), { recursive: true });
        volume.removeTreeSync(op.path);
        volume.symlinkSync(op.target, op.path);
        return true;
      }
      default: {
        volume.lchmodSync(op.path, op.mode);
        return false;
      }
    }
  } catch {
    return false;
  }
};

export const syncTabs = (
  volume: SyncVolume,
  channel: SyncChannel,
  self: string = crypto.randomUUID()
): TabSync => {
  const listeners = new Set<
    (structural: boolean, paths: readonly string[]) => void
  >();
  const pending: SyncOp[] = [];
  const flushWaiters = new Set<() => void>();
  let started = false;
  /** Set while a peer's mutation is applied: the volume reports it like any
   * other, and it must not echo back. */
  let applying = false;
  let serving: (() => Promise<void>) | null = null;
  let closed = false;

  const send = (message: SyncMessage): void => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no target origin (it reaches same-origin tabs only)
    channel.postMessage(message);
  };

  const applyAll = (ops: readonly SyncOp[]): void => {
    let structural = false;
    // Deduped, in arrival order: a batch may touch one path more than once.
    const changed = new Set<string>();
    applying = true;
    try {
      for (const op of ops) {
        structural = apply(volume, op) || structural;
        changed.add(op.op === "rename" ? op.to : op.path);
      }
    } finally {
      applying = false;
    }
    const paths = [...changed];
    for (const listener of listeners) {
      listener(structural, paths);
    }
  };

  const answerFlush = async (to: string): Promise<void> => {
    if (serving === null) {
      return;
    }
    try {
      await serving();
    } catch {
      // The saving tab retries its own save; the peer restores what landed.
    }
    if (!closed) {
      send({ kind: "flushed", to });
    }
  };

  const onMessage = (event: MessageEvent): void => {
    const message: unknown = event.data;
    if (closed || !isMessage(message)) {
      return;
    }
    if (message.kind === "flushed") {
      if (message.to === self) {
        for (const resolve of flushWaiters) {
          resolve();
        }
        flushWaiters.clear();
      }
      return;
    }
    if (message.kind === "flush") {
      void answerFlush(message.from);
      return;
    }
    if (started) {
      applyAll([message.op]);
    } else {
      pending.push(message.op);
    }
  };
  channel.addEventListener("message", onMessage);

  const stopWatching = volume.onMutation((mutation) => {
    if (applying || !started || closed) {
      return;
    }
    const op = toOp(volume, mutation);
    if (op !== null) {
      send({ from: self, kind: "op", op });
    }
  });

  return {
    close: () => {
      closed = true;
      stopWatching();
      channel.close();
      for (const resolve of flushWaiters) {
        resolve();
      }
      flushWaiters.clear();
      listeners.clear();
    },
    flushPeers: (timeoutMs) => {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      const answered = (): void => {
        resolve();
      };
      flushWaiters.add(answered);
      const timer = setTimeout(answered, timeoutMs);
      const cleanUp = async (): Promise<void> => {
        await promise;
        clearTimeout(timer);
        flushWaiters.delete(answered);
      };
      void cleanUp();
      send({ from: self, kind: "flush" });
      return promise;
    },
    onApplied: (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    serveFlush: (flush) => {
      serving = flush;
    },
    start: () => {
      if (started) {
        return;
      }
      started = true;
      applyAll(pending.splice(0));
    },
  };
};
