/* oxlint-disable no-console, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- the OTP code travels through this test's own console spy, the delivery channel the product itself uses on localhost; the env is the Worker shape by hand, like the other server tests */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createTestD1 } from "../../testing/d1";
import type { TestD1 } from "../../testing/d1";
import { authFromEnv } from "../auth";
import { ensureDb, setD1Binding } from "../db";
import { keyOwnerActive } from "./api-keys.server";

let db: TestD1;

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "keys-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:9080",
} as unknown as KitEnv;

beforeEach(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

let mintCount = 0;

/** A real better-auth session cookie. One client IP per mint: better-auth
 * budgets OTP sends/sign-ins per IP (a shared bucket when unknown). */
const mintCookie = async (
  id: string,
  email: string,
  status = "active"
): Promise<string> => {
  db.raw.run(
    `INSERT INTO "user" (id, name, email, emailVerified, status) VALUES (?, ?, ?, ?, ?)`,
    [id, id, email, 1, status]
  );

  mintCount += 1;
  const headers = { "x-forwarded-for": `10.201.0.${mintCount}` };
  const lines: unknown[][] = [];

  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args);
  });

  try {
    const auth = authFromEnv(ENV, ENV.BETTER_AUTH_URL ?? "");
    await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers: new Headers(headers),
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

  const auth = authFromEnv(ENV, ENV.BETTER_AUTH_URL ?? "");

  const signedIn = await auth.handler(
    new Request(`${ENV.BETTER_AUTH_URL ?? ""}/api/auth/sign-in/email-otp`, {
      body: JSON.stringify({ email, otp }),
      headers: { "content-type": "application/json", ...headers },
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

describe("keyOwnerActive", () => {
  test("only active, unbanned owners may act", async () => {
    db.raw.run(
      `INSERT INTO "user" (id, name, email) VALUES ('a', 'a', 'a@example.com')`
    );
    db.raw.run(
      `INSERT INTO "user" (id, name, email, status) VALUES ('w', 'w', 'w@example.com', 'pending')`
    );
    db.raw.run(
      `INSERT INTO "user" (id, name, email, banned) VALUES ('b', 'b', 'b@example.com', 1)`
    );

    expect(await keyOwnerActive("a")).toBe(true);
    // A waitlist account holds no access: its keys refuse like a ban.
    expect(await keyOwnerActive("w")).toBe(false);
    expect(await keyOwnerActive("b")).toBe(false);
    // A missing row is never served.
    expect(await keyOwnerActive("ghost")).toBe(false);
  });
});

describe("api-key create hook", () => {
  test("a pending owner cannot mint machine credentials", async () => {
    const waiting = await mintCookie("w-1", "waiting@example.com", "pending");
    const auth = authFromEnv(ENV, ENV.BETTER_AUTH_URL ?? "");

    const refused = await auth.handler(
      new Request(`${ENV.BETTER_AUTH_URL ?? ""}/api/auth/api-key/create`, {
        body: JSON.stringify({ name: "ci-key" }),
        headers: { "content-type": "application/json", cookie: waiting },
        method: "POST",
      })
    );

    expect(refused.status).toBe(403);
  });

  test("an active owner mints as before", async () => {
    const active = await mintCookie("u-1", "user@example.com", "active");
    const auth = authFromEnv(ENV, ENV.BETTER_AUTH_URL ?? "");

    const minted = await auth.handler(
      new Request(`${ENV.BETTER_AUTH_URL ?? ""}/api/auth/api-key/create`, {
        body: JSON.stringify({ name: "ci-key" }),
        headers: { "content-type": "application/json", cookie: active },
        method: "POST",
      })
    );

    expect(minted.status).toBeLessThan(300);
  });
});
