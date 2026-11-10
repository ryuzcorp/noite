/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { authFromEnv } from "../lib/auth";
import { ensureDb, setD1Binding } from "../lib/db";
import { resetPlatformLimits } from "../lib/rate-limit";
import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { forwardIngest } from "./routes/ingest";
import { handleGitAuth } from "./routes/internal";

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "key-owner-test-secret-0123456789ab",
  BETTER_AUTH_URL: "http://localhost:9080",
  RUNNER_TOKEN: "runner-secret",
};

const RUNNER_HEADERS = { authorization: "Bearer runner-secret" };

let db: TestD1;

beforeEach(async () => {
  resetPlatformLimits();
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

/** An account plus a scoped key, minted through better-auth exactly as the
 * account page's create action does. */
const mintKey = async (userId: string): Promise<string> => {
  db.raw.run(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`, [
    userId,
    userId,
    `${userId}@example.com`,
  ]);

  const created = await authFromEnv(
    ENV as unknown as KitEnv,
    ENV.BETTER_AUTH_URL
  ).api.createApiKey({
    body: {
      name: "key-owner-test",
      permissions: { apps: ["manage"], events: ["push"] },
      userId,
    },
  });

  const key = created?.key;

  if (!key) {
    throw new Error("better-auth minted no API key");
  }

  return key;
};

const gitAuth = async (key: string): Promise<Response | undefined> =>
  await handleGitAuth(
    new Request("http://localhost:9080/internal/git-auth", {
      body: JSON.stringify({ key, need: "push", slug: "demo" }),
      headers: { ...RUNNER_HEADERS, "content-type": "application/json" },
      method: "POST",
    }),
    ENV as unknown as KitEnv
  );

const ingest = (key: string): Promise<Response> =>
  forwardIngest(
    new Request("http://localhost:9080/api/apps/demo/ingest/events", {
      body: JSON.stringify({ event: "test", project: "demo" }),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      method: "POST",
    }),
    ENV as unknown as KitEnv,
    { appId: "demo", kind: "events" }
  ) as Promise<Response>;

/** A real better-auth session for an admin account, through the same OTP flow
 * the login panel uses (localhost delivery goes to the console). */
const adminHeaders = async (): Promise<Headers> => {
  db.raw.run(
    `INSERT INTO "user" (id, name, email, emailVerified, role) VALUES ('admin-1', 'Admin', 'admin@example.com', 1, 'admin')`
  );

  const lines: unknown[][] = [];

  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args);
  });

  const auth = authFromEnv(ENV as unknown as KitEnv, ENV.BETTER_AUTH_URL);

  try {
    await auth.api.sendVerificationOTP({
      body: { email: "admin@example.com", type: "sign-in" },
    });
  } finally {
    log.mockRestore();
  }

  const line = lines
    .map((args) => String(args[0] ?? ""))
    .find((text) => text.includes("sign-in code for admin@example.com:"));

  const otp = line?.split(":").at(-1)?.trim();

  if (!otp) {
    throw new Error("better-auth delivered no OTP code");
  }

  const signedIn = await auth.handler(
    new Request(`${ENV.BETTER_AUTH_URL}/api/auth/sign-in/email-otp`, {
      body: JSON.stringify({ email: "admin@example.com", otp }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  const cookie = signedIn.headers
    .getSetCookie()
    .find((entry) => entry.startsWith("better-auth.session_token="));

  if (!cookie) {
    throw new Error("better-auth signed in with no session cookie");
  }

  return new Headers({ cookie: cookie.split(";")[0] ?? "" });
};

const keyCount = (userId: string): number => {
  // SAFETY: a COUNT query always yields one { n } row.
  const row = db.raw
    .query(`SELECT count(*) AS n FROM apikey WHERE referenceId = ?`)
    .get(userId) as { n: number };

  return row.n;
};

describe("a banned owner's API key", () => {
  test("is refused on git-auth before any app lookup", async () => {
    const key = await mintKey("banned-git");
    db.raw.run(`UPDATE "user" SET banned = 1 WHERE id = 'banned-git'`);

    const response = await gitAuth(key);

    // 401 with the key-refusal body: the ban is decided before the
    // collaborator gate (which would answer 403 without a runner).
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: "invalid key", ok: false });
  });

  test("is refused on ingest before the app role gate", async () => {
    const key = await mintKey("banned-ingest");
    db.raw.run(`UPDATE "user" SET banned = 1 WHERE id = 'banned-ingest'`);

    const response = await ingest(key);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("invalid key");
  });

  test("an active owner's key passes the ban check", async () => {
    const key = await mintKey("active-owner");

    // No collaborator grant and no runner in this test: the request fails
    // the *role* gate (403), proving the owner check let it through.
    const git = await gitAuth(key);
    expect(git?.status).toBe(403);

    const ingestResponse = await ingest(key);
    expect(ingestResponse.status).toBe(403);
  });

  test("a key with no user row is refused", async () => {
    // Minted first, then its account row disappears: verifyApiKey still
    // resolves the reference, so the owner read is the only guard.
    const key = await mintKey("vanished-owner");
    db.raw.run(`DELETE FROM "user" WHERE id = 'vanished-owner'`);

    const response = await gitAuth(key);

    expect(response?.status).toBe(401);
  });
});

describe("the ban endpoint", () => {
  test("deletes the account's keys, and an unban does not restore them", async () => {
    const key = await mintKey("ban-target");
    const headers = await adminHeaders();
    const auth = authFromEnv(ENV as unknown as KitEnv, ENV.BETTER_AUTH_URL);

    expect(keyCount("ban-target")).toBe(1);

    await auth.api.banUser({ body: { userId: "ban-target" }, headers });

    expect(keyCount("ban-target")).toBe(0);

    const bannedVerify = await auth.api.verifyApiKey({ body: { key } });
    expect(bannedVerify.valid).toBe(false);

    await auth.api.unbanUser({ body: { userId: "ban-target" }, headers });

    // Revoked stays revoked: an unban never resurrects a machine credential.
    expect(keyCount("ban-target")).toBe(0);

    const unbanedVerify = await auth.api.verifyApiKey({ body: { key } });
    expect(unbanedVerify.valid).toBe(false);
  });
});
