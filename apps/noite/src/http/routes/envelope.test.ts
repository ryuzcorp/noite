/* oxlint-disable eslint/require-await, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a stub env, clock and runner fetch stand in for the platform */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { controlEnv } from "../../lib/control-env";
import { DEFAULT_RPM, envelopeLimiter } from "../../lib/rate-limit";
import {
  ENVELOPE_MAX_BYTES,
  handleEnvelope,
  makeEnvelopeHandler,
} from "./envelope";

const ENV = {
  RUNNER_TOKEN: "runner-secret",
  RUNNER_URL: "http://runner.test",
};

const realFetch = globalThis.fetch;

const setFetch = (
  impl: (url: string, init?: RequestInit) => Promise<Response>
) => {
  // SAFETY: the tests only need the (url, init) call shape.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch.
  globalThis.fetch = impl as unknown as typeof fetch;
};

/** A JSON-RPC request body the stubbed runner fetch receives. */
interface RpcPayload {
  id: number;
  method: string;
  params: {
    events?: unknown[];
    key?: string;
    projectId?: number;
  };
}

let calls: { method: string; params: RpcPayload["params"] }[] = [];
let rpcError: { code: number; message: string } | null = null;

const answerRpc = (payload: RpcPayload): Response => {
  if (rpcError) {
    return Response.json({
      error: rpcError,
      id: payload.id,
      jsonrpc: "2.0",
    });
  }

  return Response.json({
    id: payload.id,
    jsonrpc: "2.0",
    result: { fingerprints: ["fp-one"] },
  });
};

const fixture = (name: string): string =>
  readFileSync(
    path.join(import.meta.dir, "..", "..", "lib", "sentry-fixtures", name),
    "utf-8"
  );

const post = (
  projectId: string,
  body: BodyInit,
  key: string,
  headers?: Record<string, string>
): Request =>
  new Request(`http://localhost:9080/${projectId}/envelope?sentry_key=${key}`, {
    body,
    headers,
    method: "POST",
  });

const run = (
  request: Request,
  params: Record<string, string>,
  handler: typeof handleEnvelope = handleEnvelope,
  env: typeof ENV = ENV
): Promise<Response | undefined> =>
  Promise.resolve(
    handler(
      request,
      // SAFETY: the handler reads only RUNNER_TOKEN/RUNNER_URL off the env.
      env as unknown as never,
      params
    )
  );

const gzip = async (text: string): Promise<Blob> => {
  const compressed = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));

  return new Response(compressed).blob();
};

/** Mirror Void file routing: a static segment wins over `[param]` (checked
 * first at every level), a trailing file ends the walk. */
const routesApi = path.join(import.meta.dir, "..", "..", "routes", "api");

const isDir = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

const paramChild = (dir: string): string | null => {
  let names: string[];

  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }

  return (
    names.find(
      (name) =>
        name.startsWith("[") &&
        !name.startsWith("[...") &&
        isDir(path.join(dir, name))
    ) ?? null
  );
};

const resolveRoute = (url: string): string | null => {
  const segments = url.split("?")[0]?.split("/").filter(Boolean) ?? [];

  if (segments[0] !== "api") {
    return null;
  }

  let dir = routesApi;

  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i] ?? "";
    const last = i === segments.length - 1;

    if (!last && isDir(path.join(dir, segment))) {
      dir = path.join(dir, segment);
      continue;
    }

    try {
      if (last && statSync(path.join(dir, `${segment}.ts`)).isFile()) {
        return path.join(dir, `${segment}.ts`);
      }
    } catch {
      return null;
    }

    const child = paramChild(dir);

    if (child === null || last) {
      return null;
    }

    dir = path.join(dir, child);
  }

  return null;
};

