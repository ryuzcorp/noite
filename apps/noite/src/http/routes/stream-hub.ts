//! One live connection per page: `GET /api/streams?t=<topic>&t=<topic>…`
//! carries every feed the page shows. Browsers allow six HTTP/1.1
//! connections per host and an open EventSource holds one for good, so a
//! page with six feeds (the Deployments tab with an environment: app list,
//! errors, events, two deploy histories, a deployment log) left no
//! connection for its own navigation or API calls, and the tab froze. Over
//! HTTP/2 this costs nothing extra; over plain HTTP (dev, LAN installs) it is
//! the difference between working and hanging.
//!
//! A topic is the path of a per-feed stream route (`/api/apps/:id/logs/stream`
//! …). The hub runs that route's own handler in-process, with the browser's
//! cookies and this request's abort signal, so every topic keeps its session
//! and role gate. It relays each `data` frame as `<index>:<frame>`, where
//! `<index>` is the topic's position in the query. Duplicate `t=` values are
//! deduped: one pump serves every index that names the same topic.
//!
//! Topic wire markers (all `<index>`-prefixed, so a frame is never mistaken
//! for one):
//! - `<index>:<frame>` — one frame of the topic's data.
//! - `<index>:+`      — the topic's handler opened; no frame yet.
//! - `<index>:!`      — the topic dropped (handler ended, threw, or stalled
//!                      before its first frame); the hub reopens it on its
//!                      own with capped backoff while the others keep
//!                      streaming.
//! - `<index>:~<status>` — the topic was refused (4xx from its handler, or
//!                      502 for a frame over `MAX_FRAME_BYTES`). Terminal:
//!                      the hub never reopens it (a revoked role, a deleted
//!                      app or an unbounded frame must not retry forever).
//!
//! Every attempt runs under its own `AbortController`; ending an attempt
//! aborts that handler's `request.signal`, so an in-process poll loop (the
//! apps list, the metrics poller) stops before the topic reopens instead of
//! orphaning one poller per retry.
//!
//! ## One topic's pump (`pumpTopic` is the only writer of `TopicState`)
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> pending
//!   pending --> opening: handler answered ok ("+")
//!   pending --> refused: 4xx ("~status")
//!   opening --> streaming: first frame relayed
//!   opening --> retrying: ended or stalled ("!")
//!   streaming --> retrying: handler ended ("!")
//!   retrying --> pending: backoff elapsed
//!   pending --> closed: page left
//!   opening --> closed: page left
//!   streaming --> closed: page left
//!   retrying --> closed: page left
//!   refused --> closed: page left
//! ```
import { eventStream } from "void/sse";
import type { SseStream } from "void/sse";

import type { RouteHandler } from "../config";
import { sleepUnlessAborted } from "../sse";
import {
  METRICS_FIRST_FRAME_MS,
  handleAppStateStream,
  handleAppsStream,
  handleDeploysStream,
  handleErrorsStream,
  handleEventsStream,
  handleLogsStream,
  handleMetricsStream,
} from "./streams";

/** One feed the hub can carry: the stream route's path and its handler. */
export interface TopicRoute {
  handler: RouteHandler;
  /** Matches the topic's pathname; an `appId` group becomes the param. */
  pattern: RegExp;
  /** First-frame budget override: a polling route must state its own poll
   * cadence, or its legitimate quiet cycles (`no frame yet` on a fresh app)
   * look like a stalled upstream and the topic is dropped and reopened
   * forever. Absent: {@link DEFAULT_FIRST_FRAME_MS}. */
  firstFrameMs?: number;
}

