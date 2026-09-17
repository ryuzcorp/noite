/** Stale-while-revalidate over sessionStorage for app pages: paint the last
 * good value instantly (survives reloads in the same tab, so the view never
 * jumps back to skeletons), then refresh in the background. sessionStorage —
 * not localStorage — so entries die with the tab: no stale cross-session
 * data, no quota creep. Values must be JSON-safe (all RPC payloads are).
 * Best-effort throughout: a missing/corrupt/full store just means a normal
 * fetch. */
const prefix = "swr:";

/** L1: in-memory last-good values. Survives SPA tab switches even when
 * sessionStorage is unavailable/full/blocked; sessionStorage (L2) adds
 * survival across reloads. Writes populate both, reads try L1 first. */
const memory = new Map<string, unknown>();

const store = (): Storage | null => {
  if (typeof sessionStorage === "undefined") {
    return null;
  }
  try {
    return sessionStorage;
  } catch {
    // Storage blocked (private mode, cookies disabled) — fetch fresh.
    return null;
  }
};

/** Last good value for `key`, or null (missing, corrupt, or no store). */
export const readSwrCache = <T>(key: string): T | null => {
  if (memory.has(prefix + key)) {
    // SAFETY: only writeSwrCache populates this map, always with a T for
    // its key (same generic call sites read it back).
    return memory.get(prefix + key) as T;
  }
  const storage = store();
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(prefix + key);
    if (!raw) {
      return null;
    }
    // SAFETY: entries are only ever written by writeSwrCache below as JSON
    // of T; a shape mismatch throws in the caller and is caught there — the
    // try/catch here covers malformed JSON, and callers validate before use.
    const value = JSON.parse(raw) as T;
    memory.set(prefix + key, value);
    return value;
  } catch {
    return null;
  }
};

type SwrCacheValue =
  | string
  | number
  | boolean
  | null
  | SwrCacheValue[]
  | { [key: string]: SwrCacheValue };

/** Remember the last good value for `key`. Never throws. */
export const writeSwrCache = (key: string, value: SwrCacheValue): void => {
  memory.set(prefix + key, value);
  const storage = store();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(prefix + key, JSON.stringify(value));
  } catch {
    // Quota/full/disabled store — the cache is best-effort, fetch fresh.
  }
};
