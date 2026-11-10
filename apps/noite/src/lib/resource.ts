import { Data } from "effect";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
//! Reactive resource cells over one shared Effect Cache — the ilha 0.16
//! data-fetching recipe (https://ilha.build/guide/recipes/data-fetching)
//! applied to the control UI's keyed resources. Replaces ilha 0.15's
//! `resource()`/`invalidate()`, which 0.16 removed.
//!
//! One Cache per module: every component on the page shares it. Concurrent
//! reads of one key share one lookup; later reads hit the cache until the
//! entry is invalidated. Each `tracked()` call is a mounted reader: it owns
//! one {@link ResourceState} atom and subscribes to reloads for its key.
//! The state paints the last good swr-store snapshot until the fresh fetch
//! lands, and keeps it visible (as `Reloading`) while a reload is in
//! flight — across SPA remounts and reloads.
//! A failed load is evicted, never cached: the shared cache keeps failures
//! forever, so the failure is dropped when it lands and a later mount (or an
//! explicit refetch) starts a fresh lookup. After a mutation call
//! `invalidate(key)` or `res.refetch()`.
import * as Atom from "effect/reactivity/Atom";
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import { readSwr, swrEpoch, writeSwr } from "./swr-store";

/** What one resource reader paints: one closed type, no parallel
 * `data`/`error`/`loading` atoms.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Loading: cold key (skeleton)
 *   [*] --> Ready: swr snapshot
 *   Loading --> Ready: fetch ok
 *   Loading --> Failed: fetch error
 *   Ready --> Reloading: invalidate / refetch
 *   Reloading --> Ready: fetch ok
 *   Reloading --> Failed: fetch error
 *   Failed --> Reloading: refetch
 * ```
 *
 * `Loading` is the only state that renders a skeleton, and it only happens
 * on a cold key. `Reloading` and `Failed` keep the last value so a panel
 * never blanks while it still has something true to show. */
export type ResourceState<T> = Data.TaggedEnum<{
  Failed: { readonly error: unknown; readonly value: T | undefined };
  Loading: Record<never, never>;
  Ready: { readonly value: T };
  Reloading: { readonly value: T };
}>;

interface ResourceStateDef extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: ResourceState<this["A"]>;
}

const State = Data.taggedEnum<ResourceStateDef>();

/** The value a reader paints, or undefined while it has none. */
export const resourceValue = <T>(state: ResourceState<T>): T | undefined => {
  switch (state._tag) {
    case "Loading": {
      return undefined;
    }

    case "Failed": {
      return state.value;
    }

    default: {
      return state.value;
    }
  }
};

/** What moves a {@link ResourceState}. */
export type ResourceEvent<T> =
  | { readonly error: unknown; readonly kind: "failed" }
  | { readonly kind: "loaded"; readonly value: T }
  | { readonly kind: "reload" };

/** The one transition function for {@link ResourceState}: a reload keeps the
 * value visible (`Reloading`), a failure keeps it too (`Failed`), and only a
 * cold `Loading` paints a skeleton. */
export const nextResourceState = <T>(
  state: ResourceState<T>,
  event: ResourceEvent<T>
): ResourceState<T> => {
  switch (event.kind) {
    case "loaded": {
      return State.Ready({ value: event.value });
    }

    case "failed": {
      return State.Failed({ error: event.error, value: resourceValue(state) });
    }

    case "reload": {
      const value = resourceValue(state);

      return value === undefined ? State.Loading() : State.Reloading({ value });
    }

    default: {
      return state;
    }
  }
};

/** The error a reader paints, or undefined when the last load succeeded. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- a load failure is any thrown value; `LoadError`/`errorMessage` consume the unknown.
export const resourceError = <T>(state: ResourceState<T>): unknown =>
  state._tag === "Failed" ? state.error : undefined;

/** What a resource hook returns: its state, a value projection of it (for
 * `watch` call sites — a read-only view, not a second source of truth), and
 * the reload trigger. */