/** Every stream route a page may subscribe to. */
export const TOPIC_ROUTES: readonly TopicRoute[] = [
  { handler: handleAppsStream, pattern: /^\/api\/apps\/stream$/u },
  {
    handler: handleDeploysStream,
    pattern: /^\/api\/apps\/(?<appId>[^/]+)\/deploys\/stream$/u,
  },
  {
    handler: handleErrorsStream,
    pattern: /^\/api\/apps\/(?<appId>[^/]+)\/errors\/stream$/u,
  },
  {
    handler: handleEventsStream,
    pattern: /^\/api\/apps\/(?<appId>[^/]+)\/events\/stream$/u,
  },
  {
    handler: handleLogsStream,
    pattern: /^\/api\/apps\/(?<appId>[^/]+)\/logs\/stream$/u,
  },
  {
    firstFrameMs: METRICS_FIRST_FRAME_MS,
    handler: handleMetricsStream,
    pattern: /^\/api\/apps\/(?<appId>[^/]+)\/metrics\/stream$/u,
  },
  {
    handler: handleAppStateStream,
    pattern: /^\/api\/apps\/(?<appId>[^/]+)\/state\/stream$/u,
  },
];

/** A topic resolved to the handler that serves it. */
export interface MatchedTopic {
  /** The route's own first-frame budget, when it declares one. */
  firstFrameMs?: number;
  handler: RouteHandler;
  params: Record<string, string | undefined>;
}

/** Base the topics resolve against: a topic that leaves it (an absolute or
 * protocol-relative URL) is no path of this control site. */
const TOPIC_BASE = "http://topic.invalid";

/** The handler serving `topic` (a path of this site, query allowed), or
 * null when no stream route matches. */
export const matchTopic = (
  topic: string,
  routes: readonly TopicRoute[] = TOPIC_ROUTES
): MatchedTopic | null => {
  if (!topic.startsWith("/") || !URL.canParse(topic, TOPIC_BASE)) {
    return null;
  }

  const url = new URL(topic, TOPIC_BASE);

  if (url.origin !== TOPIC_BASE) {
    return null;
  }

  const { pathname } = url;

  for (const route of routes) {
    const match = route.pattern.exec(pathname);

    if (match !== null) {
      const appId = match.groups?.appId;

      return {
        firstFrameMs: route.firstFrameMs,
        handler: route.handler,
        // Hono hands route handlers decoded params; so does the hub.
        params: {
          appId: appId === undefined ? undefined : decodeURIComponent(appId),
        },
      };
    }
  }

  return null;
};

/** Most topics one page may hold: a page shows a handful, and the cap
 * bounds the handlers one request can start. */
export const MAX_TOPICS = 24;

/** Most bytes one SSE frame may buffer (its line plus accumulated `data`):
 * frames are JSON of rows, so a megabyte is already far beyond any real one,
 * and a line with no terminator must not grow the control worker's heap. */
export const MAX_FRAME_BYTES = 1_048_576;

/** A frame that exceeded {@link MAX_FRAME_BYTES}. The relay treats it as a
 * terminal refusal of that topic (`~502`): retrying would re-read the same
 * unbounded line forever. */
export class SseFrameTooLargeError extends Error {
  constructor(bytes: number) {
    super(`SSE frame exceeded ${MAX_FRAME_BYTES} bytes (${bytes})`);
    this.name = "SseFrameTooLargeError";
  }
}

/** Read an SSE body and hand each event's `data` to `onData` (multi-line
 * data joined with `\n`, comments and other fields dropped), awaiting it when
 * it answers a promise. Resolves when the body ends; rejects when it errors.
 * The buffer is bounded ({@link MAX_FRAME_BYTES}) and scanned from a carried
 * offset, so each byte is visited once per chunk rather than rescanning the
 * whole buffer (a long line used to cost O(n²)). */
