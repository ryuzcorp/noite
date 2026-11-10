//! SSE feed URLs + throwing decoders for the control UI live panels.
//!
//! Each decoder parses one `message` frame and throws on a bad frame (so
//! `liveFeed` skips it). Shape checks are `Array.isArray` guards —
//! the runner ships no effect/Schema codecs for these payloads.
import { Data } from "effect";
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import type {
  ErrorStatus,
  RunnerAppState,
  RunnerDeploy,
  RunnerErrorList,
  RunnerEvent,
  RunnerInsight,
  RunnerApp,
} from "./runner";
import { readSwr, swrEpoch, writeSwr } from "./swr-store";

/** One stream's connection state, shared by the EventSource manager and the
 * hub's per-topic view. One closed type; {@link nextConn} is the only
 * transition function, and an event that is illegal for the current state
 * leaves it unchanged.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Idle
 *   Idle --> Connecting: connect
 *   Connecting --> Open: opened | frame
 *   Open --> Retrying: transport-lost | source-dead
 *   Connecting --> Retrying: transport-lost | source-dead
 *   Retrying --> Connecting: connect (backoff elapsed)
 *   Connecting --> Refused: refused (4xx from the hub)
 *   any --> Paused: hide
 *   Paused --> Connecting: show
 *   any --> Closed: dispose
 * ```
 *
 * `Open` means a frame arrived, not merely that the HTTP response opened:
 * the hub marks a topic open on its bare `+` marker before any payload, and
 * "open without data" must stay distinguishable from "loaded". */
export type Conn = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Connecting: Record<never, never>;
  Open: Record<never, never>;
  Retrying: { readonly cause: "transport" | "lost" };
  Refused: Record<never, never>;
  Paused: Record<never, never>;
  Closed: Record<never, never>;
}>;

export const ConnTypes = Data.taggedEnum<Conn>();

/** What moves a {@link Conn}. */
export type ConnEvent =
  | { readonly kind: "connect" }
  | { readonly kind: "dispose" }
  | { readonly kind: "frame" }
  | { readonly kind: "hide" }
  | { readonly kind: "opened" }
  | { readonly kind: "refused" }
  | { readonly kind: "show" }
  | { readonly kind: "source-dead" }
  | { readonly kind: "transport-lost" };

/** The one transition function for {@link Conn}. */
export const nextConn = (state: Conn, event: ConnEvent): Conn => {
  switch (event.kind) {
    case "connect": {
      return state._tag === "Connecting" || state._tag === "Open"
        ? state
        : ConnTypes.Connecting();
    }

    case "frame":
    case "opened": {
      return state._tag === "Closed" || state._tag === "Paused"
        ? state
        : ConnTypes.Open();
    }

    case "refused": {
      return ConnTypes.Refused();
    }

    case "transport-lost": {
      return ConnTypes.Retrying({ cause: "transport" });
    }

    case "source-dead": {
      return ConnTypes.Retrying({ cause: "lost" });
    }

    case "hide": {
      return ConnTypes.Paused();
    }

    case "show": {
      return ConnTypes.Connecting();
    }

    case "dispose": {
      return ConnTypes.Closed();
    }

    default: {
      return state;
    }
  }
};

/** What one live panel paints. One closed type: `Cold` is the only state
 * that renders a skeleton, and it only happens on a key with no snapshot and
 * no frame. `Cached` is the swr-store snapshot (a previous visit), `Live` is
 * at least one frame from the current stream, and the last four carry the
 * best value so far while the link is down, refused, paused or gone.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Cold: no snapshot
 *   [*] --> Cached: snapshot on disk
 *   Cold --> Cached: initial snapshot
 *   Cold --> Live: first frame
 *   Cached --> Live: first frame
 *   Cold --> Reconnecting: link retrying
 *   Cached --> Reconnecting: link retrying
 *   Live --> Reconnecting: link retrying
 *   Reconnecting --> Live: next frame
 *   Reconnecting --> Refused: 4xx
 *   any --> Paused: tab hidden
 *   any --> Offline: no EventSource / disposed
 * ```
 */
export type FeedState<T> = Data.TaggedEnum<{
  Cached: { readonly value: T };
  Cold: Record<never, never>;
  Live: { readonly value: T };
  Offline: { readonly value: T | undefined };
  Paused: { readonly value: T | undefined };
  Reconnecting: { readonly value: T | undefined };
  Refused: { readonly value: T | undefined };
}>;

interface FeedStateDef extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: FeedState<this["A"]>;
}

