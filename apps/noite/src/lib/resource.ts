//! Reactive resource cells over one shared Effect Cache — the ilha 0.16
//! data-fetching recipe (https://ilha.build/guide/recipes/data-fetching)
//! applied to the control UI's keyed resources. Replaces ilha 0.15's
//! `resource()`/`invalidate()`, which 0.16 removed.
//!
//! One Cache per module: every component on the page shares it. Concurrent
//! reads of one key share one lookup; later reads hit the cache until the
//! entry is invalidated. Each `tracked()` call is a mounted reader: it owns
//! `data`/`error`/`loading` atoms (so `loading() && data() === undefined`
//! still gates skeletons) and subscribes to reloads for its key. `data`
//! paints the last good swr-store snapshot until the fresh fetch lands, and
//! blanks while a reload is in flight — across SPA remounts and reloads.
//! After a mutation call `invalidate(key)` or `res.refetch()`.
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import { readSwr, withSnapshot, writeSwr } from "./swr-store";

/** What a resource hook returns (the ilha 0.15 `Resource` shape, kept so
 * every panel keeps its `data()`/`loading()`/`error()`/`refetch()` reads). */
export interface Resource<T> {
  readonly data: AtomHandle<T | undefined>;
  readonly error: AtomHandle<unknown>;
  readonly loading: AtomHandle<boolean>;
  refetch: () => Promise<T | undefined>;
}

/** Async fetch scoped to a resource key. Receives an abort signal, like the
 * ilha 0.15 fetcher; most server fetchers ignore it. */
export type ResourceFetcher<T> = (
  key: string,
  ctx: { signal: AbortSignal }
) => Promise<T>;

/** How a settled lookup lands: a fresh value, or the rejection to record. */
type SettleOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

/** One mounted reader of a key: blanked when a reload starts, settled when
 * the lookup lands. */
interface KeySub {
  blank: () => void;
  settle: (outcome: SettleOutcome) => void;
}

/** Latest fetcher per key (re-registered on every render, so a reload always
 * runs the current closure), the reload generation that guards stale wins,
 * and every mounted reader per key. */
const fetchers = new Map<string, ResourceFetcher<unknown>>();
const generations = new Map<string, number>();
const subs = new Map<string, Set<KeySub>>();

/** One cache for every resource key: concurrent reads share one lookup,
 * later reads hit the entry until `invalidate` drops it. No TTL — entries
 * live until invalidated, like ilha 0.15's per-key cells. */
const cache = Effect.runSync(
  Cache.make({
    capacity: 1000,
    lookup: (key: string) =>
      Effect.tryPromise({
        // oxlint-disable-next-line anti-slop/no-unknown-returns -- the cache is type-erased across keys; each key's readers own T and narrow on settle.
        catch: (cause: unknown): unknown => cause,
        try: async (signal: AbortSignal) => {
          const run = fetchers.get(key);
          const value: unknown =
            run === undefined
              ? await Promise.reject<unknown>(
                  new Error(`no fetcher registered for resource "${key}"`)
                )
              : await run(key, { signal });
          writeSwr(key, value);
          return value;
        },
      }),
  })
);

/** Fan one settled lookup out to every mounted reader of `key`, unless a
 * newer reload started since. */
const settleKey = (
  key: string,
  generation: number,
  outcome: SettleOutcome
): void => {
  if (generations.get(key) !== generation) {
    return;
  }
  const readers = subs.get(key);
  if (readers === undefined) {
    return;
  }
  for (const sub of readers) {
    sub.settle(outcome);
  }
};

/** Drop the cache entry and reload every mounted reader. The promise settles
 * with the fresh value, or rejects so `refetch()` callers can `catch` it
 * like before (the error is also recorded on each reader's `error`). */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- the reload promise is type-erased across keys; refetch() narrows to its key's T.
const reload = async (key: string): Promise<unknown> => {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  const readers = subs.get(key);
  if (readers !== undefined) {
    for (const sub of readers) {
      sub.blank();
    }
  }
  await Effect.runPromise(Cache.invalidate(cache, key));
  try {
    const value = await Effect.runPromise(Cache.get(cache, key));
    settleKey(key, generation, { ok: true, value });
    return value;
  } catch (error) {
    settleKey(key, generation, { error, ok: false });
    throw error;
  }
};

/** Serve the cache entry for `key` (concurrent mounts share one lookup) and
 * fan the landing out to every mounted reader. */
const settleGet = async (key: string, generation: number): Promise<void> => {
  try {
    const value = await Effect.runPromise(Cache.get(cache, key));
    settleKey(key, generation, { ok: true, value });
  } catch (error) {
    settleKey(key, generation, { error, ok: false });
  }
};

/** First paint for a newly mounted reader: serve the cache (concurrent mounts
 * of one key share the lookup) and settle every mounted reader when it lands. */
const kick = (key: string): void => {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  void settleGet(key, generation);
};

/** Drop the cached entry for `key` and reload every mounted reader. A key
 * with no readers just evicts, so the next mount refetches. */
export const invalidate = (key: string): void => {
  const readers = subs.get(key);
  if (readers === undefined || readers.size === 0) {
    void Effect.runPromise(Cache.invalidate(cache, key));
    return;
  }
  void (async (): Promise<void> => {
    try {
      await reload(key);
    } catch {
      // The rejection is already recorded on every reader's `error`.
    }
  })();
};

/** One mounted reader of `key`: per-component `data`/`error`/`loading` atoms
 * subscribed to reloads, with the last good snapshot (lib/swr-store) painting
 * until the fresh fetch lands. `data` seeds from the snapshot, so warm keys
 * skip skeletons; consumers keep the usual `loading() && data() ===
 * undefined` skeleton check — it now only fires on a genuinely cold key. */
export const tracked = <T>(
  key: string,
  fetcher: ResourceFetcher<T>
): Resource<T> => {
  fetchers.set(key, fetcher);
  const data = atom<T | undefined>(readSwr<T>(key));
  // oxlint-disable-next-line unicorn/no-useless-undefined -- the cell starts without an error; undefined is the seed
  const error = atom<unknown>(undefined);
  const loading = atom<boolean>(true);
  watch.once(() => {
    if (typeof document === "undefined") {
      // SSR: never fetch through the server (a self-fetch through the
      // public hostname fails DNS in the worker). The client's own mount
      // kicks the key when it hydrates; SSR paints the skeleton.
      return;
    }
    const sub: KeySub = {
      blank: (): void => {
        data.set(undefined);
        error.set(undefined);
        loading.set(true);
      },
      settle: (outcome: SettleOutcome): void => {
        if (outcome.ok) {
          // SAFETY: the lookup ran this key's own fetcher, so the value is this key's T.
          data.set(outcome.value as T);
          error.set(undefined);
        } else {
          error.set(outcome.error);
        }
        loading.set(false);
      },
    };
    const readers = subs.get(key);
    if (readers === undefined) {
      subs.set(key, new Set<KeySub>([sub]));
    } else {
      readers.add(sub);
    }
    kick(key);
    return (): void => {
      const live = subs.get(key);
      if (live === undefined) {
        return;
      }
      live.delete(sub);
      if (live.size === 0) {
        subs.delete(key);
      }
    };
  });
  return {
    data: withSnapshot(key, data),
    error,
    loading,
    refetch: (): Promise<T | undefined> => {
      const settle = async (): Promise<T | undefined> => {
        const value = await reload(key);
        // SAFETY: the lookup ran this key's own fetcher, so the value is this key's T.
        return value as T;
      };
      return settle();
    },
  };
};
