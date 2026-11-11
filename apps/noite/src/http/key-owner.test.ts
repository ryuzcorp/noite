/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { authFromEnv } from "../lib/auth";
import { ensureDb, setD1Binding } from "../lib/db";
import { resetPlatformLimits } from "../lib/rate-limit";
import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { installRunnerMock, makeApp } from "../testing/runner-mock";
import type { RunnerMock } from "../testing/runner-mock";
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
interface TestKeyMetadata {
  appIds?: string[] | null;
  roleCeiling?: "view" | "push" | "admin";
}

const mintKey = async (
  userId: string,
  metadata?: TestKeyMetadata
): Promise<string> => {
  db.raw.run(
    `INSERT OR IGNORE INTO "user" (id, name, email) VALUES (?, ?, ?)`,
    [userId, userId, `${userId}@example.com`]
  );

  const created = await authFromEnv(
    ENV as unknown as KitEnv,
    ENV.BETTER_AUTH_URL
  ).api.createApiKey({
    body: {
      metadata,
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

const gitAuth = async (
  key: string,
  slug = "demo",
  need = "push"
): Promise<Response | undefined> =>
  await handleGitAuth(
    new Request("http://localhost:9080/internal/git-auth", {
      body: JSON.stringify({ key, need, slug }),
      headers: { ...RUNNER_HEADERS, "content-type": "application/json" },
      method: "POST",
    }),
    ENV as unknown as KitEnv
  );

const ingest = (key: string, appId = "demo"): Promise<Response> =>
  forwardIngest(
    new Request(`http://localhost:9080/api/apps/${appId}/ingest/events`, {
      body: JSON.stringify({ event: "test", project: appId }),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      method: "POST",
    }),
    ENV as unknown as KitEnv,
    { appId, kind: "events" }
  ) as Promise<Response>;

/** A real better-auth session cookie for an existing account, through the
 * same OTP flow the login panel uses (localhost delivery goes to the
 * console). */
const signInCookie = async (email: string): Promise<string> => {
  const lines: unknown[][] = [];

  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args);
  });

  const auth = authFromEnv(ENV as unknown as KitEnv, ENV.BETTER_AUTH_URL);

  try {
    await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
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

  const signedIn = await auth.handler(
    new Request(`${ENV.BETTER_AUTH_URL}/api/auth/sign-in/email-otp`, {
      body: JSON.stringify({ email, otp }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  const cookie = signedIn.headers
    .getSetCookie()
    .find((entry) => entry.startsWith("better-auth.session_token="));

  if (!cookie) {
    throw new Error(
      `better-auth signed in with no session cookie (status ${signedIn.status}: ${await signedIn.text()})`
    );
  }

  return cookie.split(";")[0] ?? "";
};

/** A real better-auth session for an admin account. */
const adminHeaders = async (): Promise<Headers> => {
  db.raw.run(
    `INSERT INTO "user" (id, name, email, emailVerified, role) VALUES ('admin-1', 'Admin', 'admin@example.com', 1, 'admin')`
  );

  return new Headers({ cookie: await signInCookie("admin@example.com") });
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

    // A create that raced the ban can insert a key after the ban's deletion:
    // the unban sweep removes it, so it cannot become a surviving backdoor.
    const raced = await auth.api.createApiKey({
      body: {
        name: "raced",
        permissions: { apps: ["manage"] },
        userId: "ban-target",
      },
    });

    expect(raced?.key).toBeString();
    expect(keyCount("ban-target")).toBe(1);

    await auth.api.unbanUser({ body: { userId: "ban-target" }, headers });

    // Revoked stays revoked: an unban never resurrects a machine credential.
    expect(keyCount("ban-target")).toBe(0);

    const unbanedVerify = await auth.api.verifyApiKey({ body: { key } });
    expect(unbanedVerify.valid).toBe(false);

    // `/admin/update-user` with `banned: false` is the other unban path; its
    // sweep must run too, or a raced key survives there instead.
    await mintKey("update-target");
    await auth.api.banUser({ body: { userId: "update-target" }, headers });
    expect(keyCount("update-target")).toBe(0);

    const racedUpdate = await auth.api.createApiKey({
      body: {
        name: "raced-update",
        permissions: { apps: ["manage"] },
        userId: "update-target",
      },
    });

    expect(racedUpdate?.key).toBeString();
    expect(keyCount("update-target")).toBe(1);

    await auth.api.adminUpdateUser({
      body: { data: { banned: false }, userId: "update-target" },
      headers,
    });

    expect(keyCount("update-target")).toBe(0);
  });

  test("refuses /api-key/create while the owner is banned", async () => {
    db.raw.run(
      `INSERT INTO "user" (id, name, email, emailVerified) VALUES ('survivor', 'Survivor', 'survivor@example.com', 1)`
    );

    const cookie = await signInCookie("survivor@example.com");

    // A session that survived the ban (the crash window finding 1 closes in
    // the normal flow) must not be able to mint a credential.
    db.raw.run(`UPDATE "user" SET banned = 1 WHERE id = 'survivor'`);

    const response = await authFromEnv(
      ENV as unknown as KitEnv,
      ENV.BETTER_AUTH_URL
    ).handler(
      new Request(`${ENV.BETTER_AUTH_URL}/api/auth/api-key/create`, {
        body: JSON.stringify({ name: "sneaky" }),
        headers: { "content-type": "application/json", cookie },
        method: "POST",
      })
    );

    expect(response.status).toBe(403);
    expect(keyCount("survivor")).toBe(0);
  });

  test("a failed or unauthorized unban does not delete an account's keys", async () => {
    const key = await mintKey("dos-target");
    const auth = authFromEnv(ENV as unknown as KitEnv, ENV.BETTER_AUTH_URL);

    const unbanRequest = (headers: Record<string, string>) =>
      new Request(`${ENV.BETTER_AUTH_URL}/api/auth/admin/unban-user`, {
        body: JSON.stringify({ userId: "dos-target" }),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
      });

    // Better-auth runs after hooks even when the endpoint refuses, so the
    // sweep must be gated on the success payload: an anonymous caller cannot
    // use a failed unban to delete someone else's keys.
    const anonymous = await auth.handler(unbanRequest({}));

    expect(anonymous.status).toBe(401);
    expect(keyCount("dos-target")).toBe(1);

    db.raw.run(
      `INSERT INTO "user" (id, name, email, emailVerified) VALUES ('plain-1', 'Plain', 'plain@example.com', 1)`
    );

    const cookie = await signInCookie("plain@example.com");
    const forbidden = await auth.handler(unbanRequest({ cookie }));

    expect(forbidden.status).toBe(403);
    expect(keyCount("dos-target")).toBe(1);
    expect(key.length).toBeGreaterThan(0);
  });
});

describe("a scoped key on git and ingest", () => {
  const OWN = makeApp({ id: "app-1", slug: "app-one", userId: "u-owner" });

  const OTHER = makeApp({
    id: "app-2",
    name: "Two",
    slug: "two",
    userId: "u-other",
  });

  let runner: RunnerMock;

  beforeEach(() => {
    runner = installRunnerMock([OWN, OTHER]);
    db.raw.run(
      `INSERT OR IGNORE INTO "user" (id, name, email) VALUES ('u-scoped', 'u-scoped', 'u-scoped@example.com')`
    );
    db.raw.run(
      `INSERT INTO app_collaborator (id, appId, userId, role) VALUES ('c1', 'app-1', 'u-scoped', 'push'), ('c2', 'app-2', 'u-scoped', 'push')`
    );
  });

  afterEach(() => {
    runner.restore();
  });

  test("git-auth allows its own app and refuses another", async () => {
    const key = await mintKey("u-scoped", { appIds: ["app-1"] });

    const own = await gitAuth(key, "app-one");
    expect(own?.status).toBe(200);

    const ownBody: unknown = await own?.json();
    expect(ownBody).toMatchObject({ appId: "app-1", ok: true, role: "push" });

    // By the other app's slug and by its id: the set check runs on the
    // resolved app id, so neither spelling reaches it.
    const bySlug = await gitAuth(key, "two");
    expect(bySlug?.status).toBe(403);

    const byId = await gitAuth(key, "app-2", "view");
    expect(byId?.status).toBe(403);
  });

  test("ingest allows its own app and refuses another", async () => {
    const key = await mintKey("u-scoped", { appIds: ["app-1"] });

    const response = await ingest(key, "app-2");
    expect(response.status).toBe(403);
  });

  test("git's answer carries the key's role ceiling, not the owner's role", async () => {
    // The owner is a full admin; a push-only agent key must still be answered
    // as `push`, because the runner's force-push and delete policy reads it.
    db.raw.run(`UPDATE "user" SET role = 'admin' WHERE id = 'u-scoped'`);
    db.raw.run(
      `UPDATE app_collaborator SET role = 'admin' WHERE userId = 'u-scoped'`
    );

    const key = await mintKey("u-scoped", {
      appIds: null,
      roleCeiling: "push",
    });

    const response = await gitAuth(key, "app-one", "push");
    expect(response?.status).toBe(200);

    const body: unknown = await response?.json();
    expect(body).toMatchObject({ ok: true, role: "push" });

    // An admin-only need on the same app is refused, not silently widened.
    const adminNeed = await gitAuth(key, "app-one", "admin");
    expect(adminNeed?.status).toBe(403);
  });

  test("an expired key is refused on git and ingest with its own reason", async () => {
    // One key per surface: the plugin deletes an expired key when it refuses
    // it, so a second attempt with the same key is simply unknown.
    const gitKey = await mintKey("u-scoped");
    const ingestKey = await mintKey("u-scoped");
    db.raw.run(
      `UPDATE apikey SET expiresAt = ? WHERE referenceId = 'u-scoped'`,
      [new Date("2020-01-01T00:00:00Z").toISOString()]
    );

    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      const git = await gitAuth(gitKey, "app-one");
      expect(git?.status).toBe(401);

      const body: unknown = await git?.json();
      expect(body).toEqual({ error: "API key expired", ok: false });

      const events = await ingest(ingestKey, "app-1");
      expect(events.status).toBe(401);
      expect(await events.text()).toBe("API key expired");
    } finally {
      logged.mockRestore();
    }
  });

  test("an app-scoped key cannot claim a new app through a push", async () => {
    const key = await mintKey("u-scoped", { appIds: ["app-1"] });

    const response = await gitAuth(key, "brand-new", "create");

    expect(response?.status).toBe(403);

    const body: unknown = await response?.json();
    expect(body).toEqual({
      error: "This API key is limited to specific apps",
      ok: false,
    });
  });
});