const Feed = Data.taggedEnum<FeedStateDef>();

/** What a live panel reads: its state. `feedValue` is the one value reader. */
export interface LiveFeed<T> {
  readonly state: AtomHandle<FeedState<T>>;
}

/** The value a panel paints, or undefined while the key is cold. */
export const feedValue = <T>(state: FeedState<T>): T | undefined =>
  state._tag === "Cold" ? undefined : state.value;

/** Whether a panel has anything real to paint (`Cold` is the only state
 * without a value: a settled snapshot or frame always carries one). */
export const feedLoaded = <T>(state: FeedState<T>): boolean =>
  feedValue(state) !== undefined;

/** Whether the link is retrying: the value (when there is one) is stale. */
export const feedRetrying = (state: FeedState<unknown>): boolean =>
  state._tag === "Reconnecting";

/** Whether the panel is still waiting for any data: the only skeleton. A
 * refused or offline feed is not loading, it is not coming. */
export const feedLoading = <T>(state: FeedState<T>): boolean =>
  state._tag === "Cold";

/** A short reason the feed cannot deliver data (terminal refusal, no
 * transport), or null while it can. Panels render this instead of an endless
 * skeleton or a misleading empty state. */
export const feedProblem = <T>(state: FeedState<T>): string | null => {
  switch (state._tag) {
    case "Refused": {
      return "This feed was refused. Reload the page to try again.";
    }

    case "Offline": {
      return "Live updates are unavailable. Reload the page to try again.";
    }

    default: {
      return null;
    }
  }
};

/** What moves a {@link FeedState}. */
export type FeedEvent<T> =
  | { readonly kind: "conn"; readonly conn: Conn }
  | { readonly kind: "frame"; readonly value: T }
  | { readonly kind: "snapshot"; readonly value: T };

/** The one transition function for {@link FeedState}. A frame always wins; a
 * snapshot only fills a cold or cached panel (the stream stays the live
 * source, and `paintInitial` guards the write anyway). */
export const nextFeedState = <T>(
  state: FeedState<T>,
  event: FeedEvent<T>
): FeedState<T> => {
  switch (event.kind) {
    case "frame": {
      return Feed.Live({ value: event.value });
    }

    case "snapshot": {
      // A frame (or an earlier snapshot) always wins; otherwise the snapshot
      // fills the panel without losing what the link is doing (a stream that
      // failed first must not drop the snapshot the panel fetched instead).
      if (state._tag === "Live" || feedValue(state) !== undefined) {
        return state;
      }

      switch (state._tag) {
        case "Refused": {
          return Feed.Refused({ value: event.value });
        }

        case "Offline": {
          return Feed.Offline({ value: event.value });
        }

        case "Paused": {
          return Feed.Paused({ value: event.value });
        }

        case "Reconnecting": {
          return Feed.Reconnecting({ value: event.value });
        }

        case "Cold":
        case "Cached": {
          return Feed.Cached({ value: event.value });
        }

        default: {
          return state;
        }
      }
    }

    case "conn": {
      if (state._tag === "Refused") {
        return state;
      }

      const value = feedValue(state);

      switch (event.conn._tag) {
        case "Refused": {
          return Feed.Refused({ value });
        }

        case "Paused": {
          return Feed.Paused({ value });
        }

        case "Closed": {
          return Feed.Offline({ value });
        }

        case "Retrying": {
          return Feed.Reconnecting({ value });
        }

        // Idle/Connecting/Open say nothing about the data: keep painting
        // what we have until a frame arrives.
        default: {
          return state;
        }
      }
    }

    default: {
      return state;
    }
  }
};

/** What a reconnecting stream reports back to its owner (ilha atoms in
 * `liveFeed`, plain collectors in the unit tests). */
export interface StreamHooks {
  onConn: (conn: Conn) => void;
  onMessage: (data: string) => void;
}

/** Reconnect tuning for {@link connectStream} (tests pass millisecond
 * budgets; the UI keeps the defaults). */
export interface StreamRetryOptions {
  /** First reconnect delay; doubles per attempt. Default 1 s. */
  baseMs?: number;
  /** Delay cap (jitter included). Default 30 s. */
  capMs?: number;
  /** 0..1 random source for the jitter; pass `() => 0` for exact delays. */
  random?: () => number;
  /** EventSource constructor; default `globalThis.EventSource`. */
  source?: typeof EventSource;
}

const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = RETRY_BASE_MS * 30;

