//! A synchronous write-through mirror of part of the pod's volume.
//!
//! The pod saves its volume to IndexedDB debounced — 250 ms after the last
//! write — and that save is asynchronous. A reload inside that window, or
//! while the save is still in flight, loses writes the pod already holds: the
//! pagehide/visibilitychange flush is fire-and-forget, and the frame's
//! document is torn down mid-commit. Writes reach the volume synchronously, so
//! every mutation under a mirrored root is copied here synchronously too, into
//! sessionStorage — the one store with a synchronous write that survives a
//! same-tab reload. On boot the mirror is overlaid after the IndexedDB
//! restore, removals included. sessionStorage is per tab: every tab records
//! and overlays its own writes. A mirror past the size cap drops out and
//! IndexedDB is the only copy again.
//!
//! `UNSAVED_PROJECT` uses it: the checkout's files, holding only what
//! IndexedDB has not saved yet — `pod.ts` clears it whenever a save leaves
//! nothing pending, so it never replays text older than the saved copy.
//!
//! This module never imports the pod SDK (see `pod.ts`): the volume is the
//! structural slice it needs, and mutations arrive already classified.

import { base64ToBytes, bytesToBase64 } from "../../bytes";
import { PROJECT_ROOT } from "./types";

/** Directory names never worth persisting: a restored `node_modules` is
 * rebuilt from `package.json` anyway, and the caches are the installer's.
 * IndexedDB skips them (`pod.ts`), and so does the project mirror. */
export const UNPERSISTED_DIRS = ["node_modules", ".cache", ".npm"];

/** sessionStorage is ~5 MB; past this a mirror drops out and IndexedDB is
 * the only copy again. Unsaved edits are kilobytes; only a fresh checkout's
 * first save can push past it. */
const MAX_MIRROR_CHARS = 1_000_000;

/** Mirror payload version, so a future shape never parses as this one. */
const MIRROR_VERSION = 1;

/** One mirrored part of the volume: the root it covers, its storage key
 * prefix, and the paths under the root it never records. */
export interface MirrorScope {
  key: string;
  root: string;
  skip: (relative: string) => boolean;
}

/** The checkout's writes IndexedDB has not saved yet. */
export const UNSAVED_PROJECT: MirrorScope = {
  key: "noite:unsaved-project",
  root: PROJECT_ROOT,
  skip: (relative) =>
    relative.split("/").some((segment) => UNPERSISTED_DIRS.includes(segment)),
};

/** The synchronous storage the mirror writes through (sessionStorage in the
 * page, a fake in tests). */
export interface MirrorStorage {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

/** The slice of the pod's volume the mirror needs — every call synchronous
 * on the main thread. */
export interface MirrorVolume {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  onMutation: (callback: (mutation: MirrorMutation) => void) => () => void;
  readdirSync: (path: string) => string[];
  readFileSync: (path: string) => Uint8Array;
  removeTreeSync: (path: string) => void;
  writeFileSync: (path: string, data: Uint8Array) => void;
}

/** The volume mutations the mirror cares about, classified by the caller
 * (`pod.ts`, which speaks the SDK's own union). Everything else is `ignore`. */
export type MirrorMutation =
  | { from: string; op: "rename"; to: string }
  | { op: "ignore" }
  | { op: "remove"; path: string }
  | { op: "write"; path: string };

/** A running mirror: `stop` ends the recording, `clear` empties it (and lets
 * a mirror that outgrew the cap record again). */
export interface Mirror {
  clear: () => void;
  stop: () => void;
}

/** sessionStorage's own access can throw (blocked storage); null means no
 * mirror this session, and IndexedDB stays the only copy. */
export const mirrorStorage = (): MirrorStorage | null => {
  try {
    if (typeof sessionStorage === "undefined") {
      return null;
    }
    return sessionStorage;
  } catch {
    return null;
  }
};

/** The mirror's key: the workspace's own persistence id under the scope's
 * prefix, so one app and branch is one mirror per scope. */
const mirrorKey = (scope: MirrorScope, id: string): string =>
  `${scope.key}:${id}`;

/** Stored shape: the newest bytes per relative path, and the paths removed
 * since (so a rename or delete is not undone by the older saved copy). */
interface MirrorDocument {
  files: Record<string, string>;
  removed?: string[];
  v: number;
}

const isString = (value: unknown): value is string => typeof value === "string";

const isStringRecord = (value: unknown): value is Record<string, string> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.values(value).every(isString);
};

const isDocument = (value: unknown): value is MirrorDocument => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("files" in value) || !("v" in value)) {
    return false;
  }
  const { files, v } = value;
  const removed = "removed" in value ? value.removed : undefined;
  const removedOk =
    removed === undefined ||
    (Array.isArray(removed) && removed.every(isString));
  return v === MIRROR_VERSION && isStringRecord(files) && removedOk;
};