export interface Resource<T> {
  refetch: () => Promise<T | undefined>;
  readonly state: AtomHandle<ResourceState<T>>;
  readonly value: AtomHandle<T | undefined>;
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

/** Keys whose snapshots stay in memory only (`tracked(..., { persist: false
 * })`): bulky entries that would crowd the small sessionStorage quota. */
const memoryOnly = new Set<string>();
const subs = new Map<string, Set<KeySub>>();

/** The Effect cache key for a resource key: the account epoch plus the key,
 * so a lookup that started before an auth change lands in a namespace no
 * reader asks for after the reset (the keys carry no account id). */
const cacheKey = (key: string): string => `${swrEpoch()}:${key}`;

/** The resource key behind an Effect cache key. */
const bareKey = (key: string): string => key.slice(key.indexOf(":") + 1);

/** One cache for every resource key: concurrent reads share one lookup,
 * later reads hit the entry until `invalidate` drops it. No TTL — entries
 * live until invalidated, like ilha 0.15's per-key cells. */
const cache = Effect.runSync(
  Cache.make({
    capacity: 1000,
    lookup: (effectKey: string) =>
      Effect.tryPromise({
        // oxlint-disable-next-line anti-slop/no-unknown-returns -- the cache is type-erased across keys; each key's readers own T and narrow on settle.
        catch: (cause: unknown): unknown => cause,
        try: async (signal: AbortSignal) => {
          const key = bareKey(effectKey);
          // The epoch this lookup was requested under (see `cacheKey`).
          const epoch = Number(effectKey.slice(0, effectKey.indexOf(":")));
          const run = fetchers.get(key);

          const value: unknown =
            run === undefined
              ? await Promise.reject<unknown>(
                  new Error(`no fetcher registered for resource "${key}"`)
                )
              : await run(key, { signal });

          // An auth change while the fetch was in flight makes this value the
          // previous account's; resource keys carry no account id, so only a
          // lookup still in the current epoch may write the snapshot.
          if (epoch === swrEpoch()) {
            writeSwr(
              key,
              value,
              memoryOnly.has(key) ? { persist: false } : undefined
            );
          }

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

  await Effect.runPromise(Cache.invalidate(cache, cacheKey(key)));

  try {
    const value = await Effect.runPromise(Cache.get(cache, cacheKey(key)));
    settleKey(key, generation, { ok: true, value });

    return value;
  } catch (error) {
    settleKey(key, generation, { error, ok: false });
    throw error;
  }
};

/** Serve the cache entry for `key` (concurrent mounts share one lookup) and
 * fan the landing out to every mounted reader. A failure is evicted, never
 * cached: the entry is dropped when the failure lands so a later mount (or
 * an explicit refetch) starts a fresh lookup instead of re-serving it. */
const settleGet = async (key: string, generation: number): Promise<void> => {
  try {
    const value = await Effect.runPromise(Cache.get(cache, cacheKey(key)));
    settleKey(key, generation, { ok: true, value });
  } catch (error) {
    settleKey(key, generation, { error, ok: false });

    if (generations.get(key) === generation) {
      await Effect.runPromise(Cache.invalidate(cache, cacheKey(key)));
    }
  }
};

/** First paint for a newly mounted reader: serve the cache (concurrent mounts
 * of one key share the lookup) and settle every mounted reader when it lands.
 * A failed load surfaces on every reader's `error` and evicts the entry, so
 * a remount refetches; nothing retries on a timer. */
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
    void Effect.runPromise(Cache.invalidate(cache, cacheKey(key)));

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

/** One mounted reader of `key`: one {@link ResourceState} atom subscribed to
 * reloads, seeded from the last good snapshot (lib/swr-store) so warm keys
 * skip skeletons; only `Loading` (a genuinely cold key) is one. `persist:
 * false` keeps the snapshot in memory only, for bulky entries (file
 * contents, build logs) that would crowd the small sessionStorage quota. A
 * failed load lands on `Failed` and evicts the entry, so a remount refetches;
 * nothing retries on a timer. */
export const tracked = <T>(
  key: string,
  fetcher: ResourceFetcher<T>,
  opts?: { persist?: boolean }
): Resource<T> => {
  fetchers.set(key, fetcher);

  if (opts?.persist === false) {
    memoryOnly.add(key);
  } else {
    memoryOnly.delete(key);
  }

  const snapshot = readSwr<T>(key);

  const state = atom<ResourceState<T>>(
    snapshot === undefined ? State.Loading() : State.Ready({ value: snapshot })
  );

  watch.once(() => {
    if (typeof document === "undefined") {
      // SSR: never fetch through the server (a self-fetch through the
      // public hostname fails DNS in the worker). The client's own mount
      // kicks the key when it hydrates; SSR paints the skeleton.
      return;
    }

    const sub: KeySub = {
      blank: (): void => {
        state.update((current) =>
          nextResourceState<T>(current, { kind: "reload" })
        );
      },
      settle: (outcome: SettleOutcome): void => {
        if (outcome.ok) {
          // SAFETY: the lookup ran this key's own fetcher, so the value is this key's T.
          state.update((current) =>
            nextResourceState<T>(current, {
              kind: "loaded",
              value: outcome.value as T,
            })
          );
        } else {
          state.update((current) =>
            nextResourceState<T>(current, {
              error: outcome.error,
              kind: "failed",
            })
          );
        }
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
    refetch: (): Promise<T | undefined> => {
      const settle = async (): Promise<T | undefined> => {
        const value = await reload(key);

        // SAFETY: the lookup ran this key's own fetcher, so the value is this key's T.
        return value as T;
      };

      return settle();
    },
    state,
    value: atom(
      Atom.readable((get): T | undefined => resourceValue(get(state.atom)))
    ),
  };
};