export const readSseData = async (
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => Promise<void> | undefined,
  signal: AbortSignal
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  const stop = async (): Promise<void> => {
    await reader.cancel().catch(() => {
      // Already closed or errored: nothing left to cancel.
    });
  };

  signal.addEventListener("abort", stop, { once: true });
  let buffer = "";
  let data: string[] = [];
  let dataBytes = 0;
  // Bytes at the head of `buffer` already scanned without a line end.
  let scanned = 0;

  const dispatch = async (): Promise<void> => {
    if (data.length === 0) {
      return;
    }

    const event = data.join("\n");
    data = [];
    dataBytes = 0;
    await onData(event);
  };

  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read chunk by chunk, in order
      const chunk = await reader.read();

      if (chunk.done) {
        return;
      }

      buffer += decoder.decode(chunk.value, { stream: true });

      let lineStart = 0;
      let i = scanned;

      while (i < buffer.length) {
        const char = buffer[i];
        let end = -1;
        let next = -1;

        if (char === "\n") {
          end = i;
          next = i + 1;
        } else if (char === "\r") {
          // A trailing CR may be the first half of a CRLF split across chunks.
          if (i === buffer.length - 1) {
            break;
          }

          end = i;
          next = buffer[i + 1] === "\n" ? i + 2 : i + 1;
        } else {
          i += 1;
          continue;
        }

        const line = buffer.slice(lineStart, end);
        lineStart = next;
        i = next;

        if (line === "") {
          // oxlint-disable-next-line eslint/no-await-in-loop -- frames go out in arrival order
          await dispatch();
          continue;
        }

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);

        if (field === "data") {
          const value = colon === -1 ? "" : line.slice(colon + 1);
          const text = value.startsWith(" ") ? value.slice(1) : value;
          data.push(text);
          dataBytes += text.length + 1;
        }
      }

      if (lineStart > 0) {
        buffer = buffer.slice(lineStart);
      }

      scanned = Math.max(0, i - lineStart);

      if (buffer.length + dataBytes > MAX_FRAME_BYTES) {
        throw new SseFrameTooLargeError(buffer.length + dataBytes);
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
    reader.releaseLock();
  }
};

/** Reopen tuning for one topic (tests pass millisecond budgets). */
export interface HubRetry {
  baseMs: number;
  capMs: number;
  /** First frame budget per attempt: a topic that opens but sends no frame
   * within this long is dropped (`!`) and reopened, so a hung upstream
   * (headers but no body) surfaces as retrying instead of an open,
   * frameless topic. Defaults to 15 s: the runner ends a topic with an
   * error within 10 s when its own first snapshot hangs, so this only
   * fires on the proxy gap behind it, without racing the runner's bound. */
  firstFrameMs?: number;
}

const DEFAULT_RETRY: HubRetry = { baseMs: 1000, capMs: 30_000 };

/** First-frame budget for a route that states no cadence of its own: the
 * runner ends its own first snapshot with an error within 10 s, so this only
 * fires on the proxy gap behind it, without racing the runner's bound. */
const DEFAULT_FIRST_FRAME_MS = 15_000;

/** One topic's pump state (see the module doc's diagram). `pumpTopic` is the
 * only writer and `nextTopicState` the only transition function: an event
 * that is illegal for the current state leaves it unchanged. */
export type TopicState =
  | { readonly kind: "pending" }
  | { readonly kind: "opening" }
  | { readonly kind: "refused"; readonly status: number }
  | { readonly kind: "retrying" }
  | { readonly kind: "streaming" }
  | { readonly kind: "closed" };

export type TopicEvent =
  | { readonly kind: "opened" }
  | { readonly kind: "frame" }
  | { readonly kind: "ended" }
  | { readonly kind: "reopen" }
  | { readonly kind: "refused"; readonly status: number }
  | { readonly kind: "stalled" }
  | { readonly kind: "abort" };

export const nextTopicState = (
  state: TopicState,
  event: TopicEvent
): TopicState => {
  switch (event.kind) {
    case "abort": {
      return state.kind === "closed" ? state : { kind: "closed" };
    }

    case "opened": {
      return state.kind === "pending" ? { kind: "opening" } : state;
    }

    case "frame": {
      return state.kind === "opening" || state.kind === "streaming"
        ? { kind: "streaming" }
        : state;
    }

    case "ended":
    case "stalled": {
      return state.kind === "opening" || state.kind === "streaming"
        ? { kind: "retrying" }
        : state;
    }

    case "reopen": {
      return state.kind === "retrying" ? { kind: "pending" } : state;
    }

    case "refused": {
      return state.kind === "pending" || state.kind === "opening"
        ? { kind: "refused", status: event.status }
        : state;
    }

    default: {
      return state;
    }
  }
};

/** How one open attempt ended (the pump turns it into markers + state). */
type RelayOutcome =
  | { readonly kind: "aborted" }
  | { readonly kind: "empty"; readonly stalled: boolean }
  | { readonly kind: "refused"; readonly status: number }
  | { readonly kind: "streamed" };

