//! SSE feed URLs + throwing decoders for the control UI live panels.
//!
//! Each decoder parses one `message` frame and throws on a bad frame (so
//! `liveFeed` skips it). Shape checks are `Array.isArray` guards —
//! the runner ships no effect/Schema codecs for these payloads.
import { atom, watch } from "ilha";
import type { AtomHandle, EventSourceStatus } from "ilha";

import type {
  ErrorStatus,
  RunnerDeploy,
  RunnerErrorList,
  RunnerEvent,
  RunnerInsight,
  RunnerApp,
} from "./runner";
import { readSwr, withSnapshot, writeSwr } from "./swr-store";

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
    let source: EventSource | undefined;
    const open = () => {
      if (source) {
        return;
      }
      status.set("connecting");
      const next = new EventSource(url);
      source = next;
      next.addEventListener("open", () => {
        status.set("open");
      });
      next.addEventListener("error", () => {
        // Native EventSource retries on its own unless closed.
        status.set("retrying");
      });
      next.addEventListener("message", (event) => {
        try {
          const frame = decode(event.data);
          writeSwr(key, frame);
          latest.set(frame);
        } catch {
          // Bad frame: skip, like fromEventSource's throwing schema.
        }
      });
    };
    const close = () => {
      source?.close();
      source = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) {
        close();
        status.set("closed");
      } else {
        open();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.hidden) {
      status.set("closed");
    } else {
      open();
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    };
  });
  return { latest: withSnapshot(key, latest), status };
};

/** Snapshot keys for the live panels (one per app / channel). */
export const feedKeys = {
  apps: "feed:apps",
  deploys: (appId: string) => `feed:${appId}:deploys`,
  errors: (appId: string, status: ErrorStatus) =>
    `feed:${appId}:errors:${status}`,
  events: (appId: string, channel: string) => `feed:${appId}:events:${channel}`,
  logs: (appId: string) => `feed:${appId}:logs`,
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

/** Deploy history for one app. */
export const deploysUrl = (appId: string): string =>
  `/api/apps/${encodeURIComponent(appId)}/deploys/stream`;

/** Grouped errors in one status for one app. */
export const errorsUrl = (appId: string, status: ErrorStatus): string =>
  `/api/apps/${encodeURIComponent(appId)}/errors/stream?status=${status}`;

/** Live runtime log tail for one app. */
export const logsUrl = (appId: string): string =>
  `/api/apps/${encodeURIComponent(appId)}/logs/stream`;

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
    bucketTs: string;
    browser: string;
    os: string;
    requests: number;
  }[];
  paths?: { bucketTs: string; path: string; requests: number }[];
  refs?: { bucketTs: string; source: string; requests: number }[];
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