/** `readyState` a dead source reports (`EventSource.CLOSED`). */
const SOURCE_CLOSED = 2;

/** Framework-free EventSource manager behind `liveFeed`: opens the stream,
 * reopens a CLOSED source itself with capped exponential backoff plus jitter
 * (resetting on `open`), closes on hidden tabs and reopens on visible, never
 * holds two live sources, and tears down timers and listeners on dispose.
 * Every state change goes through {@link nextConn}. Native `EventSource`
 * retries transport drops on its own — but after an HTTP error response (any
 * non-2xx, or a wrong content-type such as a 404 page, or a 500/502/503
 * while the control fleet or runner restarts) `readyState` goes CLOSED and it
 * gives up for good; without this the panel would show "retrying" forever
 * without retrying. Returns the dispose function. */
export const connectStream = (
  url: string,
  hooks: StreamHooks,
  options: StreamRetryOptions = {}
): (() => void) => {
  const baseMs = options.baseMs ?? RETRY_BASE_MS;
  const capMs = options.capMs ?? RETRY_CAP_MS;
  const random = options.random ?? Math.random;
  const Source = options.source ?? globalThis.EventSource;

  let conn: Conn = ConnTypes.Idle();
  let source: EventSource | undefined;
  /** Listeners on `source`; removed before it is closed, so a task the
   * browser queued before `close()` cannot deliver a stale account's frame. */
  let listeners: { fn: (event: Event) => void; type: string }[] = [];
  // Pending-reopen generation: scheduling bumps it and each timer only fires
  // for its own generation, so a stale timer can never open a second source.
  let pending = 0;
  let attempts = 0;
  let disposed = false;

  const emit = (event: ConnEvent): void => {
    conn = nextConn(conn, event);
    hooks.onConn(conn);
  };

  if (Source === undefined) {
    // No EventSource at all: terminal, not retrying.
    emit({ kind: "dispose" });

    return () => {
      // No source exists, so there is nothing to dispose.
    };
  }

  const clearTimer = (): void => {
    pending += 1;
  };

  const schedule = (): void => {
    const backoff = Math.min(capMs, baseMs * 2 ** attempts);
    attempts += 1;
    const delay = Math.min(capMs, backoff + Math.floor(random() * baseMs));
    pending += 1;
    const seen = pending;
    setTimeout(() => {
      if (seen === pending) {
        // oxlint-disable-next-line eslint/no-use-before-define -- open/schedule are mutually recursive (a reopen schedules the next open).
        open();
      }
    }, delay);
  };

  const open = (): void => {
    if (disposed || source !== undefined) {
      return;
    }

    // T1.9: background tabs hold no connection. The SWR snapshot keeps the
    // panel painted while away.
    if (typeof document !== "undefined" && document.hidden) {
      emit({ kind: "hide" });

      return;
    }

    emit({ kind: "connect" });
    const next = new Source(url);
    source = next;

    const onOpen = (): void => {
      if (source !== next) {
        return;
      }

      attempts = 0;
      emit({ kind: "opened" });
    };

    const onError = (): void => {
      if (source !== next) {
        return;
      }

      if (next.readyState === SOURCE_CLOSED) {
        source = undefined;

        emit({ kind: "source-dead" });
        schedule();
      } else {
        emit({ kind: "transport-lost" });
      }
    };

    const onMessage = (event: MessageEvent<string>): void => {
      if (source !== next) {
        return;
      }

      // A frame proves the stream is open even when the browser has not
      // dispatched `open` yet: dropping that distinction made a frame that
      // landed before `open` paint as "connecting" (not loaded) while its
      // data was already there.
      if (conn._tag !== "Open") {
        emit({ kind: "frame" });
      }

      hooks.onMessage(event.data);
    };

    // SAFETY: `addEventListener` accepts a listener typed for the event it is
    // registered for; these narrow it back to their own event type inside.
    const onErrorEvent = onError as (event: Event) => void;
    // SAFETY: same as above — the "message" listener receives a MessageEvent.
    const onMessageEvent = onMessage as (event: Event) => void;

    listeners = [
      { fn: onErrorEvent, type: "error" },
      { fn: onMessageEvent, type: "message" },
      { fn: onOpen, type: "open" },
    ];

    for (const { fn, type } of listeners) {
      next.addEventListener(type, fn);
    }
  };

  const close = (): void => {
    clearTimer();

    if (source !== undefined) {
      for (const { fn, type } of listeners) {
        source.removeEventListener(type, fn);
      }

      source.close();
    }

    listeners = [];
    source = undefined;
  };

  const onVisibility = (): void => {
    if (typeof document === "undefined") {
      return;
    }

    if (document.hidden) {
      close();
      emit({ kind: "hide" });
    } else {
      open();
    }
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  open();

  return () => {
    disposed = true;

    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }

    close();
    emit({ kind: "dispose" });
  };
};