interface Pump {
  env: KitEnv;
  /** Every query position that names this topic (duplicates deduped). */
  indices: readonly number[];
  request: Request;
  retry: HubRetry;
  route: MatchedTopic;
  stream: SseStream;
  topic: string;
}

/** Send one marker to every index of a topic; answers false when the page
 * already left. */
const sendMarker = async (
  indices: readonly number[],
  stream: SseStream,
  suffix: string
): Promise<boolean> => {
  for (const index of indices) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- markers go out in index order
    const sent = await stream
      .send({ data: `${index}:${suffix}` })
      .then(() => true)
      .catch(() => false);

    if (!sent) {
      return false;
    }
  }

  return true;
};

/** Open one topic's handler and relay its frames until it ends. The attempt
 * runs under its own abort controller: whichever way it ends, the handler's
 * `request.signal` is aborted, so its in-process poll loop stops before the
 * pump reopens the topic (`stream.signal` would leave one orphan per retry). */
const relayOnce = async (pump: Pump): Promise<RelayOutcome> => {
  const { env, request, route, stream, topic } = pump;

  // Per-topic signal: the hub's own abort linked in, plus this attempt's end.
  const attempt = new AbortController();

  const onHubAbort = (): void => {
    attempt.abort();
  };

  stream.signal.addEventListener("abort", onHubAbort, { once: true });

  const sub = new Request(new URL(topic, request.url), {
    headers: request.headers,
    signal: attempt.signal,
  });

  try {
    let response: Response | undefined;

    try {
      response = await route.handler(sub, env, route.params);
    } catch (error) {
      console.error("stream hub: topic handler threw", topic, error);

      return { kind: "empty", stalled: false };
    }

    if (response === undefined) {
      // A handler that answers nothing serves no stream: retryable.
      return { kind: "empty", stalled: false };
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {
        // The refusal body is discarded either way.
      });

      // A 4xx is the topic's answer (revoked role, deleted app): retrying it
      // forever only hides the refusal. A 5xx is transient (runner restart).
      return response.status >= 400 && response.status < 500
        ? { kind: "refused", status: response.status }
        : { kind: "empty", stalled: false };
    }

    if (response.body === null) {
      return { kind: "empty", stalled: false };
    }

    let delivered = false;
    let stalled = false;

    if (!(await sendMarker(pump.indices, stream, "+"))) {
      return { kind: "aborted" };
    }

    // The first frame is bounded: an upstream that opened but never sends
    // (runner fetch with headers and no body) is dropped and reopened
    // instead of holding the topic open and frameless.
    const { promise: first, resolve: resolveFirst } =
      Promise.withResolvers<undefined>();

    const relayed = readSseData(
      response.body,
      async (data) => {
        delivered = true;
        resolveFirst?.();

        for (const index of pump.indices) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- frames go out in index order
          await stream.send({ data: `${index}:${data}` });
        }
      },
      attempt.signal
    );

    // An upstream that ends on its own before any frame (the runner's own
    // first-frame bound, a restart) ends the wait too: the topic reopens
    // after the usual backoff instead of sitting out this bound. Its error
    // surfaces from `await relayed` below.
    let ended = false;

    const relayEnded = (async (): Promise<void> => {
      try {
        await relayed;
      } catch {
        // Reported by `await relayed` below; here it only ends the race.
      } finally {
        ended = true;
      }
    })();

    await Promise.race([
      first,
      relayEnded,
      sleepUnlessAborted(
        pump.route.firstFrameMs ??
          pump.retry.firstFrameMs ??
          DEFAULT_FIRST_FRAME_MS,
        stream.signal
      ),
    ]);

    if (!(delivered || ended || stream.signal.aborted)) {
      console.error("stream hub: topic stalled before its first frame", topic);
      stalled = true;
      attempt.abort();
    }

    await relayed;

    if (stream.signal.aborted) {
      return { kind: "aborted" };
    }

    return delivered ? { kind: "streamed" } : { kind: "empty", stalled };
  } catch (error) {
    if (error instanceof SseFrameTooLargeError) {
      // Terminal: retrying re-reads the same unbounded line. The client sees
      // `~502` and stops retrying this topic.
      console.error("stream hub: topic frame too large", topic, error.message);

      return { kind: "refused", status: 502 };
    }

    if (!stream.signal.aborted) {
      console.error("stream hub: topic dropped", topic, error);
    }

    return stream.signal.aborted
      ? { kind: "aborted" }
      : { kind: "empty", stalled: false };
  } finally {
    stream.signal.removeEventListener("abort", onHubAbort);
    // Ends the handler's request signal — and any poll loop behind it — for
    // every ending, not just the aborted ones.
    attempt.abort();
  }
};