beforeEach(() => {
  calls = [];
  rpcError = null;
  controlEnv.RUNNER_TOKEN = ENV.RUNNER_TOKEN;
  controlEnv.RUNNER_URL = ENV.RUNNER_URL;
  envelopeLimiter.reset();
  setFetch(async (_url, init) => {
    // SAFETY: the handler only posts JSON-RPC bodies to the runner.
    const payload = JSON.parse(String(init?.body ?? "{}")) as RpcPayload;
    calls.push({ method: payload.method, params: payload.params });

    return answerRpc(payload);
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("envelope CORS", () => {
  test("preflight answers 204 with the SDK headers", async () => {
    const response = await run(
      new Request("http://localhost:9080/42/envelope", { method: "OPTIONS" }),
      { projectId: "42" }
    );

    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    expect(response?.headers.get("access-control-allow-methods")).toContain(
      "POST"
    );
    expect(response?.headers.get("access-control-allow-methods")).toContain(
      "OPTIONS"
    );
    expect(response?.headers.get("access-control-allow-headers")).toContain(
      "x-sentry-auth"
    );
    expect(response?.headers.get("access-control-allow-headers")).toContain(
      "content-type"
    );
  });

  test("every response carries the open origin header", async () => {
    const response = await run(
      new Request("http://localhost:9080/42/envelope", { method: "POST" }),
      { projectId: "42" }
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("envelope routing and auth", () => {
  test("declines a non-numeric project so the adapter 404s", async () => {
    const response = await run(
      post("apps", fixture("session.envelope.txt"), "key-decline"),
      { projectId: "apps" }
    );

    expect(response).toBeUndefined();
  });

  test("rejects non-POST methods", async () => {
    const response = await run(
      new Request("http://localhost:9080/42/envelope?sentry_key=key-get", {
        method: "GET",
      }),
      { projectId: "42" }
    );

    expect(response?.status).toBe(405);
  });

  test("requires a key", async () => {
    const response = await run(
      new Request("http://localhost:9080/42/envelope", {
        body: fixture("session.envelope.txt"),
        method: "POST",
      }),
      { projectId: "42" }
    );

    expect(response?.status).toBe(401);
  });

  test("accepts the key from the X-Sentry-Auth header", async () => {
    const response = await run(
      new Request("http://localhost:9080/42/envelope", {
        body: fixture("session.envelope.txt"),
        headers: {
          "x-sentry-auth":
            "Sentry sentry_version=7, sentry_key=key-header, sentry_client=sdk/1",
        },
        method: "POST",
      }),
      { projectId: "42" }
    );

    expect(response?.status).toBe(200);
    expect(calls).toEqual([]);
  });

  test("a wrong key and an unknown project share one identical 403", async () => {
    rpcError = { code: 404, message: "project not found" };

    const wrongKey = await run(
      post("42", fixture("exception.envelope.txt"), "key-wrong"),
      { projectId: "42" }
    );

    const unknownProject = await run(
      post("99991", fixture("exception.envelope.txt"), "key-right"),
      { projectId: "99991" }
    );

    expect(wrongKey?.status).toBe(403);
    expect(unknownProject?.status).toBe(403);
    expect(await wrongKey?.text()).toBe(await unknownProject?.text());
  });

  test("rejects a body that is not an envelope", async () => {
    const response = await run(post("42", "this is not json", "key-bad"), {
      projectId: "42",
    });

    expect(response?.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("answers 500 without a runner token", async () => {
    const response = await run(
      post("42", fixture("exception.envelope.txt"), "key-token"),
      { projectId: "42" },
      handleEnvelope,
      { RUNNER_TOKEN: "", RUNNER_URL: "http://runner.test" }
    );

    expect(response?.status).toBe(500);
    expect(calls).toEqual([]);
  });
});

describe("envelope bodies", () => {
  test("caps raw bodies past 200 KiB", async () => {
    const response = await run(
      post("42", "x".repeat(ENVELOPE_MAX_BYTES + 1), "key-cap"),
      { projectId: "42" }
    );

    expect(ENVELOPE_MAX_BYTES).toBe(200 * 1024);
    expect(response?.status).toBe(413);
    expect(calls).toEqual([]);
  });

  test("ingests one gzipped browser event", async () => {
    const compressed = await gzip(fixture("exception.envelope.txt"));

    expect(compressed.size).toBeLessThan(ENVELOPE_MAX_BYTES);

    const response = await run(
      post("42", compressed, "key-gzip", { "content-encoding": "gzip" }),
      { projectId: "42" }
    );

    expect(response?.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe("errors.ingest");
    expect(calls[0]?.params.projectId).toBe(42);
    expect(calls[0]?.params.key).toBe("key-gzip");
    expect(calls[0]?.params.events?.length).toBe(1);
  });

  test("refuses a gzip bomb without inflating it", async () => {
    const bomb = await gzip("0".repeat(2 * 1024 * 1024));

    expect(bomb.size).toBeLessThan(ENVELOPE_MAX_BYTES);

    const response = await run(
      post("42", bomb, "key-bomb", { "content-encoding": "gzip" }),
      { projectId: "42" }
    );

    expect(response?.status).toBe(413);
    expect(calls).toEqual([]);
  });

  test("stores nothing for a session-only envelope", async () => {
    const response = await run(
      post("42", fixture("session.envelope.txt"), "key-session"),
      { projectId: "42" }
    );

    expect(response?.status).toBe(200);
    expect(calls).toEqual([]);
  });

  test("a drop-only envelope skips the runner even with a wrong key", async () => {
    const response = await run(
      post("42", fixture("session.envelope.txt"), "not-the-key"),
      { projectId: "42" }
    );

    expect(response?.status).toBe(200);
    expect(calls).toEqual([]);
  });

  test("stores nothing for a transaction/session envelope", async () => {
    const text = [
      '{"sent_at":"2026-10-20T21:42:47.836Z"}',
      '{"type":"transaction"}',
      '{"transaction":"checkout","type":"transaction"}',
      '{"type":"session"}',
      '{"sid":"2f79febf5d5b4401a8d55480069f9ae8","status":"ok"}',
      "",
    ].join("\n");

    const response = await run(post("42", text, "key-transaction"), {
      projectId: "42",
    });

    expect(response?.status).toBe(200);
    expect(calls).toEqual([]);
  });

  test("refuses an envelope with more than one event", async () => {
    const text = [
      '{"event_id":"9ec79c33ec9942ab8353589fcb2f04d"}',
      '{"type":"event"}',
      '{"event_id":"9ec79c33ec9942ab8353589fcb2f04d","message":"one"}',
      '{"type":"event"}',
      '{"event_id":"9ec79c33ec9942ab8353589fcb2f04d","message":"two"}',
      "",
    ].join("\n");

    const response = await run(post("42", text, "key-multi"), {
      projectId: "42",
    });

    expect(response?.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("envelope rate limit", () => {
  test("allows a full window per key, then 429s until it resets", async () => {
    let nowValue = 1_000_000;
    const handler = makeEnvelopeHandler({ now: () => nowValue });

    const attempt = (): Promise<Response | undefined> =>
      run(
        post("42", fixture("session.envelope.txt"), "key-limited"),
        {
          projectId: "42",
        },
        handler
      );

    for (let i = 0; i < DEFAULT_RPM; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the window only advances when the fake clock does, so serial attempts share one bucket
      const response = await attempt();

      expect(response?.status).toBe(200);
    }

    const limited = await attempt();

    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBe("60");
    expect(limited?.headers.get("x-ratelimit-remaining")).toBe("0");
    nowValue += 60_001;

    const reopened = await attempt();

    expect(reopened?.status).toBe(200);
  });
});

describe("envelope route shadowing", () => {
  test("a numeric project reaches the envelope file, statics still win", () => {
    expect(resolveRoute("/api/42/envelope/")).toBe(
      path.join(routesApi, "[projectId]", "envelope.ts")
    );
    expect(resolveRoute("/api/apps/x/errors/stream")).toBe(
      path.join(routesApi, "apps", "[appId]", "errors", "stream.ts")
    );
  });
});
