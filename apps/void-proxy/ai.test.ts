// /ai/*: provider envelope round-trips, auth defaults, path guard, error
// mapping, SSE passthrough, /ai/run model map, and the 501 shapes.
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- tests shuttle untyped JSON bodies and assert on parsed shapes */
import { describe, expect, test } from "bun:test";

import { PROVIDER_BASE_URLS, PROVIDER_AUTH_DEFAULTS } from "./src/ai.ts";
import type { Env } from "./src/env.ts";
import { makeEnv, post } from "./test-helpers.ts";

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

const startUpstream = (
  handler: (req: Request, seen: SeenRequest) => Response | Promise<Response>
): { url: string; requests: SeenRequest[]; close: () => void } => {
  const requests: SeenRequest[] = [];

  const server = Bun.serve({
    async fetch(req) {
      const headers: Record<string, string> = {};

      for (const [key, value] of req.headers.entries()) {
        headers[key] = value;
      }

      const seen: SeenRequest = {
        body: new Uint8Array(await req.arrayBuffer()),
        headers,
        method: req.method,
        url: req.url,
      };

      requests.push(seen);

      return handler(req, seen);
    },
    hostname: "127.0.0.1",
    port: 0,
  });

  return {
    close: () => server.stop(),
    requests,
    url: `http://127.0.0.1:${server.port}`,
  };
};

const onlyRequest = (requests: SeenRequest[]): SeenRequest => {
  const [seen] = requests;

  if (!seen) {
    throw new Error("expected one upstream request");
  }

  return seen;
};

/** Route the proxy's upstream fetch at the local fake, recording full URLs. */
const localFetch =
  (
    serverUrl: string,
    seenUrls: string[] = []
  ): ((url: string, init: RequestInit) => Promise<Response>) =>
  (url, init) => {
    seenUrls.push(url);
    const upstream = new URL(url);

    return fetch(`${serverUrl}${upstream.pathname}${upstream.search}`, {
      body: init.body as BodyInit | null | undefined,
      headers: init.headers,
      method: init.method ?? "GET",
    });
  };

const aiEnv = (overrides: Partial<Env> = {}): Env =>
  makeEnv({ VOID_PROXY_AI_ENABLED: "1", ...overrides });

const providerBody = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  body: { type: "json", value: { messages: [], model: "m" } },
  path: "chat/completions",
  provider: "openai",
  providerKey: "caller-key",
  ...overrides,
});

