//! A synchronous write-through mirror of the preview's binding state.
//!
//! Binding data (Durable Objects, D1 and KV on SQLite; R2 as files) lives
//! under `/home/.noite/s` in the pod's main volume, and the pod saves that
//! volume to IndexedDB debounced — 250 ms after the last write. A reload
//! inside that window, or while the save is still in flight, loses writes
//! the preview already answered: the pagehide/visibilitychange flush is
//! fire-and-forget and the context dies with it. Process writes reach the
//! main volume synchronously, so every mutation is mirrored here
//! synchronously too, into sessionStorage — the one store with a synchronous
//! write that survives a same-tab reload. On boot the mirror is overlaid
//! after the IndexedDB restore. sessionStorage is per tab, and so is the
//! preview (`tab-sync.ts` never shares this directory): every tab records and
//! overlays its own preview's state. States past the size cap fall back to
//! IndexedDB alone.
//!
//! This module never imports the pod SDK (see `pod.ts`): the volume is the
//! structural slice it needs, and mutations arrive already classified.

import { base64ToBytes, bytesToBase64 } from "../../bytes";
/** Where the preview server keeps binding data (`HARNESS_STATE_DIR` in
 * `preview/server.ts` — pinned equal by the test below, never drifted). */
export const MIRRORED_STATE_ROOT = "/home/.noite/s";

/** sessionStorage is ~5 MB; past this the mirror drops out and IndexedDB is
 * the only copy again. Binding state is kilobytes (SQLite files, sidecars);
 * only large R2 objects can push past it. */
const MAX_MIRROR_CHARS = 1_000_000;

/** Mirror payload version, so a future shape never parses as this one. */
const MIRROR_VERSION = 1;

/** Files that are never durable state: R2's write-then-rename temporaries,
 * and SQLite's crash-recovery sidecars (restoring a stale journal would roll
 * a healthy database back). */
const isEphemeral = (relative: string): boolean => {
  const segments = relative.split("/");
  if (segments.some((segment) => segment.includes(".tmp-"))) {
    return true;
  }
  const base = segments.at(-1) ?? "";
  return (
    base.endsWith("-journal") || base.endsWith("-wal") || base.endsWith("-shm")
  );
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
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  onMutation: (callback: (mutation: MirrorMutation) => void) => () => void;
  readFileSync: (path: string) => Uint8Array;
  writeFileSync: (path: string, data: Uint8Array) => void;
}

/** The volume mutations the mirror cares about, classified by the caller
 * (`pod.ts`, which speaks the SDK's own union). Everything else is `ignore`. */
export type MirrorMutation =
  | { from: string; op: "rename"; to: string }
  | { op: "ignore" }
  | { op: "remove"; path: string }
  | { op: "write"; path: string };

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

/** The mirror's key: the workspace's own persistence id under its own
 * prefix, so one app and branch is one mirror. */
export const mirrorKey = (id: string): string => `noite:preview-state:${id}`;
interface MirrorDocument {
  files: Record<string, string>;
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
  return v === MIRROR_VERSION && isStringRecord(files);
};
const readDocument = (
  storage: MirrorStorage,
  id: string
): MirrorDocument | null => {
  let raw: string | null = null;
  try {
    raw = storage.getItem(mirrorKey(id));
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

const relativePath = (path: string): string | null => {
  if (!path.startsWith(`${MIRRORED_STATE_ROOT}/`)) {
    return null;
  }
  return path.slice(MIRRORED_STATE_ROOT.length + 1);
};

/** Overlay the mirror onto the volume (after the IndexedDB restore, before
 * anything reads binding state) and answer with how many files landed. A
 * missing or corrupt mirror is a no-op — corrupt entries are dropped so they
 * can never resurrect. */
export const restoreMirroredState = (
  volume: MirrorVolume,
  id: string,
  storage: MirrorStorage | null
): number => {
  if (storage === null) {
    return 0;
  }
  const document = readDocument(storage, id);
  if (document === null) {
    return 0;
  }
  let restored = 0;
  for (const [relative, base64] of Object.entries(document.files)) {
    if (relative === "" || relative.includes("..") || isEphemeral(relative)) {
      continue;
    }
    try {
      const path = `${MIRRORED_STATE_ROOT}/${relative}`;
      volume.mkdirSync(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      volume.writeFileSync(path, base64ToBytes(base64));
      restored += 1;
    } catch {
      // A file that will not decode or write stays on the restored copy.
    }
  }
  return restored;
};

/** Drop the mirror (a forgotten workspace forgets its preview state too). */
export const clearMirroredState = (
  id: string,
  storage: MirrorStorage | null
): void => {
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(mirrorKey(id));
  } catch {
    // Storage already gone; nothing to forget.
  }
};

/** Mirror every mutation under the state root into sessionStorage,
 * synchronously. Answers with the unsubscribe. Starts from the stored
 * mirror so an unrelated file never evicts the rest. */
export const mirrorStateDir = (
  volume: MirrorVolume,
  id: string,
  storage: MirrorStorage | null
): (() => void) => {
  if (storage === null) {
    return () => {
      // No storage, no subscription: nothing to stop.
    };
  }
  const files = new Map<string, string>(
    Object.entries(readDocument(storage, id)?.files ?? {})
  );
  let chars = [...files.values()].reduce((sum, entry) => sum + entry.length, 0);
  let suspended = false;

  const store = (): void => {
    const document: MirrorDocument = {
      files: Object.fromEntries(files),
      v: MIRROR_VERSION,
    };
    const raw = JSON.stringify(document);
    if (raw.length > MAX_MIRROR_CHARS) {
      suspended = true;
      clearMirroredState(id, storage);
      return;
    }
    try {
      storage.setItem(mirrorKey(id), raw);
    } catch {
      suspended = true;
      clearMirroredState(id, storage);
    }
  };

  const record = (path: string): void => {
    const relative = relativePath(path);
    if (relative === null || relative === "" || isEphemeral(relative)) {
      return;
    }
    let base64: string;
    try {
      base64 = bytesToBase64(volume.readFileSync(path));
    } catch {
      // Paged out or gone mid-write; the next mutation records it.
      return;
    }
    const previous = files.get(relative);
    files.set(relative, base64);
    chars += base64.length - (previous?.length ?? 0);
    store();
  };

  const forget = (path: string): void => {
    const relative = relativePath(path);
    if (relative === null || relative === "") {
      return;
    }
    let dropped = 0;
    for (const key of files.keys()) {
      if (key === relative || key.startsWith(`${relative}/`)) {
        dropped += files.get(key)?.length ?? 0;
        files.delete(key);
      }
    }
    if (dropped > 0) {
      chars -= dropped;
      store();
    }
  };

  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- volume mutations arrive as events, not promises
  return volume.onMutation((mutation) => {
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
};
