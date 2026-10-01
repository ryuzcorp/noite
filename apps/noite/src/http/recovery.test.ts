/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { authFromEnv } from "../lib/auth";
import { ensureDbPromise, setD1Binding } from "../lib/db";
import { resetRateLimits } from "../lib/rate-limit";
import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { handleHttp } from "./routes";

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "recovery-test-secret-recovery-test-secret",
  BETTER_AUTH_URL: "http://localhost:9080",
  RUNNER_TOKEN: "runner-secret",
};

let db: TestD1;

beforeEach(async () => {
  resetRateLimits();
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDbPromise();
});

const addUser = (id: string, role: string, banned = 0) => {
  db.raw.run(
    `INSERT INTO "user" (id, name, email, role, banned) VALUES (?, ?, ?, ?, ?)`,
    [id, id, `${id}@example.com`, role, banned]
  );
};

interface MintBody {
  email?: string;
}

const mint = (
  body: MintBody,
  token = ENV.RUNNER_TOKEN,
  env: Record<string, string> = ENV
) =>
  Promise.resolve(
    handleHttp(
      new Request("http://localhost:9080/internal/recovery", {
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${token}` },
        method: "POST",
      }),
      env as unknown as never
    )
  ) as Promise<Response>;

describe("POST /internal/recovery", () => {
  test("refuses callers without the runner token", async () => {
    addUser("owner", "admin");
    const response = await mint({}, "wrong");
    expect(response.status).toBe(401);
  });

  test("mints a code for the oldest admin that signs in once", async () => {
    addUser("owner", "admin");
    addUser("member", "user");
    const response = await mint({});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const minted = (await response.json()) as {
      code: string;
      email: string;
      ok: boolean;
    };
    expect(minted.email).toBe("owner@example.com");
    expect(minted.code).toMatch(/^\d{6}$/u);

    const auth = authFromEnv(ENV as unknown as KitEnv, ENV.BETTER_AUTH_URL);
    const signedIn = await auth.api.signInEmailOTP({
      body: { email: minted.email, otp: minted.code },
    });
    expect(signedIn.user.email).toBe("owner@example.com");
  });

  test("mints for a named account, case-insensitively", async () => {
    addUser("owner", "admin");
    addUser("member", "user");
    const response = await mint({ email: "Member@Example.com" });
    const minted = (await response.json()) as { email: string };
    expect(minted.email).toBe("member@example.com");
  });

  test("answers 404, with a reason, when there is nobody to recover", async () => {
    const none = await mint({});
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toContain(
      "sign up first"
    );

    addUser("owner", "admin", 1);
    const banned = await mint({});
    expect(banned.status).toBe(404);

    const unknown = await mint({ email: "ghost@example.com" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toContain(
      "ghost@example.com"
    );
  });

  test("is rate limited like the other public machine routes", async () => {
    const env = { ...ENV, NOITE_RATE_LIMIT_RPM: "2" };
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the limiter counts in order
      const response = await mint({}, "wrong", env);
      statuses.push(response.status);
    }
    expect(statuses).toEqual([401, 401, 429, 429]);
  });
});

describe("emailed codes", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("go to the configured webhook on a real domain, not the console", async () => {
    addUser("owner", "admin");
    const posted: { body: string; url: string }[] = [];
    // SAFETY: authentication only calls fetch(url, init) for the webhook post.
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      posted.push({ body: String(init?.body), url });
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;
    const env = {
      ...ENV,
      BASE_DOMAIN: "noite.example",
      BETTER_AUTH_URL: "https://app.noite.example",
      NOITE_EMAIL_WEBHOOK_URL: "https://hooks.example/otp",
    };
    const auth = authFromEnv(env as unknown as KitEnv, env.BETTER_AUTH_URL);
    await auth.api.sendVerificationOTP({
      body: { email: "owner@example.com", type: "sign-in" },
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe("https://hooks.example/otp");
    expect(JSON.parse(posted[0]?.body ?? "{}")).toMatchObject({
      email: "owner@example.com",
      type: "sign-in",
    });
  });

  test("are never written to the console on a real domain with no webhook", async () => {
    addUser("owner", "admin");
    const env = {
      ...ENV,
      BASE_DOMAIN: "noite.example",
      BETTER_AUTH_URL: "https://app.noite.example",
    };
    const logged: string[] = [];
    const realLog = console.log;
    const realError = console.error;
    console.log = (...args: unknown[]) => {
      logged.push(`log ${args.join(" ")}`);
    };
    console.error = (...args: unknown[]) => {
      logged.push(`error ${args.join(" ")}`);
    };
    try {
      const auth = authFromEnv(env as unknown as KitEnv, env.BETTER_AUTH_URL);
      // better-auth catches a sender failure and logs it, so the request
      // itself resolves: what matters is that no code reaches the console.
      await auth.api.sendVerificationOTP({
        body: { email: "owner@example.com", type: "sign-in" },
      });
    } finally {
      console.log = realLog;
      console.error = realError;
    }
    expect(logged.some((line) => line.startsWith("log "))).toBe(false);
    expect(logged.join("\n")).toContain("NOITE_EMAIL_WEBHOOK_URL");
  });
});
