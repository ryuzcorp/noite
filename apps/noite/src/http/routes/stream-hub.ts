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
//! `<index>` is the topic's position in the query. `<index>:+` says the topic
//! opened and `<index>:!` says it dropped; the hub then reopens that topic on
//! its own with capped backoff while the others keep streaming.
import { eventStream } from "void/sse";
import type { SseStream } from "void/sse";

import type { RouteHandler } from "../config";
import { sleepUnlessAborted } from "../sse";
import {
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

/** Read an SSE body and hand each event's `data` to `onData` (multi-line
 * data joined with `\n`, comments and other fields dropped), awaiting it when
 * it answers a promise. Resolves when the body ends; rejects when it errors. */
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

  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read chunk by chunk, in order
      const chunk = await reader.read();

      if (chunk.done) {
        return;
      }

      buffer += decoder.decode(chunk.value, { stream: true });

      for (;;) {
        const end = /\r\n|\r|\n/u.exec(buffer);

        // A trailing CR may be the first half of a CRLF split across chunks.
        if (
          end === null ||
          (end[0] === "\r" && end.index === buffer.length - 1)
        ) {
          break;
        }

        const line = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);

        if (line === "") {
          if (data.length > 0) {
            const event = data.join("\n");
            data = [];
            // oxlint-disable-next-line eslint/no-await-in-loop -- frames go out in arrival order
            await onData(event);
          }

          continue;
        }

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);

        if (field === "data") {
          const value = colon === -1 ? "" : line.slice(colon + 1);
          data.push(value.startsWith(" ") ? value.slice(1) : value);
        }
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
}

const DEFAULT_RETRY: HubRetry = { baseMs: 1000, capMs: 30_000 };

interface Pump {
  env: KitEnv;
  index: number;
  request: Request;
  retry: HubRetry;
  route: MatchedTopic;
  stream: SseStream;
  topic: string;
}

/** Open one topic's handler and relay its frames until it ends. Answers
 * whether it delivered a frame (a topic that opens and dies at once keeps
 * backing off instead of spinning). */
const relayOnce = async ({
  env,
  index,
  request,
  route,
  stream,
  topic,
}: Pump): Promise<boolean> => {
  const sub = new Request(new URL(topic, request.url), {
    headers: request.headers,
    signal: stream.signal,
  });

  let response: Response | undefined;

  try {
    response = await route.handler(sub, env, route.params);
  } catch (error) {
    console.error("stream hub: topic handler threw", topic, error);

    return false;
  }

  if (!response?.ok || response.body === null) {
    await response?.body?.cancel().catch(() => {
      // The refusal body is discarded either way.
    });

    return false;
  }

  let delivered = false;

  try {
    await stream.send({ data: `${index}:+` });
    await readSseData(
      response.body,
      async (data) => {
        delivered = true;
        await stream.send({ data: `${index}:${data}` });
      },
      stream.signal
    );
  } catch (error) {
    if (!stream.signal.aborted) {
      console.error("stream hub: topic dropped", topic, error);
    }
  }

  return delivered;
};

/** Keep one topic flowing for as long as the hub stream lives. */
const pumpTopic = async (pump: Pump): Promise<void> => {
  const { index, retry, stream } = pump;
  let backoff = retry.baseMs;

  while (!stream.signal.aborted) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one open at a time per topic; the next waits out the backoff
    const delivered = await relayOnce(pump);

    if (stream.signal.aborted) {
      return;
    }

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the drop is reported before the topic waits to reopen
      await stream.send({ data: `${index}:!` });
    } catch {
      return;
    }

    if (delivered) {
      backoff = retry.baseMs;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- abortable backoff before the reopen
    await sleepUnlessAborted(backoff, stream.signal);
    backoff = Math.min(retry.capMs, backoff * 2);
  }
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
        topics.map(async (topic, index) => {
          const route = matchTopic(topic, routes);

          if (route === null) {
            // No stream serves it, now or later: say so once.
            await stream.send({ data: `${index}:!` }).catch(() => {
              // The page already left.
            });

            return;
          }

          await pumpTopic({ env, index, request, retry, route, stream, topic });
        })
      );
    },
    { signal: request.signal }
  );
};

/** `GET /api/streams?t=…` (timeout-exempt: the path contains `/stream`). */
export const handleStreamHub: RouteHandler = (request, env) =>
  streamHub(request, env);
