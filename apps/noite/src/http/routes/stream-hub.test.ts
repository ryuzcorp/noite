import { describe, expect, test } from "bun:test";

import {
  applistUrl,
  deploysUrl,
  errorsUrl,
  eventsUrl,
  logsUrl,
  metricsUrl,
  streamHubUrl,
} from "../../lib/feeds";
import type { RouteHandler } from "../config";
import {
  MAX_TOPICS,
  TOPIC_ROUTES,
  matchTopic,
  readSseData,
  streamHub,
} from "./stream-hub";
import type { TopicRoute } from "./stream-hub";
import {
  handleAppsStream,
  handleDeploysStream,
  handleErrorsStream,
  handleEventsStream,
  handleLogsStream,
  handleMetricsStream,
} from "./streams";

// SAFETY: the hub hands env through to topic handlers untouched; the fakes
// below never read it.
const env = {} as KitEnv;

const encoder = new TextEncoder();

/** A live SSE response: `frames` now, open until `request` aborts. */
const liveSse = (request: Request, frames: readonly string[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
        }

        request.signal.addEventListener("abort", () => {
          controller.close();
        });
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );

/** Read a hub response until its frames satisfy `done` (or 2 s pass). */
const readFrames = async (
  response: Response,
  done: (frames: readonly string[]) => boolean
): Promise<string[]> => {
  const frames: string[] = [];
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 2000);

  if (response.body === null) {
    throw new TypeError("the hub answered without a body");
  }

  await readSseData(
    response.body,
    (data) => {
      frames.push(data);

      if (done(frames)) {
        controller.abort();
      }
    },
    controller.signal
  ).catch(() => {
    // Cancelled on purpose once `done` holds (or on the timeout).
  });

  clearTimeout(timer);

  return frames;
};

const hubRequest = (topics: readonly string[], signal?: AbortSignal) =>
  new Request(`http://control.test${streamHubUrl(topics)}`, {
    headers: { cookie: "session=abc" },
    signal,
  });

describe("matchTopic", () => {
  test("every feed URL builder lands on its own stream handler", () => {
    const cases: [string, RouteHandler][] = [
      [applistUrl(), handleAppsStream],
      [deploysUrl("app_1"), handleDeploysStream],
      [deploysUrl("app_1", "env_1"), handleDeploysStream],
      [errorsUrl("app_1", "open"), handleErrorsStream],
      [eventsUrl("app_1", "deploys", 50), handleEventsStream],
      [logsUrl("app_1"), handleLogsStream],
      [logsUrl("app_1", "env_1"), handleLogsStream],
      [metricsUrl("app_1", 24), handleMetricsStream],
    ];

    for (const [topic, handler] of cases) {
      expect(matchTopic(topic)?.handler).toBe(handler);
    }

    expect(TOPIC_ROUTES).toHaveLength(6);
  });

  test("hands the handler a decoded app id, like the router does", () => {
    expect(matchTopic(logsUrl("app with/slash"))?.params.appId).toBe(
      "app with/slash"
    );
    expect(matchTopic(applistUrl())?.params.appId).toBeUndefined();
  });

  test("refuses anything that is not a stream route", () => {
    expect(matchTopic("/api/apps/get")).toBeNull();
    expect(matchTopic("/api/apps/a/source/archive")).toBeNull();
    expect(matchTopic("https://evil.test/api/apps/stream")).toBeNull();
    expect(matchTopic("//evil.test/api/apps/stream")).toBeNull();
    expect(matchTopic("/storage/a/stream")).toBeNull();
  });
});

describe("readSseData", () => {
  test("joins multi-line data, skips comments, survives a CRLF split", async () => {
    const chunks = [
      ": keep-alive\n\ndata: one\n",
      "data: two\r",
      "\n\r\nevent: x\ndata:three\n\n",
    ];

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }

        controller.close();
      },
    });

    const seen: string[] = [];

    await readSseData(
      body,
      (data) => {
        seen.push(data);
      },
      new AbortController().signal
    );

    expect(seen).toEqual(["one\ntwo", "three"]);
  });
});