/** The one connection a page streams every feed over. A topic is a feed's
 * own stream path (`deploysUrl(…)` and friends); the server runs that
 * route's handler and relays its frames (see `http/routes/stream-hub.ts`). */
export const streamHubUrl = (topics: readonly string[]): string =>
  `/api/streams?${topics.map((topic) => `t=${encodeURIComponent(topic)}`).join("&")}`;

/** A page's feed subscriptions, multiplexed onto one EventSource. */
export interface StreamHub {
  /** Forget every retained frame and reopen the connection: one account's
   * frame must never replay into the next account's panels (see
   * `resetStreamHub`). Subscribers stay subscribed. */
  reset: () => void;
  /** Start receiving `topic`; answers the unsubscribe. A topic two panels
   * share is streamed once, and a late subscriber gets its last frame. */
  subscribe: (topic: string, hooks: StreamHooks) => () => void;
}

/** Hub tuning: the connection's retry options plus when a changed topic set
 * is applied. */
export interface StreamHubOptions extends StreamRetryOptions {
  /** Runs the reopen once the set settles. Default: 30 ms later, so a
   * re-render's unsubscribe and resubscribe cancel out. Tests run it by
   * hand. */
  settle?: (reopen: () => void) => void;
}

/** What the shared connection has said about one topic. `live` only after a
 * data frame: the hub's `+` marker opens the topic without payload, and a
 * panel must not read that as loaded. */
type TopicPhase = "pending" | "live" | "refused" | "retrying";

interface HubTopic {
  /** The last frame, replayed to a subscriber that joins later. */
  last: string | undefined;
  /** This topic's own state on the current connection. */
  phase: TopicPhase;
  subs: Set<StreamHooks>;
}

/** Browsers allow six HTTP/1.1 connections per host and an EventSource
 * holds one for good, so one EventSource per feed starved every page with
 * six feeds of its own navigation and fetches (the Deployments tab with an
 * environment froze on plain-HTTP installs). The hub keeps one connection
 * for all of them: subscribing or leaving reopens it with the new topic set
 * once the set settles, and the server re-sends each topic's snapshot.
 *
 * The topic table is the whole state: `connection` (the link), `connected`
 * (the topic order on the wire), each topic's `phase` and `last` frame. */
