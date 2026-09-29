//! Last-good snapshots behind `swrResource()` / `liveFeed()`: memory first
//! (survives SPA navigation even when storage is blocked), sessionStorage
//! underneath (survives reloads in the same tab, dies with it — no stale
//! cross-session data, no quota creep). Best-effort throughout: a missing,
//! corrupt or full store just means one ordinary skeleton.
//!
//! Everything here is user-scoped. `clearSwrStore()` runs on every auth
//! change (see `resetUserCaches`), so one account never paints another's
//! cached data.

import * as Atom from "effect/reactivity/Atom";
import { atom } from "ilha";
import type { AtomHandle } from "ilha";

const PREFIX = "swr:";
const memory = new Map<string, unknown>();

const storage = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // Storage blocked (private mode, cookies disabled): memory only.
    return null;
  }
};

/** Last good value for `key`, or undefined. The caller owns `T`: values are
 * only ever written by `writeSwr` for the same key. */
export const readSwr = <T>(key: string): T | undefined => {
  if (memory.has(key)) {
    // SAFETY: only writeSwr fills the map, always with this key's T.
    return memory.get(key) as T;
  }
  try {
    const raw = storage()?.getItem(PREFIX + key);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    // SAFETY: entries are only written by writeSwr as JSON of this key's T.
    const value = JSON.parse(raw) as T;
    memory.set(key, value);
    return value;
  } catch {
    return undefined;
  }
};

/** Remember `value` as the last good snapshot for `key`. Never throws.
 * `persist: false` keeps it in memory only — for bulky entries (file
 * contents) that would crowd the small sessionStorage quota. */
export const writeSwr = (
  key: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the store is intentionally untyped; readers own T for their key.
  value: unknown,
  opts?: { persist?: boolean }
): void => {
  memory.set(key, value);
  if (opts?.persist === false) {
    return;
  }
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota/full/disabled store: memory still has it for this document.
  }
};

/** Forget every snapshot (auth changed: they belong to the previous user). */
export const clearSwrStore = (): void => {
  memory.clear();
  const store = storage();
  if (!store) {
    return;
  }
  try {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k?.startsWith(PREFIX)) {
        stale.push(k);
      }
    }
    for (const k of stale) {
      store.removeItem(k);
    }
  } catch {
    // Best-effort, like the rest of the store.
  }
};

/** `source` while it has a value, else the stored snapshot for `key`.
 * The snapshot is read once, on the first render (atom inits are fixed by
 * their first call). Only `undefined` falls back: a fresh `null` (e.g. a
 * signed-out session) must win over a stored value. */
export const withSnapshot = <T>(
  key: string,
  source: AtomHandle<T | undefined>
): AtomHandle<T | undefined> => {
  const seed = readSwr<T>(key);
  return atom(
    Atom.readable((get): T | undefined => {
      const fresh = get(source.atom);
      return fresh === undefined ? seed : fresh;
    })
  );
};