describe("ai capability gate", () => {
  test("/ai/* without the flag is a 501", async () => {
    for (const path of [
      "/ai/provider",
      "/ai/run",
      "/ai/models",
      "/ai/toMarkdown",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cases, each asserted before the next
      const { status, json } = await post(path, providerBody(), makeEnv());
      expect(status).toBe(501);
      expect(json).toEqual({ error: "ai not configured" });
    }
  });
});

describe("/ai/provider validation", () => {
  test("missing fields are 400s with Void's messages", async () => {
    const env = aiEnv();

    for (const [body, error] of [
      [{ path: "x", providerKey: "k" }, "provider required"],
      [{ provider: "openai", providerKey: "k" }, "path required"],
      [{ path: "x", provider: "openai" }, "providerKey required"],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cases, each asserted before the next
      const { status, json } = await post("/ai/provider", body, env);
      expect(status).toBe(400);
      expect(json).toEqual({ error });
    }
  });

  test("unknown provider is a 400 (defense in depth; the runtime rejects first)", async () => {
    const { status, json } = await post(
      "/ai/provider",
      providerBody({ provider: "skynet" }),
      aiEnv()
    );

    expect(status).toBe(400);
    expect(json).toEqual({ error: "unknown provider 'skynet'" });
  });

  test.each([
    "https://evil.example.com/x",
    "//evil.example.com/x",
    "ftp://evil.example.com/x",
    "..",
    "../x",
    "a/../../b",
    "a/%2e%2e/b",
    "a/%2E%2E/b",
    "%2e%2e",
    "a\\b",
    "a/%zz/b",
  ])("unsafe path %p is rejected", async (path) => {
    const { status, json } = await post(
      "/ai/provider",
      providerBody({ path }),
      aiEnv()
    );

    expect(status).toBe(400);
    expect(json).toEqual({ error: "path must be relative" });
  });

  test.each([
    "chat/completions",
    "/chat/completions",
    "x?next=..&y=1",
    "v1/files?q=a#b",
  ])("safe path %p passes the guard", async (path) => {
    const upstream = startUpstream(() => Response.json({ ok: true }));

    try {
      const seenUrls: string[] = [];

      const { status } = await post(
        "/ai/provider",
        providerBody({ path }),
        aiEnv(),
        {
          fetchUpstream: localFetch(upstream.url, seenUrls),
        }
      );

      expect(status).toBe(200);
      expect(seenUrls).toHaveLength(1);
    } finally {
      upstream.close();
    }
  });

  test("base-URL map keys match the runtime PROVIDER_KEY_MAP exactly", () => {
    // Hard-coded from Void `packages/void/src/runtime/ai-types.ts`.
    const runtimeProviders = [
      "openai",
      "anthropic",
      "google-ai-studio",
      "groq",
      "mistral",
      "grok",
      "deepseek",
      "openrouter",
      "perplexity",
      "cohere",
      "cerebras",
      "huggingface",
      "replicate",
      "baseten",
      "cartesia",
      "deepgram",
      "elevenlabs",
      "fal",
      "ideogram",
      "parallel",
    ];

    expect(Object.keys(PROVIDER_BASE_URLS).toSorted()).toEqual(
      [...runtimeProviders].toSorted()
    );
  });

  test("auth default table matches the runtime direct-path table", () => {
    // Hard-coded from Void `packages/void/src/runtime/ai.ts`.
    expect(PROVIDER_AUTH_DEFAULTS).toEqual({
      anthropic: { header: "x-api-key", prefix: "" },
      baseten: { header: "authorization", prefix: "Api-Key " },
      cartesia: { header: "x-api-key", prefix: "" },
      deepgram: { header: "authorization", prefix: "Token " },
      elevenlabs: { header: "xi-api-key", prefix: "" },
      fal: { header: "authorization", prefix: "Key " },
      "google-ai-studio": { header: "x-goog-api-key", prefix: "" },
      ideogram: { header: "Api-Key", prefix: "" },
      parallel: { header: "x-api-key", prefix: "" },
    });
  });
});

describe("/ai/provider envelopes", () => {
  test("json envelope round-trips with a json content-type", async () => {
    const upstream = startUpstream(() => Response.json({ ok: true }));

    try {
      const { status } = await post(
        "/ai/provider",
        providerBody({ body: { type: "json", value: { a: 1, b: [1, 2] } } }),
        aiEnv(),
        { fetchUpstream: localFetch(upstream.url) }
      );

      expect(status).toBe(200);
      expect(upstream.requests).toHaveLength(1);
      const seen = onlyRequest(upstream.requests);
      expect(seen.headers["content-type"]).toBe("application/json");
      expect(new TextDecoder().decode(seen.body)).toBe(
        JSON.stringify({ a: 1, b: [1, 2] })
      );
    } finally {
      upstream.close();
    }
  });

  test("text envelope honors its content-type", async () => {
    const upstream = startUpstream(() => Response.json({ ok: true }));

    try {
      await post(
        "/ai/provider",
        providerBody({
          body: {
            contentType: "application/x-www-form-urlencoded;charset=UTF-8",
            data: "a=1&b=2",
            type: "text",
          },
        }),
        aiEnv(),
        { fetchUpstream: localFetch(upstream.url) }
      );
      const seen = onlyRequest(upstream.requests);
      expect(seen.headers["content-type"]).toBe(
        "application/x-www-form-urlencoded;charset=UTF-8"
      );
      expect(new TextDecoder().decode(seen.body)).toBe("a=1&b=2");
    } finally {
      upstream.close();
    }
  });

  test("base64 envelope arrives as raw bytes", async () => {
    const upstream = startUpstream(() => Response.json({ ok: true }));

    try {
      const raw = new Uint8Array([0, 1, 2, 250, 255]);
      await post(
        "/ai/provider",
        providerBody({
          body: {
            contentType: "audio/wav",
            data: Buffer.from(raw).toString("base64"),
            type: "base64",
          },
        }),
        aiEnv(),
        { fetchUpstream: localFetch(upstream.url) }
      );
      const seen = onlyRequest(upstream.requests);
      expect(seen.headers["content-type"]).toBe("audio/wav");
      expect(seen.body).toEqual(raw);
    } finally {
      upstream.close();
    }
  });

  test("form envelope carries fields and files", async () => {
    const parsed: {
      fields: Record<string, string>;
      files: Record<string, { name: string; type: string; bytes: string }>;
    } = { fields: {}, files: {} };

    const upstream = startUpstream(async (_req, seen) => {
      // The recorder already consumed the body; re-wrap the raw bytes.
      const clone = new Request("http://upstream.test/", {
        body: seen.body.buffer as ArrayBuffer,
        headers: { "content-type": seen.headers["content-type"] ?? "" },
        method: "POST",
      });

      const form = await clone.formData();
      // NOTE: bun-types declares entries() as string-only, so read by name.
      const note = form.get("note");
      const file = form.get("file");

      if (typeof note !== "string") {
        throw new TypeError("missing form field");
      }

      if (typeof file === "string" || file === null) {
        throw new Error("missing form file");
      }

      parsed.fields = { note };
      parsed.files = {
        file: {
          bytes: new TextDecoder().decode(
            new Uint8Array(await file.arrayBuffer())
          ),
          name: file.name,
          type: file.type,
        },
      };

      return Response.json({ ok: true });
    });

    try {
      const { status } = await post(
        "/ai/provider",
        providerBody({
          body: {
            entries: [
              { name: "note", value: "hi" },
              {
                name: "file",
                value: {
                  __voidFile: true,
                  data: Buffer.from("file-bytes").toString("base64"),
                  name: "n.bin",
                  type: "application/octet-stream",
                },
              },
            ],
            type: "form",
          },
        }),
        aiEnv(),
        { fetchUpstream: localFetch(upstream.url) }
      );

      expect(status).toBe(200);
      expect(parsed).toEqual({
        fields: { note: "hi" },
        files: {
          file: {
            bytes: "file-bytes",
            name: "n.bin",
            type: "application/octet-stream",
          },
        },
      });
    } finally {
      upstream.close();
    }
  });

  test("none and unknown envelopes send no body", async () => {
    const upstream = startUpstream(() => Response.json({ ok: true }));

    try {
      const deps = { fetchUpstream: localFetch(upstream.url) };
      await post(
        "/ai/provider",
        providerBody({ body: { type: "none" } }),
        aiEnv(),
        deps
      );
      await post(
        "/ai/provider",
        providerBody({ body: { type: "bogus" } }),
        aiEnv(),
        deps
      );
      await post(
        "/ai/provider",
        providerBody({ body: undefined }),
        aiEnv(),
        deps
      );
      expect(upstream.requests).toHaveLength(3);

      for (const seen of upstream.requests) {
        expect(seen.body.byteLength).toBe(0);
      }
    } finally {
      upstream.close();
    }
  });

  test("invalid file base64 is a 400", async () => {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cases, each asserted before the next
    const { status, json } = await post(
      "/ai/provider",
      providerBody({
        body: {
          entries: [
            { name: "f", value: { __voidFile: true, data: "!!!", name: "n" } },
          ],
          type: "form",
        },
      }),
      aiEnv()
    );

    expect(status).toBe(400);
    expect(json).toEqual({ error: "invalid file data" });
  });

  test("method passes through (default POST)", async () => {
    const upstream = startUpstream(() => Response.json({ ok: true }));

    try {
      const deps = { fetchUpstream: localFetch(upstream.url) };
      await post("/ai/provider", providerBody({}), aiEnv(), deps);
      await post(
        "/ai/provider",
        providerBody({ body: { type: "none" }, method: "GET" }),
        aiEnv(),
        deps
      );
      expect(upstream.requests.map((r) => r.method)).toEqual(["POST", "GET"]);
    } finally {
      upstream.close();
    }
  });

  test("caller headers forward; content-type override wins", async () => {
    const upstream = startUpstream(() => Response.json({ ok: true }));

    try {
      await post(
        "/ai/provider",
        providerBody({
          body: { type: "json", value: {} },
          headers: {
            "content-type": "application/vnd.custom+json",
            ignored: 42,
            "x-custom": "yes",
          },
        }),
        aiEnv(),
        { fetchUpstream: localFetch(upstream.url) }
      );
      const seen = onlyRequest(upstream.requests);
      expect(seen.headers["x-custom"]).toBe("yes");
      expect(seen.headers["content-type"]).toBe("application/vnd.custom+json");
      expect(seen.headers["ignored"]).toBeUndefined();
    } finally {
      upstream.close();
    }
  });
});

describe("/ai/provider auth headers", () => {
  const cases: [string, string, string][] = [
    ["openai", "authorization", "Bearer caller-key"],
    ["anthropic", "x-api-key", "caller-key"],
    ["google-ai-studio", "x-goog-api-key", "caller-key"],
    ["deepgram", "authorization", "Token caller-key"],
    ["fal", "authorization", "Key caller-key"],
    ["cartesia", "x-api-key", "caller-key"],
    ["baseten", "authorization", "Api-Key caller-key"],
    ["ideogram", "api-key", "caller-key"],
    ["parallel", "x-api-key", "caller-key"],
    ["elevenlabs", "xi-api-key", "caller-key"],
    ["groq", "authorization", "Bearer caller-key"],
  ];

  for (const [provider, header, value] of cases) {
    test(`${provider} defaults to ${header}`, async () => {
      const upstream = startUpstream(() => Response.json({ ok: true }));

      try {
        await post("/ai/provider", providerBody({ provider }), aiEnv(), {
          fetchUpstream: localFetch(upstream.url),
        });
        expect(onlyRequest(upstream.requests).headers[header]).toBe(value);
      } finally {
        upstream.close();
      }
    });
  }

  test("caller apiKeyHeader/apiKeyPrefix overrides win", async () => {
    const upstream = startUpstream(() => Response.json({ ok: true }));

    try {
      await post(
        "/ai/provider",
        providerBody({
          apiKeyHeader: "x-mine",
          apiKeyPrefix: "Mine ",
          provider: "anthropic",
        }),
        aiEnv(),
        { fetchUpstream: localFetch(upstream.url) }
      );
      const { headers } = onlyRequest(upstream.requests);
      expect(headers["x-mine"]).toBe("Mine caller-key");
      expect(headers["x-api-key"]).toBeUndefined();
    } finally {
      upstream.close();
    }
  });

  test("requests hit the native base URL for the provider", async () => {
    const upstream = startUpstream(() => Response.json({ ok: true }));

    try {
      const seenUrls: string[] = [];
      await post(
        "/ai/provider",
        providerBody({ path: "/messages", provider: "anthropic" }),
        aiEnv(),
        {
          fetchUpstream: localFetch(upstream.url, seenUrls),
        }
      );
      expect(seenUrls).toEqual(["https://api.anthropic.com/v1/messages"]);
    } finally {
      upstream.close();
    }
  });
});

describe("/ai/provider responses", () => {
  test("upstream JSON errors map to {error} with the upstream status", async () => {
    const upstream = startUpstream(() =>
      Response.json({ error: { message: "slow down" } }, { status: 429 })
    );

    try {
      const { status, json } = await post(
        "/ai/provider",
        providerBody({}),
        aiEnv(),
        {
          fetchUpstream: localFetch(upstream.url),
        }
      );

      expect(status).toBe(429);
      expect(json).toEqual({ error: "slow down" });
    } finally {
      upstream.close();
    }
  });

  test("upstream text errors pass through as {error}", async () => {
    const upstream = startUpstream(() => new Response("boom", { status: 500 }));

    try {
      const { status, json } = await post(
        "/ai/provider",
        providerBody({}),
        aiEnv(),
        {
          fetchUpstream: localFetch(upstream.url),
        }
      );

      expect(status).toBe(500);
      expect(json).toEqual({ error: "boom" });
    } finally {
      upstream.close();
    }
  });

  test("success keeps status plus content-type/cache-control only", async () => {
    const upstream = startUpstream(() =>
      Response.json(
        { hello: "world" },
        {
          headers: { "cache-control": "max-age=60", "x-custom": "drop-me" },
          status: 201,
        }
      )
    );

    try {
      const { status, json } = await post(
        "/ai/provider",
        providerBody({}),
        aiEnv(),
        {
          fetchUpstream: localFetch(upstream.url),
        }
      );

      expect(status).toBe(201);
      expect(json).toEqual({ hello: "world" });
    } finally {
      upstream.close();
    }
  });

  test("SSE bytes stream through untouched", async () => {
    const frames = [
      'data: {"a":1}\n\n',
      'data: {"b":2}\n\n',
      "data: [DONE]\n\n",
    ];

    const upstream = startUpstream(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const frame of frames) {
                controller.enqueue(new TextEncoder().encode(frame));
              }

              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
    );

    try {
      const deps = { fetchUpstream: localFetch(upstream.url) };

      const req = new Request("https://proxy/ai/provider", {
        body: JSON.stringify({
          aiToken: "test-token-0123456789abcdef",
          projectId: "proj_test123",
          ...providerBody({}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      const { handleFetch } = await import("./worker.ts");
      const res = await handleFetch(req, aiEnv(), deps);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(await res.text()).toBe(frames.join(""));
    } finally {
      upstream.close();
    }
  });

  test("upstream transport failure is a 502", async () => {
    const { status, json } = await post(
      "/ai/provider",
      providerBody({}),
      aiEnv(),
      {
        fetchUpstream: () => Promise.reject(new Error("dial failed")),
      }
    );

    expect(status).toBe(502);
    expect(json).toEqual({ error: "upstream error" });
  });
});

describe("/ai/run", () => {
  const MODELS = {
    "@cf/meta/llama": {
      endpoint: "https://operator.example.com/v1",
      model: "llama-local",
    },
  };

  test("missing model is a 400", async () => {
    const { status, json } = await post("/ai/run", { inputs: {} }, aiEnv());
    expect(status).toBe(400);
    expect(json).toEqual({ error: "model required" });
  });

  test("unmapped model is a loud 501, never a substitute", async () => {
    const env = aiEnv({ VOID_PROXY_AI_MODELS: JSON.stringify(MODELS) });

    const { status, json } = await post(
      "/ai/run",
      { inputs: { messages: [] }, model: "@cf/other/model" },
      env
    );

    expect(status).toBe(501);
    expect(json).toEqual({
      error: "model not available",
      model: "@cf/other/model",
    });
  });

  test("missing map means every model is unavailable", async () => {
    const { status, json } = await post(
      "/ai/run",
      { inputs: { messages: [] }, model: "@cf/meta/llama" },
      aiEnv()
    );

    expect(status).toBe(501);
    expect(json).toEqual({
      error: "model not available",
      model: "@cf/meta/llama",
    });
  });

  test("invalid map JSON is a 502", async () => {
    const env = aiEnv({ VOID_PROXY_AI_MODELS: "{nope" });

    const { status, json } = await post(
      "/ai/run",
      { inputs: { messages: [] }, model: "@cf/meta/llama" },
      env
    );

    expect(status).toBe(502);
    expect(json).toEqual({ error: "ai model map invalid" });
  });

  test("non-chat inputs are a 501 with a clear message", async () => {
    const env = aiEnv({ VOID_PROXY_AI_MODELS: JSON.stringify(MODELS) });

    const { status, json } = await post(
      "/ai/run",
      { inputs: { prompt: "draw me a sheep" }, model: "@cf/meta/llama" },
      env
    );

    expect(status).toBe(501);
    expect(json).toEqual({
      error: "model input not supported",
      message:
        "Noite /ai/run supports chat inputs ({ messages: [...] }) only; this model input has another task shape.",
    });
  });

  test("mapped chat calls POST the endpoint with the mapped model", async () => {
    const upstream = startUpstream(() =>
      Response.json({ choices: [{ index: 0 }], usage: { t: 1 } })
    );

    try {
      const seenUrls: string[] = [];

      const env = aiEnv({
        VOID_PROXY_AI_API_KEY: "app-key",
        VOID_PROXY_AI_MODELS: JSON.stringify(MODELS),
      });

      const { status, json } = await post(
        "/ai/run",
        {
          inputs: {
            messages: [{ content: "hi", role: "user" }],
            temperature: 0.5,
          },
          model: "@cf/meta/llama",
        },
        env,
        { fetchUpstream: localFetch(upstream.url, seenUrls) }
      );

      expect(status).toBe(200);
      // Endpoint-native shape passes through untranslated.
      expect(json).toEqual({ choices: [{ index: 0 }], usage: { t: 1 } });
      expect(seenUrls).toEqual([
        "https://operator.example.com/v1/chat/completions",
      ]);
      const seen = onlyRequest(upstream.requests);
      expect(seen.method).toBe("POST");
      expect(seen.headers["authorization"]).toBe("Bearer app-key");
      expect(JSON.parse(new TextDecoder().decode(seen.body))).toEqual({
        messages: [{ content: "hi", role: "user" }],
        model: "llama-local",
        temperature: 0.5,
      });
    } finally {
      upstream.close();
    }
  });

  test("keyless endpoints send no authorization header", async () => {
    const upstream = startUpstream(() => Response.json({ ok: true }));

    try {
      const env = aiEnv({ VOID_PROXY_AI_MODELS: JSON.stringify(MODELS) });
      await post(
        "/ai/run",
        { inputs: { messages: [] }, model: "@cf/meta/llama" },
        env,
        {
          fetchUpstream: localFetch(upstream.url),
        }
      );
      expect(
        onlyRequest(upstream.requests).headers["authorization"]
      ).toBeUndefined();
    } finally {
      upstream.close();
    }
  });

  test("stream:true streams SSE through", async () => {
    const frames = ['data: {"x":1}\n\n', "data: [DONE]\n\n"];

    const upstream = startUpstream(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const frame of frames) {
                controller.enqueue(new TextEncoder().encode(frame));
              }

              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
    );

    try {
      const env = aiEnv({ VOID_PROXY_AI_MODELS: JSON.stringify(MODELS) });
      const { handleFetch } = await import("./worker.ts");

      const res = await handleFetch(
        new Request("https://proxy/ai/run", {
          body: JSON.stringify({
            aiToken: "test-token-0123456789abcdef",
            inputs: { messages: [], stream: true },
            model: "@cf/meta/llama",
            projectId: "proj_test123",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        env,
        { fetchUpstream: localFetch(upstream.url) }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(await res.text()).toBe(frames.join(""));
    } finally {
      upstream.close();
    }
  });

  test("stream:true with an upstream error returns the error, not 200 SSE", async () => {
    const upstream = startUpstream(() =>
      Response.json(
        { error: { message: "bad key", type: "auth" } },
        { status: 401 }
      )
    );

    try {
      const env = aiEnv({ VOID_PROXY_AI_MODELS: JSON.stringify(MODELS) });
      const { handleFetch } = await import("./worker.ts");

      const res = await handleFetch(
        new Request("https://proxy/ai/run", {
          body: JSON.stringify({
            aiToken: "test-token-0123456789abcdef",
            inputs: { messages: [], stream: true },
            model: "@cf/meta/llama",
            projectId: "proj_test123",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        env,
        { fetchUpstream: localFetch(upstream.url) }
      );

      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).not.toBe("text/event-stream");
      expect(await res.json()).toEqual({
        error: { message: "bad key", type: "auth" },
      });
    } finally {
      upstream.close();
    }
  });

  test("upstream errors pass through endpoint-native", async () => {
    const upstream = startUpstream(() =>
      Response.json(
        { error: { message: "bad key", type: "auth" } },
        { status: 401 }
      )
    );

    try {
      const env = aiEnv({ VOID_PROXY_AI_MODELS: JSON.stringify(MODELS) });

      const { status, json } = await post(
        "/ai/run",
        { inputs: { messages: [] }, model: "@cf/meta/llama" },
        env,
        { fetchUpstream: localFetch(upstream.url) }
      );

      expect(status).toBe(401);
      expect(json).toEqual({ error: { message: "bad key", type: "auth" } });
    } finally {
      upstream.close();
    }
  });

  test("upstream transport failure is a 502", async () => {
    const env = aiEnv({ VOID_PROXY_AI_MODELS: JSON.stringify(MODELS) });

    const { status, json } = await post(
      "/ai/run",
      { inputs: { messages: [] }, model: "@cf/meta/llama" },
      env,
      { fetchUpstream: () => Promise.reject(new Error("dial failed")) }
    );

    expect(status).toBe(502);
    expect(json).toEqual({ error: "upstream error" });
  });
});

describe("/ai/models and /ai/toMarkdown", () => {
  test.each(["/ai/models", "/ai/toMarkdown"])(
    "%s is a loud 501",
    async (path) => {
      const { status, json } = await post(path, { inputs: {} }, aiEnv());
      expect(status).toBe(501);
      expect(json).toEqual({
        error: "not available",
        message:
          "This operation requires the Workers AI binding, which Noite does not provide.",
      });
    }
  );
});