/** Keep one topic flowing for as long as the hub stream lives. */
const pumpTopic = async (pump: Pump): Promise<void> => {
  const { retry, stream } = pump;
  let state: TopicState = { kind: "pending" };
  let backoff = retry.baseMs;

  while (!stream.signal.aborted) {
    // A retrying topic re-enters the open attempt; pending stays pending.
    state = nextTopicState(state, { kind: "reopen" });

    if (state.kind !== "pending") {
      return;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- one open at a time per topic; the next waits out the backoff
    const outcome = await relayOnce(pump);

    if (outcome.kind === "aborted") {
      state = nextTopicState(state, { kind: "abort" });

      return;
    }

    if (outcome.kind === "refused") {
      state = nextTopicState(state, {
        kind: "refused",
        status: outcome.status,
      });

      // Terminal: a refusal is never retried.
      // oxlint-disable-next-line eslint/no-await-in-loop -- one marker per ending, in order
      await sendMarker(pump.indices, stream, `~${outcome.status}`);

      return;
    }

    state = nextTopicState(state, { kind: "opened" });

    if (outcome.kind === "streamed") {
      state = nextTopicState(state, { kind: "frame" });
    }

    state = nextTopicState(state, {
      kind: outcome.kind === "empty" && outcome.stalled ? "stalled" : "ended",
    });

    // oxlint-disable-next-line eslint/no-await-in-loop -- the drop is reported before the topic waits to reopen
    if (!(await sendMarker(pump.indices, stream, "!"))) {
      return;
    }

    if (outcome.kind === "streamed") {
      backoff = retry.baseMs;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- abortable backoff before the reopen
    await sleepUnlessAborted(backoff, stream.signal);
    backoff = Math.min(retry.capMs, backoff * 2);
  }
};

/** Group the requested topics: one pump per distinct topic, and every query
 * position that names it (duplicates would otherwise open the same handler
 * twice and double every frame). Insertion order is the first occurrence,
 * so index order on the wire is stable. */
export const groupTopics = (
  topics: readonly string[]
): { indices: number[]; topic: string }[] => {
  const grouped = new Map<string, number[]>();

  for (const [index, topic] of topics.entries()) {
    const indices = grouped.get(topic);

    if (indices === undefined) {
      grouped.set(topic, [index]);
    } else {
      indices.push(index);
    }
  }

  return [...grouped].map(([topic, indices]) => ({ indices, topic }));
};

/** The hub with its topic table and retry budget explicit (unit tests). */
export const streamHub = (
  request: Request,
  env: KitEnv,
  routes: readonly TopicRoute[] = TOPIC_ROUTES,
  retry: HubRetry = DEFAULT_RETRY
): Response => {
  const topics = new URL(request.url).searchParams.getAll("t");

  if (topics.length === 0 || topics.length > MAX_TOPICS) {
    return new Response(`between 1 and ${MAX_TOPICS} topics (t=) required`, {
      status: 400,
    });
  }

  return eventStream(
    async (stream) => {
      await Promise.all(
        groupTopics(topics).map(async ({ indices, topic }) => {
          const route = matchTopic(topic, routes);

          if (route === null) {
            // No stream serves it, now or later: a terminal refusal, not a
            // drop the client would keep retrying.
            await sendMarker(indices, stream, "~404");

            return;
          }

          await pumpTopic({
            env,
            indices,
            request,
            retry,
            route,
            stream,
            topic,
          });
        })
      );
    },
    { signal: request.signal }
  );
};

/** `GET /api/streams?t=…` (timeout-exempt: the path contains `/stream`). */
export const handleStreamHub: RouteHandler = (request, env) =>
  streamHub(request, env);
