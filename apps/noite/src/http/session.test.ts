/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, no-console -- test doubles: a minimal KitEnv stands in for the Worker env; the OTP travels through this test's own console, never a real inbox */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { authFromEnv } from "../lib/auth";
import { ensureDb, setD1Binding } from "../lib/db";
import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { installRunnerMock, makeApp } from "../testing/runner-mock";
import type { RunnerMock } from "../testing/runner-mock";
import { handleSourceCommit } from "./routes/source";
import { handleAppsStream } from "./routes/streams";
import { routeGate } from "./session";

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "route-gate-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:9080",
};

let db: TestD1;
let runner: RunnerMock;

beforeEach(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
  runner = installRunnerMock([
    makeApp({ id: "app-1", slug: "app-one", userId: "u-owner" }),
  ]);

  return () => {
    runner.restore();
  };
});

/** A real better-auth session cookie: the OTP flow mints it exactly as the
 * login panel does (console delivery on localhost). The waitlist flips the
 * row after the ceremony minted the session — or registration created it
 * pending outright. */
// Distinct client addresses per mint: better-auth budgets `/api/auth` per
// client IP, and the test harness sends none (one shared bucket for every
// caller) — without this the file's own mints throttle each other.
let mintedClients = 0;

const mintSessionCookie = async (email: string): Promise<string> => {
  mintedClients += 1;
  const clientIp = `10.9.9.${mintedClients}`;
  db.raw.run(
    `INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, ?)`,
    [`user-${email}`, "Test User", email, 1]
  );
  const lines: unknown[][] = [];

  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args);
  });

  try {
    const auth = authFromEnv(ENV as unknown as KitEnv, ENV.BETTER_AUTH_URL);
    await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers: new Headers({ "x-forwarded-for": clientIp }),
    });
  } finally {
    log.mockRestore();
  }

  const line = lines
    .map((args) => String(args[0] ?? ""))
    .find((text) => text.includes(`sign-in code for ${email}:`));

  const otp = line?.split(":").at(-1)?.trim();

  if (!otp) {
    throw new Error("better-auth delivered no OTP code");
  }

  const auth = authFromEnv(ENV as unknown as KitEnv, ENV.BETTER_AUTH_URL);

  const signedIn = await auth.handler(
    new Request(`${ENV.BETTER_AUTH_URL}/api/auth/sign-in/email-otp`, {
      body: JSON.stringify({ email, otp }),
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": clientIp,
      },
      method: "POST",
    })
  );

  if (!signedIn.ok) {
    throw new Error(`better-auth sign-in failed with ${signedIn.status}`);
  }

  const session = signedIn.headers
    .getSetCookie()
    .find((entry) => entry.startsWith("better-auth.session_token="));

  if (!session) {
    throw new Error("better-auth signed in with no session cookie");
  }

  return session.split(";")[0] ?? "";
};

const authed = (cookie: string, path: string, init?: RequestInit): Request =>
  new Request(`${ENV.BETTER_AUTH_URL}${path}`, {
    ...init,
    headers: { cookie, origin: ENV.BETTER_AUTH_URL, ...init?.headers },
    method: init?.method ?? "GET",
  });

describe("routeGate", () => {
  test("an active session resolves to its user id", async () => {
    const cookie = await mintSessionCookie("active@example.com");

    const gate = await routeGate(
      authed(cookie, "/api/apps/get"),
      ENV as unknown as KitEnv
    );

    expect(gate).toMatchObject({ userId: `user-active@example.com` });
  });

  test("a signed-out request is refused 401", async () => {
    const gate = await routeGate(
      authed("better-auth.session_token=absent", "/api/apps/get"),
      ENV as unknown as KitEnv
    );

    if (!("response" in gate)) {
      throw new Error("a signed-out request passed the route gate");
    }

    expect(gate.response.status).toBe(401);
  });

  test("a pending session is refused 403, never served", async () => {
    const cookie = await mintSessionCookie("waiting@example.com");
    db.raw.run(`UPDATE "user" SET status = 'pending' WHERE email = ?`, [
      "waiting@example.com",
    ]);

    const gate = await routeGate(
      authed(cookie, "/api/apps/get"),
      ENV as unknown as KitEnv
    );

    if (!("response" in gate)) {
      throw new Error("a pending session passed the route gate");
    }

    expect(gate.response.status).toBe(403);
  });

  test("a banned session is refused 403, never served", async () => {
    const cookie = await mintSessionCookie("banned@example.com");
    db.raw.run(`UPDATE "user" SET banned = 1 WHERE email = ?`, [
      "banned@example.com",
    ]);

    const gate = await routeGate(
      authed(cookie, "/api/apps/get"),
      ENV as unknown as KitEnv
    );

    if (!("response" in gate)) {
      throw new Error("a banned session passed the route gate");
    }

    expect(gate.response.status).toBe(403);
  });
});

describe("pending accounts at the browser routes", () => {
  test("a pending session gets 403 on a stream route", async () => {
    const cookie = await mintSessionCookie("stream-waiting@example.com");
    db.raw.run(`UPDATE "user" SET status = 'pending' WHERE email = ?`, [
      "stream-waiting@example.com",
    ]);

    const response = await handleAppsStream(
      authed(cookie, "/api/apps/stream"),
      ENV as unknown as KitEnv,
      {}
    );

    expect(response?.status).toBe(403);
  });

  test("a pending session gets 403 on a source route, grant or not", async () => {
    const cookie = await mintSessionCookie("source-waiting@example.com");
    db.raw.run(`UPDATE "user" SET status = 'pending' WHERE email = ?`, [
      "source-waiting@example.com",
    ]);
    // A stale collaborator row must not admit the account: the refusal runs
    // before any role check, so even a granted app answers 403.
    db.raw.run(
      `INSERT INTO app_collaborator (id, appId, userId, role) VALUES ('c-waiting', 'app-1', ?, 'push')`,
      [`user-source-waiting@example.com`]
    );

    const response = await handleSourceCommit(
      authed(cookie, "/api/source/commit", {
        body: JSON.stringify({ files: [], message: "waiting commit" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      ENV as unknown as KitEnv,
      { appId: "app-1" }
    );

    expect(response?.status).toBe(403);
  });
});