export const createStreamHub = (options: StreamHubOptions = {}): StreamHub => {
  const schedule =
    options.settle ??
    ((reopen: () => void) => {
      setTimeout(reopen, 30);
    });

  const topics = new Map<string, HubTopic>();
  /** The topics the open connection carries, in its frames' index order. */
  let connected: string[] = [];
  let connection: Conn = ConnTypes.Closed();
  let dispose: (() => void) | undefined;
  let settling = false;

  // The link's state except that a topic only counts as open once a frame
  // landed; a `+` (opened, no frame) stays `connecting`.
  const statusOf = (topic: HubTopic): Conn => {
    if (topic.phase === "refused") {
      return ConnTypes.Refused();
    }

    if (dispose === undefined) {
      return ConnTypes.Connecting();
    }

    if (connection._tag !== "Open") {
      return connection;
    }

    switch (topic.phase) {
      case "live": {
        return connection;
      }

      case "retrying": {
        return ConnTypes.Retrying({ cause: "lost" });
      }

      default: {
        return ConnTypes.Connecting();
      }
    }
  };

  const announce = (topic: HubTopic): void => {
    const conn = statusOf(topic);

    for (const sub of topic.subs) {
      sub.onConn(conn);
    }
  };

  const setPhase = (topic: HubTopic, phase: TopicPhase): void => {
    if (topic.phase === phase) {
      return;
    }

    topic.phase = phase;
    announce(topic);
  };

  const onMessage = (data: string): void => {
    // `<index>:<frame>`, or `<index>:+` / `<index>:!` / `<index>:~<status>`
    // for a topic that opened / dropped / was refused (see
    // `http/routes/stream-hub.ts`).
    const colon = data.indexOf(":");

    const name =
      colon > 0 ? connected[Number(data.slice(0, colon))] : undefined;

    const topic = name === undefined ? undefined : topics.get(name);

    if (topic === undefined) {
      return;
    }

    const payload = data.slice(colon + 1);

    if (payload === "+") {
      setPhase(topic, "pending");

      return;
    }

    if (payload === "!") {
      setPhase(topic, "retrying");

      return;
    }

    if (payload.startsWith("~")) {
      setPhase(topic, "refused");

      return;
    }

    topic.last = payload;
    setPhase(topic, "live");

    for (const sub of topic.subs) {
      sub.onMessage(payload);
    }
  };

  const reconcile = (): void => {
    settling = false;

    for (const [name, topic] of topics) {
      if (topic.subs.size === 0) {
        topics.delete(name);
      }
    }

    const wanted = [...topics.keys()];

    const same =
      wanted.length === connected.length &&
      wanted.every((name) => connected.includes(name));

    if (same && dispose !== undefined) {
      return;
    }

    dispose?.();
    dispose = undefined;
    connected = wanted;

    for (const topic of topics.values()) {
      // A fresh connection replays every topic: no frame yet.
      topic.phase = "pending";
    }

    if (wanted.length === 0) {
      connection = ConnTypes.Closed();

      return;
    }

    dispose = connectStream(
      streamHubUrl(wanted),
      {
        onConn: (next) => {
          connection = next;

          for (const topic of topics.values()) {
            announce(topic);
          }
        },
        onMessage,
      },
      options
    );
  };

  const settle = (): void => {
    if (!settling) {
      settling = true;
      schedule(reconcile);
    }
  };

  return {
    reset: () => {
      for (const topic of topics.values()) {
        topic.last = undefined;
      }

      dispose?.();
      dispose = undefined;
      reconcile();
    },
    subscribe: (name, hooks) => {
      let topic = topics.get(name);

      if (topic === undefined) {
        topic = {
          last: undefined,
          phase: "pending",
          subs: new Set<StreamHooks>(),
        };
        topics.set(name, topic);
      }

      if (!connected.includes(name) || dispose === undefined) {
        settle();
      }

      topic.subs.add(hooks);
      hooks.onConn(statusOf(topic));

      if (topic.last !== undefined) {
        hooks.onMessage(topic.last);
      }

      return () => {
        // The topic itself goes once the set settles, so a remount within
        // the window keeps its frame and its place on the connection.
        if (topics.get(name)?.subs.delete(hooks) === true) {
          settle();
        }
      };
    },
  };
};

/** In-flight initial snapshots by feed key: panels that share one key (the
 * Errors tab badge and the list) share one fetch instead of doubling it. */
const initialInflight = new Map<string, Promise<unknown>>();

/** Bound a panel's initial snapshot fetch: above the 5 s runner bound (a
 * hung runner fails server-side first, through the snapshot actions) and
 * below the 15 s action bound (a hung action never outlives the platform
 * deadline). A fetch slower than this is treated like a failed one — the
 * stream stays the live source. Tests pass millisecond budgets. */
const INITIAL_TIMEOUT_MS = 10_000;

