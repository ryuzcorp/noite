/** Stale-while-revalidate over sessionStorage for app pages: paint the last
 * good value instantly (survives reloads in the same tab, so the view never
 * jumps back to skeletons), then refresh in the background. sessionStorage —
 * not localStorage — so entries die with the tab: no stale cross-session
 * data, no quota creep. Values must be JSON-safe (all RPC payloads are).
 * Best-effort throughout: a missing/corrupt/full store just means a normal
 * fetch. */
const prefix = "swr:";

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
    return JSON.parse(raw) as T;
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