describe("streamHub", () => {
  test("relays every topic by index, with the browser's cookies and params", async () => {
    const seen: { cookie: string | null; appId: string | undefined }[] = [];

    const routes: TopicRoute[] = [
      {
        handler: (request, _env, params) => {
          seen.push({
            appId: params?.appId,
            cookie: request.headers.get("cookie"),
          });

          return liveSse(request, ['["log"]']);
        },
        pattern: /^\/api\/apps\/(?<appId>[^/]+)\/logs\/stream$/u,
      },
      {
        handler: (request) => liveSse(request, ["[]"]),
        pattern: /^\/api\/apps\/stream$/u,
      },
    ];

    const page = new AbortController();

    const response = streamHub(
      hubRequest([logsUrl("app_1"), applistUrl()], page.signal),
      env,
      routes
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readFrames(
      response,
      (got) => got.includes('0:["log"]') && got.includes("1:[]")
    );

    page.abort();

    expect(frames).toContain("0:+");
    expect(frames).toContain("1:+");
    expect(seen).toEqual([{ appId: "app_1", cookie: "session=abc" }]);
  });

  test("a refused topic reports a drop and reopens while the others stream", async () => {
    let opens = 0;

    const routes: TopicRoute[] = [
      {
        handler: (request) => {
          opens += 1;

          return opens === 1
            ? new Response("forbidden", { status: 403 })
            : liveSse(request, ['["back"]']);
        },
        pattern: /^\/api\/apps\/(?<appId>[^/]+)\/logs\/stream$/u,
      },
      {
        handler: (request) => liveSse(request, ["[]"]),
        pattern: /^\/api\/apps\/stream$/u,
      },
    ];

    const page = new AbortController();

    const frames = await readFrames(
      streamHub(
        hubRequest([logsUrl("app_1"), applistUrl()], page.signal),
        env,
        routes,
        { baseMs: 10, capMs: 40 }
      ),
      (got) => got.includes('0:["back"]')
    );

    page.abort();

    expect(frames.indexOf("0:!")).toBeLessThan(frames.indexOf('0:["back"]'));
    expect(frames).toContain("1:[]");
    expect(frames).not.toContain("1:!");
    expect(opens).toBe(2);
  });

  test("an unknown topic is refused once; the rest still stream", async () => {
    const routes: TopicRoute[] = [
      {
        handler: (request) => liveSse(request, ["[]"]),
        pattern: /^\/api\/apps\/stream$/u,
      },
    ];

    const page = new AbortController();

    const frames = await readFrames(
      streamHub(
        hubRequest(["/api/apps/get", applistUrl()], page.signal),
        env,
        routes
      ),
      (got) => got.includes("1:[]")
    );

    page.abort();

    expect(frames.filter((frame) => frame === "0:!")).toHaveLength(1);
  });

  test("the page leaving stops every topic", async () => {
    const stopped = Promise.withResolvers<undefined>();

    const routes: TopicRoute[] = [
      {
        handler: (request) => {
          request.signal.addEventListener("abort", () => {
            stopped.resolve();
          });

          return liveSse(request, ["[]"]);
        },
        pattern: /^\/api\/apps\/stream$/u,
      },
    ];

    const page = new AbortController();

    const response = streamHub(
      hubRequest([applistUrl()], page.signal),
      env,
      routes
    );

    await readFrames(response, (got) => got.includes("0:[]"));

    page.abort();

    // Resolves only if the topic's own request is aborted (the test times
    // out otherwise).
    await stopped.promise;
  });

  test("asks for between one and MAX_TOPICS topics", () => {
    expect(streamHub(hubRequest([]), env).status).toBe(400);

    const many = Array.from({ length: MAX_TOPICS + 1 }, () => applistUrl());

    expect(streamHub(hubRequest(many), env).status).toBe(400);
  });
});