/** Options for {@link liveFeed}. */
export interface LiveFeedOptions<T> {
  /**
   * Paint the current snapshot on a cold key (no stored snapshot and no
   * frame yet): the panel renders current data promptly even when the
   * stream's first frame is delayed or lost. Stream frames always win once
   * they arrive, and a failed fetch is ignored — the stream stays live.
   */
  initial?: () => Promise<T>;
  /** Keep the snapshot in memory only (see `writeSwr`). */
  persist?: boolean;
  /** Bound the `initial` fetch (see `INITIAL_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/** The write half of a panel's feed state: `liveFeed` applies to its atom,
 * unit tests collect the events. */
export interface FeedSink<T> {
  apply: (event: FeedEvent<T>) => void;
  current: () => FeedState<T>;
}

/** Fetch the current snapshot for a cold key (no stored snapshot): the
 * panel paints it unless a stream frame landed first. Shared per key, so
 * panels on one key (a tab badge and its list) fetch once. Failures are
 * ignored — the stream stays the live source. Answers when the paint
 * settles, so tests can await it instead of sleeping. Exported for the
 * unit tests. */
export const paintInitial = async <T>(
  key: string,
  sink: FeedSink<T>,
  opts: LiveFeedOptions<T> | undefined
): Promise<void> => {
  const initial = opts?.initial;

  if (initial === undefined || readSwr<T>(key) !== undefined) {
    return;
  }

  // Capture the account epoch before fetching: an auth change while the
  // fetch is in flight makes its result the previous account's, and the feed
  // keys carry no account id.
  const startedAt = swrEpoch();

  let pending = initialInflight.get(key);

  if (pending === undefined) {
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- the shared slot erases T across panels; paintInitial restores it with a SAFETY cast below.
    const run = (async (): Promise<unknown> => {
      const timeoutMs = opts?.timeoutMs ?? INITIAL_TIMEOUT_MS;
      const { promise, reject } = Promise.withResolvers<never>();

      const timer = setTimeout(() => {
        reject(
          new Error(
            `initial snapshot for ${key} timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      try {
        return await Promise.race([initial(), promise]);
      } catch {
        // A failed or timed-out fetch resolves empty and is ignored below.
      } finally {
        clearTimeout(timer);
        initialInflight.delete(key);
      }
    })();

    pending = run;
    initialInflight.set(key, pending);
  }

  const frame = await pending;

  if (
    frame !== undefined &&
    startedAt === swrEpoch() &&
    feedValue(sink.current()) === undefined
  ) {
    writeSwr(key, frame, opts);
    // SAFETY: one key carries one T (see `writeSwr`); an empty fetch is a failure, never a frame.
    sink.apply({ kind: "snapshot", value: frame as T });
  }
};

let pageHub: StreamHub | undefined;

/** Forget every account-scoped frame in the page hub and reconnect it. The
 * hub is a module singleton that outlives an SPA auth change (sign-in,
 * sign-out, impersonation), so a topic another subscriber keeps alive would
 * otherwise replay the previous account's frame into the next one's panels
 * (see `resetUserCaches`). */
export const resetStreamHub = (): void => {
  // The in-flight initial snapshots belong to the previous account too.
  initialInflight.clear();
  pageHub?.reset();
};

/** A live panel's feed. `initial` paints one current snapshot on a cold key
 * (see `writeSwr`); `persist: false` keeps its snapshots in memory only,
 * for a feed the UI never paints. */
export const liveFeed = <T>(
  key: string,
  url: string,
  decode: (raw: string) => T,
  opts?: LiveFeedOptions<T>
): LiveFeed<T> => {
  const seed = readSwr<T>(key);

  // SAFETY: readSwr owns this key's T; an absent entry is the only undefined.
  const initial: FeedState<T> =
    seed === undefined ? Feed.Cold() : Feed.Cached({ value: seed as T });

  const state = atom<FeedState<T>>(initial);

  const apply = (event: FeedEvent<T>): void => {
    state.update((current: FeedState<T>) => nextFeedState<T>(current, event));
  };

  // One connection per page, shared by every feed (see `createStreamHub`).
  // T1.9: background tabs hold no connection; the SWR snapshot keeps the
  // panel painted while away.
  watch.once(() => {
    if (
      typeof document === "undefined" ||
      globalThis.EventSource === undefined
    ) {
      apply({ conn: ConnTypes.Closed(), kind: "conn" });

      return;
    }

    void paintInitial(key, { apply, current: state }, opts);
    pageHub ??= createStreamHub();

    return pageHub.subscribe(url, {
      onConn: (conn) => {
        apply({ conn, kind: "conn" });
      },
      onMessage: (data) => {
        try {
          const frame = decode(data);
          writeSwr(key, frame, opts);
          apply({ kind: "frame", value: frame });
        } catch {
          // Bad frame: skip, like fromEventSource's throwing schema.
        }
      },
    });
  });

  return { state };
};

/** Snapshot keys for the live panels (one per app / channel / environment:
 * an environment id suffix keeps each env's frames from overwriting
 * production's — absent/"" is production, matching the runner). */
export const feedKeys = {
  appState: (appId: string) => `feed:${appId}:state`,
  apps: "feed:apps",
  deploys: (appId: string, environmentId = "") =>
    `feed:${appId}:deploys${environmentId === "" ? "" : `:${environmentId}`}`,
  errors: (appId: string, status: ErrorStatus, environmentId = "") =>
    `feed:${appId}:errors:${status}${environmentId === "" ? "" : `:${environmentId}`}`,
  events: (appId: string, channel: string, environmentId = "") =>
    `feed:${appId}:events:${channel}${environmentId === "" ? "" : `:${environmentId}`}`,
  logs: (appId: string, environmentId = "") =>
    `feed:${appId}:logs${environmentId === "" ? "" : `:${environmentId}`}`,
  metrics: (appId: string, hours: number, environmentId = "") =>
    `feed:${appId}:metrics:${hours}${environmentId === "" ? "" : `:${environmentId}`}`,
} as const;

/** Forget one app in the cached app-list snapshot. The list feed paints its
 * last snapshot until the stream's first frame lands, so after a delete the
 * next visit to /apps would otherwise flash the app that just went away. */
export const dropAppFromSnapshot = (appId: string): void => {
  const cached = readSwr<RunnerApp[]>(feedKeys.apps);

  if (cached) {
    writeSwr(
      feedKeys.apps,
      cached.filter((app) => app.id !== appId)
    );
  }
};

/** Live app list (same rows as the list action). */
export const applistUrl = (): string => "/api/apps/stream";

/** Deploy history for one app; `environmentId` scopes it to one preview
 * environment (absent/"" is production). */
export const deploysUrl = (appId: string, environmentId = ""): string =>
  `/api/apps/${encodeURIComponent(appId)}/deploys/stream${
    environmentId === ""
      ? ""
      : `?environmentId=${encodeURIComponent(environmentId)}`
  }`;

/** Grouped errors in one status for one app; `environmentId` scopes it to
 * one preview environment (absent/"" is production). */
export const errorsUrl = (
  appId: string,
  status: ErrorStatus,
  environmentId = ""
): string => {
  const params = new URLSearchParams({ status });

  if (environmentId !== "") {
    params.set("environmentId", environmentId);
  }

  return `/api/apps/${encodeURIComponent(appId)}/errors/stream?${params.toString()}`;
};

/** Live runtime log tail for one app's own fleet, or for one environment
 * (`environmentId`; absent/"" is production). */
export const logsUrl = (appId: string, environmentId = ""): string =>
  `/api/apps/${encodeURIComponent(appId)}/logs/stream${
    environmentId === ""
      ? ""
      : `?environmentId=${encodeURIComponent(environmentId)}`
  }`;

/** Usage frames for one app over a `hours`-long window (24, 168 or 720);
 * `environmentId` scopes it to one preview environment (absent/"" is
 * production). */
export const metricsUrl = (
  appId: string,
  hours: number,
  environmentId = ""
): string => {
  const params = new URLSearchParams({ hours: String(hours) });

  if (environmentId !== "") {
    params.set("environmentId", environmentId);
  }

  return `/api/apps/${encodeURIComponent(appId)}/metrics/stream?${params.toString()}`;
};

/** One app's row and its environments, re-sent whenever either changes:
 * every status badge on the app's pages follows it (`lib/apps/state-sync`). */
export const appStateUrl = (appId: string): string =>
  `/api/apps/${encodeURIComponent(appId)}/state/stream`;

/** Event snapshots for one app, scoped server-side by channel;
 * `environmentId` scopes them to one preview environment (absent/"" is
 * production). */
export const eventsUrl = (
  appId: string,
  channel: string,
  limit: number,
  environmentId = ""
): string => {
  const params = new URLSearchParams();

  if (channel) {
    params.set("channel", channel);
  }

  params.set("limit", String(limit));

  if (environmentId !== "") {
    params.set("environmentId", environmentId);
  }

  return `/api/apps/${encodeURIComponent(appId)}/events/stream?${params.toString()}`;
};

// SAFETY: JSON.parse yields any; every decoder narrows via Array.isArray.
// oxlint-disable-next-line anti-slop/no-unknown-returns -- SSE boundary helper: each decoder narrows the unknown payload before returning its own domain type.
const parseFrame = (raw: string): unknown => JSON.parse(raw) as unknown;

const badFrame = (what: string): Error => new Error(`bad ${what} frame`);

/** App rows (same shape as the list action; entries flow into rendering). */
export const decodeApps = (raw: string): RunnerApp[] => {
  const next = parseFrame(raw);

  if (!Array.isArray(next)) {
    throw badFrame("apps");
  }

  // SAFETY: the apps stream emits the same App rows as the list action.
  return next as RunnerApp[];
};

/** Deploy rows (same shape as the list endpoint). */
export const decodeDeploys = (raw: string): RunnerDeploy[] => {
  const next = parseFrame(raw);

  if (!Array.isArray(next)) {
    throw badFrame("deploys");
  }

  // SAFETY: the runner deploys stream emits the same Deploy rows as the
  // list endpoint; entries flow only into list rendering.
  return next as RunnerDeploy[];
};

/** Error list frame (same shape as the `errors.list` RPC result). */
export const decodeErrors = (raw: string): RunnerErrorList => {
  // SAFETY: field shapes verified below; the runner emits the list result.
  const frame = parseFrame(raw) as Partial<RunnerErrorList> | null;

  if (!Array.isArray(frame?.issues) || !frame.counts) {
    throw badFrame("errors");
  }

  // SAFETY: issues array and counts object verified above.
  return frame as RunnerErrorList;
};

/** App state frame: the app row plus its environments. */
export const decodeAppState = (raw: string): RunnerAppState => {
  // SAFETY: field shapes verified below; the runner emits an AppStateFrame.
  const frame = parseFrame(raw) as Partial<RunnerAppState> | null;

  if (!frame?.app || !Array.isArray(frame.environments)) {
    throw badFrame("state");
  }

  // SAFETY: the app row and the environments array verified above.
  return frame as RunnerAppState;
};

/** Runtime log lines (string array). */
export const decodeLogs = (raw: string): string[] => {
  const next = parseFrame(raw);

  if (!Array.isArray(next)) {
    throw badFrame("logs");
  }

  // SAFETY: the runner log stream emits string arrays; entries flow only
  // into text rendering.
  return next as string[];
};

/** Usage frame. Literal field types (not the runner interfaces) so the
 * frame stays a `WatchValue` for `watch(feed.latest, …)` — interfaces
 * carry no implicit index signature and fail the constraint. Shapes
 * mirror `RunnerMetric` / `RunnerSpan` / `RunnerDevice` / `RunnerPath` /
 * `RunnerRef` in `lib/runner.ts` field-for-field. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- must stay a type alias: watch(feed.latest) requires a WatchValue, and interfaces carry no implicit index signature (tsc-verified).
export type MetricsFrame = {
  metrics: {
    appId: string;
    bucketTs: string;
    requests: number;
    errors: number;
    latencyMs: number;
    cpuMs: number;
  }[];
  spans: {
    name: string;
    kind: number;
    n: number;
    ms: number;
    err: number;
    qwaitMs: number;
  }[];
  devices?: {
    appId: string;
    bucketTs: string;
    browser: string;
    os: string;
    requests: number;
  }[];
  paths?: { appId: string; bucketTs: string; path: string; requests: number }[];
  refs?: {
    appId: string;
    bucketTs: string;
    source: string;
    requests: number;
  }[];
};

/** Usage frame: `metrics` + `spans` required; `devices`/`paths`/`refs`
 * validated when present (the control route always sends them). */
export const decodeMetrics = (raw: string): MetricsFrame => {
  // SAFETY: frame shape is validated field-by-field below.
  const frame = parseFrame(raw) as {
    devices?: unknown;
    metrics?: unknown;
    paths?: unknown;
    refs?: unknown;
    spans?: unknown;
  };

  if (!Array.isArray(frame.metrics) || !Array.isArray(frame.spans)) {
    throw badFrame("metrics");
  }

  // SAFETY: both arrays passed Array.isArray above; rows mirror the list
  // endpoint shapes and flow only into usage rendering.
  const out: MetricsFrame = {
    metrics: frame.metrics as MetricsFrame["metrics"],
    spans: frame.spans as MetricsFrame["spans"],
  };

  if (Array.isArray(frame.devices)) {
    // SAFETY: passed Array.isArray above; entries flow into usage rendering.
    out.devices = frame.devices as NonNullable<MetricsFrame["devices"]>;
  }

  if (Array.isArray(frame.paths)) {
    // SAFETY: passed Array.isArray above; entries flow into usage rendering.
    out.paths = frame.paths as NonNullable<MetricsFrame["paths"]>;
  }

  if (Array.isArray(frame.refs)) {
    // SAFETY: passed Array.isArray above; entries flow into usage rendering.
    out.refs = frame.refs as NonNullable<MetricsFrame["refs"]>;
  }

  return out;
};

/** Runner events-stream snapshot (same rows as the list endpoints). */
export interface EventsSnapshot {
  channels: string[];
  feed: RunnerEvent[];
  insights: RunnerInsight[];
}

/** Combined snapshot: all three field arrays required. */
export const decodeEvents = (raw: string): EventsSnapshot => {
  // SAFETY: field arrays verified below; the runner emits list rows.
  const snapshot = parseFrame(raw) as Partial<EventsSnapshot>;

  if (
    !Array.isArray(snapshot.feed) ||
    !Array.isArray(snapshot.channels) ||
    !Array.isArray(snapshot.insights)
  ) {
    throw badFrame("events");
  }

  // SAFETY: all three field arrays verified above.
  return snapshot as EventsSnapshot;
};
