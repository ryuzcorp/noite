//! SSE feed URLs + throwing decoders for the control UI live panels.
//!
//! Each decoder parses one `message` frame and throws on a bad frame (so
//! `liveFeed` skips it). Shape checks are `Array.isArray` guards —
//! the runner ships no effect/Schema codecs for these payloads.
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import type {
  ErrorStatus,
  RunnerDeploy,
  RunnerErrorList,
  RunnerEvent,
  RunnerInsight,
  RunnerApp,
} from "./runner";
import { readSwr, withSnapshot, writeSwr } from "./swr-store";

/** Connection state of a `liveFeed` event stream (ilha 0.15's
 * `EventSourceStatus`, removed with `fromEventSource`; this feed manages its
 * own `EventSource`). */
export type EventSourceStatus = "connecting" | "open" | "retrying" | "closed";

/** Live SSE panel state with stale-while-revalidate: `latest` paints the
 * last good frame for `key` (lib/swr-store) until the stream's first frame
 * lands, so revisits and reloads skip the skeleton. Every decoded frame
 * writes the snapshot through. Call unconditionally at the top level of a
 * component. */
/** What a live panel reads: last frame (or snapshot) and connection state. */
export interface LiveFeed<T> {
  latest: AtomHandle<T | undefined>;
  status: AtomHandle<EventSourceStatus>;
}

/** What a reconnecting stream reports back to its owner (ilha atoms in
 * `liveFeed`, plain collectors in the unit tests). */
export interface StreamHooks {
  onMessage: (data: string) => void;
  onStatus: (status: EventSourceStatus) => void;
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
 * Native `EventSource` retries transport drops on its own — but after an HTTP
 * error response (any non-2xx, or a wrong content-type such as a 404 page,
 * or a 500/502/503 while the control fleet or runner restarts) `readyState`
 * goes CLOSED and it gives up for good; without this the panel would show
 * "retrying" forever without retrying. Returns the dispose function. */
export const connectStream = (
  url: string,
  hooks: StreamHooks,
  options: StreamRetryOptions = {}
): (() => void) => {
  const baseMs = options.baseMs ?? RETRY_BASE_MS;
  const capMs = options.capMs ?? RETRY_CAP_MS;
  const random = options.random ?? Math.random;
  const Source = options.source ?? globalThis.EventSource;

  if (Source === undefined) {
    hooks.onStatus("closed");

    return () => {
      // No source exists, so there is nothing to dispose.
    };
  }

  let source: EventSource | undefined;
  // Pending-reopen generation: scheduling bumps it and each timer only fires
  // for its own generation, so a stale timer can never open a second source.
  let pending = 0;
  let attempts = 0;
  let disposed = false;

  const clearTimer = (): void => {
    pending += 1;
  };

  const open = (): void => {
    if (disposed || source !== undefined) {
      return;
    }

    // T1.9: background tabs hold no connection. The SWR snapshot keeps the
    // panel painted while away.
    if (typeof document !== "undefined" && document.hidden) {
      hooks.onStatus("closed");

      return;
    }

    hooks.onStatus("connecting");
    const next = new Source(url);
    source = next;
    next.addEventListener("open", () => {
      attempts = 0;
      hooks.onStatus("open");
    });
    next.addEventListener("error", () => {
      hooks.onStatus("retrying");

      if (next.readyState === SOURCE_CLOSED) {
        if (source === next) {
          source = undefined;
        }

        const backoff = Math.min(capMs, baseMs * 2 ** attempts);
        attempts += 1;
        const delay = Math.min(capMs, backoff + Math.floor(random() * baseMs));
        pending += 1;
        const seen = pending;
        setTimeout(() => {
          if (seen === pending) {
            open();
          }
        }, delay);
      }
    });
    next.addEventListener("message", (event) => {
      hooks.onMessage(event.data);
    });
  };

  const close = (): void => {
    clearTimer();
    source?.close();
    source = undefined;
  };

  const onVisibility = (): void => {
    if (typeof document === "undefined") {
      return;
    }

    if (document.hidden) {
      close();
      hooks.onStatus("closed");
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
  };
};

export const liveFeed = <T>(
  key: string,
  url: string,
  decode: (raw: string) => T
): LiveFeed<T> => {
  // oxlint-disable-next-line unicorn/no-useless-undefined -- the feed starts valueless; undefined is the seed
  const latest = atom<T | undefined>(undefined);
  const status = atom<EventSourceStatus>("connecting");
  // T1.9: background tabs hold no connection. Closing on hidden (and
  // reopening on visible) stops the control proxy and runner loops through
  // T1.2; the SWR snapshot keeps the panel painted while away.
  watch.once(() => {
    if (
      typeof document === "undefined" ||
      globalThis.EventSource === undefined
    ) {
      status.set("closed");

      return;
    }

    return connectStream(url, {
      onMessage: (data) => {
        try {
          const frame = decode(data);
          writeSwr(key, frame);
          latest.set(frame);
        } catch {
          // Bad frame: skip, like fromEventSource's throwing schema.
        }
      },
      onStatus: (next) => {
        status.set(next);
      },
    });
  });

  return { latest: withSnapshot(key, latest), status };
};

/** Snapshot keys for the live panels (one per app / channel). */
export const feedKeys = {
  apps: "feed:apps",
  deploys: (appId: string, environmentId = "") =>
    `feed:${appId}:deploys${environmentId === "" ? "" : `:${environmentId}`}`,
  errors: (appId: string, status: ErrorStatus) =>
    `feed:${appId}:errors:${status}`,
  events: (appId: string, channel: string) => `feed:${appId}:events:${channel}`,
  logs: (appId: string, environmentId = "") =>
    `feed:${appId}:logs${environmentId === "" ? "" : `:${environmentId}`}`,
  metrics: (appId: string, hours: number) => `feed:${appId}:metrics:${hours}`,
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

/** Grouped errors in one status for one app. */
export const errorsUrl = (appId: string, status: ErrorStatus): string =>
  `/api/apps/${encodeURIComponent(appId)}/errors/stream?status=${status}`;

/** Live runtime log tail for one app's own fleet, or for one environment
 * (`environmentId`; absent/"" is production). */
export const logsUrl = (appId: string, environmentId = ""): string =>
  `/api/apps/${encodeURIComponent(appId)}/logs/stream${
    environmentId === ""
      ? ""
      : `?environmentId=${encodeURIComponent(environmentId)}`
  }`;

/** Usage frames for one app over a `hours`-long window (24, 168 or 720). */
export const metricsUrl = (appId: string, hours: number): string =>
  `/api/apps/${encodeURIComponent(appId)}/metrics/stream?hours=${hours}`;

/** Event snapshots for one app, scoped server-side by channel. */
export const eventsUrl = (
  appId: string,
  channel: string,
  limit: number
): string => {
  const params = new URLSearchParams();

  if (channel) {
    params.set("channel", channel);
  }

  params.set("limit", String(limit));

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