const readDocument = (
  storage: MirrorStorage,
  scope: MirrorScope,
  id: string
): MirrorDocument | null => {
  let raw: string | null = null;
  try {
    raw = storage.getItem(mirrorKey(scope, id));
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** A relative path a mirror may act on: under the root, no `..`, not one
 * the scope skips. */
const usable = (scope: MirrorScope, relative: string): boolean =>
  relative !== "" && !relative.includes("..") && !scope.skip(relative);

/** Overlay the mirror onto the volume (after the IndexedDB restore, before
 * anything reads it) and answer with how many paths it changed. Removals go
 * first, so a path removed and written again ends up written. A missing or
 * corrupt mirror is a no-op — corrupt entries are dropped so they can never
 * resurrect. */
export const restoreMirror = (
  volume: MirrorVolume,
  scope: MirrorScope,
  id: string,
  storage: MirrorStorage | null
): number => {
  if (storage === null) {
    return 0;
  }
  const document = readDocument(storage, scope, id);
  if (document === null) {
    return 0;
  }
  let changed = 0;
  for (const relative of document.removed ?? []) {
    const path = `${scope.root}/${relative}`;
    if (!usable(scope, relative) || !volume.existsSync(path)) {
      continue;
    }
    try {
      volume.removeTreeSync(path);
      changed += 1;
    } catch {
      // A path that will not go stays on the restored copy.
    }
  }
  for (const [relative, base64] of Object.entries(document.files)) {
    if (!usable(scope, relative)) {
      continue;
    }
    try {
      const path = `${scope.root}/${relative}`;
      volume.mkdirSync(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      volume.writeFileSync(path, base64ToBytes(base64));
      changed += 1;
    } catch {
      // A file that will not decode or write stays on the restored copy.
    }
  }
  return changed;
};

/** Drop the stored mirror. */
const clearMirror = (
  scope: MirrorScope,
  id: string,
  storage: MirrorStorage | null
): void => {
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(mirrorKey(scope, id));
  } catch {
    // Storage already gone; nothing to forget.
  }
};

const NO_MIRROR: Mirror = {
  clear: () => {
    // No storage, no mirror: nothing to clear.
  },
  stop: () => {
    // No storage, no subscription: nothing to stop.
  },
};

/** Mirror every mutation under the scope's root into sessionStorage,
 * synchronously. Starts from the stored mirror so an unrelated file never
 * evicts the rest. */
// oxlint-disable-next-line max-lines-per-function -- one closure over the mirror's state: splitting it would only pass that state around
export const startMirror = (
  volume: MirrorVolume,
  scope: MirrorScope,
  id: string,
  storage: MirrorStorage | null
): Mirror => {
  if (storage === null) {
    return NO_MIRROR;
  }
  const stored = readDocument(storage, scope, id);
  const files = new Map<string, string>(Object.entries(stored?.files ?? {}));
  const removed = new Set<string>(stored?.removed);
  let suspended = false;

  const store = (): void => {
    const document: MirrorDocument = {
      files: Object.fromEntries(files),
      removed: [...removed],
      v: MIRROR_VERSION,
    };
    const raw = JSON.stringify(document);
    if (raw.length > MAX_MIRROR_CHARS) {
      suspended = true;
      clearMirror(scope, id, storage);
      return;
    }
    try {
      storage.setItem(mirrorKey(scope, id), raw);
    } catch {
      suspended = true;
      clearMirror(scope, id, storage);
    }
  };

  const relativeOf = (path: string): string | null =>
    path.startsWith(`${scope.root}/`)
      ? path.slice(scope.root.length + 1)
      : null;

  /** Record the file at `path`, or every file under it when it is a
   * directory (a renamed folder arrives as one mutation). */
  const collect = (path: string, relative: string): void => {
    try {
      files.set(relative, bytesToBase64(volume.readFileSync(path)));
      removed.delete(relative);
      return;
    } catch {
      // Not a readable file: a directory, or gone mid-write.
    }
    let names: string[];
    try {
      names = volume.readdirSync(path);
    } catch {
      // Gone mid-write; the next mutation records it.
      return;
    }
    removed.delete(relative);
    for (const name of names) {
      const child = `${relative}/${name}`;
      if (usable(scope, child)) {
        collect(`${path}/${name}`, child);
      }
    }
  };

  const record = (path: string): void => {
    const relative = relativeOf(path);
    if (relative === null || !usable(scope, relative)) {
      return;
    }
    collect(path, relative);
    store();
  };

  const forget = (path: string): void => {
    const relative = relativeOf(path);
    if (relative === null || !usable(scope, relative)) {
      return;
    }
    for (const key of files.keys()) {
      if (key === relative || key.startsWith(`${relative}/`)) {
        files.delete(key);
      }
    }
    removed.add(relative);
    store();
  };

  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- volume mutations arrive as events, not promises
  const unsubscribe = volume.onMutation((mutation) => {
    if (suspended) {
      return;
    }
    try {
      if (mutation.op === "write") {
        record(mutation.path);
      } else if (mutation.op === "remove") {
        forget(mutation.path);
      } else if (mutation.op === "rename") {
        forget(mutation.from);
        record(mutation.to);
      }
    } catch {
      // The mirror must never break a write; IndexedDB still saves it.
    }
  });

  return {
    clear: () => {
      files.clear();
      removed.clear();
      suspended = false;
      clearMirror(scope, id, storage);
    },
    stop: unsubscribe,
  };
};
