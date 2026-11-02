// Auth, routing, body limits, /revalidate, and ISR golden vectors.
/* oxlint-disable anti-slop/no-unknown-parameters -- the request builder takes any JSON body */
import { describe, expect, test } from "bun:test";

import {
  FakeKv,
  makeEnv,
  post,
  TEST_PROJECT_ID,
  TEST_TOKEN,
} from "./test-helpers.ts";
import {
  handleFetch,
  hashOriginalUrl,
  isrCacheKey,
  isrCachePrefix,
  isrCacheVariantPrefix,
  normalizeIsrPath,
  splitIsrCacheKey,
} from "./worker.ts";

const DIRECT = "__void_direct__";

const authed = (path: string, body: unknown): Request =>
  new Request(`https://proxy${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const seed = (kv: FakeKv): void => {
  // Two deployment ids, two hosts, direct hits + variants + unrelated keys.
  kv.store.set(`${DIRECT}/isr/v3/dep1/example.com/__index__`, "a");
  kv.store.set(`${DIRECT}/isr/v3/dep1/example.com/blog/hello`, "a");
  kv.store.set(`${DIRECT}/isr/v3/dep1/example.com/blog/hello#rw=tok1`, "a");
  kv.store.set(`${DIRECT}/isr/v3/dep1/www.example.com/blog/hello`, "a");
  kv.store.set(`${DIRECT}/isr/v3/dep1/example.com/blog/hello-world`, "a");
  kv.store.set(`${DIRECT}/isr/v3/dep2/example.com/blog/hello`, "a");
  kv.store.set(`${DIRECT}/isr/v3/dep2/example.com/blog/hello#rw=tok2`, "a");
  kv.store.set(`${DIRECT}/isr/v3/dep2/other.test/about`, "a");
  kv.store.set("void-isr-hosts/dep1/example.com", "");
  kv.store.set("void-isr-hosts/dep2/other.test", "");
  kv.store.set("idemp/v1/some-key", "{}");
};

describe("auth", () => {
  const env = makeEnv({ ISR_CACHE: new FakeKv() });

  test("accepts the fleet token with the pinned project id", async () => {
    const { status, json } = await post("/revalidate", { paths: [] }, env);
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, purged: 0 });
  });

  test("missing aiToken is a 400 with Void's shape", async () => {
    const res = await handleFetch(
      authed("/revalidate", { projectId: TEST_PROJECT_ID }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "projectId and aiToken required",
    });
  });

  test("missing projectId is a 400", async () => {
    const res = await handleFetch(
      authed("/revalidate", { aiToken: TEST_TOKEN }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "projectId and aiToken required",
    });
  });

  test("non-string credentials are a 400", async () => {
    const res = await handleFetch(
      authed("/revalidate", { aiToken: 12_345, projectId: TEST_PROJECT_ID }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "projectId and aiToken required",
    });
  });

  test("wrong token is a 403 with Void's shape", async () => {
    const res = await handleFetch(
      authed("/revalidate", {
        aiToken: "wrong-token-value-here!!",
        projectId: TEST_PROJECT_ID,
      }),
      env
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid project token" });
  });

  test("shorter token is a 403 (length check first)", async () => {
    const res = await handleFetch(
      authed("/revalidate", { aiToken: "short", projectId: TEST_PROJECT_ID }),
      env
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid project token" });
  });

  test("another app's projectId is pinned out: 403 and nothing purged", async () => {
    const kv = new FakeKv();
    kv.store.set(`${DIRECT}/isr/v3/dep1/example.com/blog`, "cached");
    const pinEnv = makeEnv({ ISR_CACHE: kv });

    const res = await handleFetch(
      authed("/revalidate", {
        aiToken: TEST_TOKEN,
        all: true,
        projectId: "proj_other_app",
      }),
      pinEnv
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid project token" });
    expect(kv.store.get(`${DIRECT}/isr/v3/dep1/example.com/blog`)).toBe(
      "cached"
    );
  });

  test("missing proxy token config fails closed with 500", async () => {
    const broken = makeEnv({ ISR_CACHE: new FakeKv(), __VOID_PROXY_TOKEN: "" });
    const { status, json } = await post("/revalidate", { paths: [] }, broken);
    expect(status).toBe(500);
    expect(json).toEqual({ error: "proxy not configured" });
  });
});

describe("routing", () => {
  test("GET /health reports configured bindings", async () => {
    const env = makeEnv({
      ISR_CACHE: new FakeKv(),
      MAIL_IDEMPOTENCY: new FakeKv(),
      VOID_PROXY_AI_ENABLED: "1",
      VOID_PROXY_AI_MODELS: JSON.stringify({
        "@cf/x": { endpoint: "https://e", model: "m" },
      }),
      VOID_PROXY_SMTP_HOST: "smtp.example.com",
    });

    const res = await handleFetch(new Request("https://proxy/health"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      bindings: {
        ai: true,
        aiRun: true,
        email: true,
        emailDomain: true,
        isrCache: true,
        mailKv: true,
      },
      ok: true,
    });
  });

  test("GET /health reports missing bindings as false", async () => {
    const res = await handleFetch(
      new Request("https://proxy/health"),
      makeEnv()
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      bindings: {
        ai: false,
        aiRun: false,
        email: false,
        emailDomain: true,
        isrCache: false,
        mailKv: false,
      },
      ok: true,
    });
  });

  test("POST /health is a 405", async () => {
    const res = await handleFetch(
      new Request("https://proxy/health", { method: "POST" }),
      makeEnv()
    );

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method not allowed" });
  });

  test("GET on a POST route is a 405", async () => {
    const res = await handleFetch(
      new Request("https://proxy/revalidate"),
      makeEnv()
    );

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method not allowed" });
  });

  test("unknown paths are 404", async () => {
    for (const method of ["GET", "POST"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cases, each asserted before the next
      const res = await handleFetch(
        new Request("https://proxy/nope", { method }),
        makeEnv({ ISR_CACHE: new FakeKv() })
      );

      expect(res.status).toBe(404);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cases, each asserted before the next
      expect(await res.json()).toEqual({ error: "not found" });
    }
  });

  test("/email/relay is a 404 tombstone before auth", async () => {
    const res = await handleFetch(
      new Request("https://proxy/email/relay", { method: "POST" }),
      makeEnv()
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("/email/verify-receipt is 404 in v1", async () => {
    const res = await handleFetch(
      authed("/email/verify-receipt", {
        aiToken: TEST_TOKEN,
        projectId: TEST_PROJECT_ID,
      }),
      makeEnv({ ISR_CACHE: new FakeKv() })
    );

    expect(res.status).toBe(404);
  });
});

describe("request body limits", () => {
  const env = makeEnv({ ISR_CACHE: new FakeKv() });

  test("declared content-length over the cap is a 413 before parsing", async () => {
    const res = await handleFetch(
      new Request("https://proxy/revalidate", {
        body: JSON.stringify({
          aiToken: TEST_TOKEN,
          projectId: TEST_PROJECT_ID,
        }),
        headers: {
          "content-length": String(2 * 1024 * 1024),
          "content-type": "application/json",
        },
        method: "POST",
      }),
      env
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
  });

  test("an actually oversized body is a 413", async () => {
    const big = "x".repeat(1024 * 1024 + 1);

    const res = await handleFetch(
      new Request("https://proxy/revalidate", {
        body: JSON.stringify({
          aiToken: TEST_TOKEN,
          pad: big,
          projectId: TEST_PROJECT_ID,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
  });

  test("malformed JSON is a 400", async () => {
    const res = await handleFetch(
      new Request("https://proxy/revalidate", {
        body: "{nope",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  test("non-object JSON is a 400", async () => {
    const res = await handleFetch(
      new Request("https://proxy/revalidate", {
        body: "[1,2]",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  test("empty body is a 400", async () => {
    const res = await handleFetch(
      new Request("https://proxy/revalidate", {
        body: "",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env
    );

    expect(res.status).toBe(400);
  });
});

describe("ISR key ports (golden vectors from Void's own functions)", () => {
  // Expected values below were generated by running Void's
  // `packages/isr/src/index.ts` key functions (`/tmp/void-vectors.ts`) and
  // hard-coded here, so drift from Void fails loudly.
  test("normalizeIsrPath", () => {
    expect(normalizeIsrPath("/")).toBe("__index__");
    expect(normalizeIsrPath("/blog/hello")).toBe("blog/hello");
    expect(normalizeIsrPath("/blog/hello/")).toBe("blog/hello");
    expect(normalizeIsrPath("blog")).toBe("blog");
    expect(normalizeIsrPath("")).toBe("");
    expect(normalizeIsrPath("/a//b")).toBe("a//b");
  });

  test("prefix shapes", () => {
    expect(isrCachePrefix(DIRECT)).toBe("__void_direct__/isr/");
    expect(isrCachePrefix(DIRECT, "")).toBe("__void_direct__/isr/v3//");
    expect(isrCachePrefix(DIRECT, "dep1")).toBe("__void_direct__/isr/v3/dep1/");
  });

  test("isrCacheKey", () => {
    expect(isrCacheKey(DIRECT, "dep1", "example.com", "/")).toBe(
      "__void_direct__/isr/v3/dep1/example.com/__index__"
    );
    expect(isrCacheKey(DIRECT, "dep1", "example.com", "/blog/hello")).toBe(
      "__void_direct__/isr/v3/dep1/example.com/blog/hello"
    );
    expect(isrCacheKey(DIRECT, "dep1", "example.com", "/blog/hello/")).toBe(
      "__void_direct__/isr/v3/dep1/example.com/blog/hello"
    );
  });

  test("variant keys and FNV tokens", () => {
    expect(hashOriginalUrl("https://example.com/en/docs?x=1")).toBe(
      "6e6839223953d3ba"
    );
    expect(hashOriginalUrl("")).toBe("cbf29ce484222325");
    expect(hashOriginalUrl("https://example.com/café?q=ü")).toBe(
      "454d82c6be732bda"
    );
    expect(
      isrCacheKey(
        DIRECT,
        "dep1",
        "example.com",
        "/docs",
        "https://example.com/en/docs?x=1"
      )
    ).toBe("__void_direct__/isr/v3/dep1/example.com/docs#rw=6e6839223953d3ba");
    expect(isrCacheVariantPrefix(DIRECT, "dep1", "example.com", "/docs")).toBe(
      "__void_direct__/isr/v3/dep1/example.com/docs#rw="
    );
  });

  test("splitIsrCacheKey", () => {
    expect(splitIsrCacheKey("blog/hello")).toEqual({
      normalizedPath: "blog/hello",
      variantToken: null,
    });
    expect(splitIsrCacheKey("docs#rw=6e6839223953d3ba")).toEqual({
      normalizedPath: "docs",
      variantToken: "6e6839223953d3ba",
    });
    expect(splitIsrCacheKey("a/b/c#rw=0123456789abcdef")).toEqual({
      normalizedPath: "a/b/c",
      variantToken: "0123456789abcdef",
    });
    expect(splitIsrCacheKey("docs#rw=")).toEqual({
      normalizedPath: "docs",
      variantToken: "",
    });
  });
});

describe("/revalidate", () => {
  test("all:true purges every deployment id plus the host registry", async () => {
    const kv = new FakeKv();
    seed(kv);

    const { status, json } = await post(
      "/revalidate",
      { all: true },
      makeEnv({ ISR_CACHE: kv })
    );

    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, purged: 10 });
    expect(kv.store.size).toBe(1);
    expect(kv.store.get("idemp/v1/some-key")).toBe("{}");
  });

  test("paths purge across hosts and deployment ids, including variants", async () => {
    const kv = new FakeKv();
    seed(kv);

    const { status, json } = await post(
      "/revalidate",
      { paths: ["/blog/hello"] },
      makeEnv({ ISR_CACHE: kv })
    );

    expect(status).toBe(200);
    // dep1/example.com direct + variant, www direct, dep2 direct + variant.
    expect(json).toEqual({ ok: true, purged: 5 });
    expect(
      kv.store.get(`${DIRECT}/isr/v3/dep1/example.com/blog/hello-world`)
    ).toBe("a");
    expect(kv.store.get(`${DIRECT}/isr/v3/dep2/other.test/about`)).toBe("a");
    expect(kv.store.get(`${DIRECT}/isr/v3/dep1/example.com/__index__`)).toBe(
      "a"
    );
    expect(kv.store.get("void-isr-hosts/dep1/example.com")).toBe("");
  });

  test("path normalization matches Void: trailing slash and root", async () => {
    const kv = new FakeKv();
    seed(kv);
    const env = makeEnv({ ISR_CACHE: kv });
    const slash = await post("/revalidate", { paths: ["/blog/hello/"] }, env);
    expect(slash.json).toEqual({ ok: true, purged: 5 });
    const root = await post("/revalidate", { paths: ["/"] }, env);
    expect(root.json).toEqual({ ok: true, purged: 1 });
    expect(
      kv.store.get(`${DIRECT}/isr/v3/dep1/example.com/__index__`)
    ).toBeUndefined();
  });

  test("a path prefix does not match its siblings", async () => {
    const kv = new FakeKv();
    seed(kv);

    const { json } = await post(
      "/revalidate",
      { paths: ["/blog"] },
      makeEnv({ ISR_CACHE: kv })
    );

    expect(json).toEqual({ ok: true, purged: 0 });
  });

  test("empty paths with no all is a no-op success", async () => {
    const kv = new FakeKv();
    seed(kv);

    const { status, json } = await post(
      "/revalidate",
      {},
      makeEnv({ ISR_CACHE: kv })
    );

    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, purged: 0 });
    expect(kv.store.size).toBe(11);
  });

  test("non-string paths are ignored", async () => {
    const kv = new FakeKv();
    seed(kv);

    const { json } = await post(
      "/revalidate",
      { paths: [42, null, { x: 1 }] },
      makeEnv({ ISR_CACHE: kv })
    );

    expect(json).toEqual({ ok: true, purged: 0 });
  });

  test("malformed keys under the prefix never match a path purge", async () => {
    const kv = new FakeKv();
    kv.store.set(`${DIRECT}/isr/v3/dep1`, "odd");
    kv.store.set(`${DIRECT}/isr/v3/dep1/`, "odd");
    kv.store.set(`${DIRECT}/isr/v3/`, "odd");

    const { json } = await post(
      "/revalidate",
      { paths: ["/dep1"] },
      makeEnv({ ISR_CACHE: kv })
    );

    expect(json).toEqual({ ok: true, purged: 0 });
    expect(kv.store.size).toBe(3);
  });

  test("all:true pages through large key sets", async () => {
    const kv = new FakeKv();

    for (let i = 0; i < 2200; i += 1) {
      kv.store.set(`${DIRECT}/isr/v3/dep9/h.test/p${i}`, "v");
    }

    const { status, json } = await post(
      "/revalidate",
      { all: true },
      makeEnv({ ISR_CACHE: kv })
    );

    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, purged: 2200 });
    expect(kv.store.size).toBe(0);
  });

  test("missing ISR_CACHE binding is a loud 502", async () => {
    const { status, json } = await post(
      "/revalidate",
      { all: true },
      makeEnv()
    );

    expect(status).toBe(502);
    expect(json).toEqual({ error: "isr cache not configured" });
  });

  test("KV failure is a loud 502", async () => {
    const kv = new FakeKv();
    kv.fail.list = true;

    const { status, json } = await post(
      "/revalidate",
      { all: true },
      makeEnv({ ISR_CACHE: kv })
    );

    expect(status).toBe(502);
    expect(json).toEqual({ error: "revalidation failed: kv boom" });
  });

  test("KV delete failure is a loud 502", async () => {
    const kv = new FakeKv();
    seed(kv);
    kv.fail.delete = true;

    const { status, json } = await post(
      "/revalidate",
      { all: true },
      makeEnv({ ISR_CACHE: kv })
    );

    expect(status).toBe(502);
    expect(json).toEqual({ error: "revalidation failed: kv boom" });
  });
});

describe("platform surface guard", () => {
  test("worker source never touches the edge cache", async () => {
    const source = await Bun.file(new URL("worker.ts", import.meta.url)).text();
    expect(source).not.toMatch(/[^A-Za-z]caches\s*\./u);
  });
});
