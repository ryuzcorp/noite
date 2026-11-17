/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env; row reads mirror the better-auth tables */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { TypedHandler } from "void";

import { testRouteContext } from "../../testing/context";
import { createTestD1 } from "../../testing/d1";
import type { TestD1 } from "../../testing/d1";
import { installRunnerMock, makeApp } from "../../testing/runner-mock";
import type { RunnerMock } from "../../testing/runner-mock";
import { authFromEnv } from "../auth";
import { controlEnv } from "../control-env";
import { ensureDb, setD1Binding } from "../db";
import { registrationStatus } from "./account.server";
import {
  adminCreateEmailInvite,
  adminDeleteApp,
  adminListEmailInvites,
  approveUser,
  ensureAdminAccount,
  getWaitlist,
  rejectUser,
  setUserRole,
  setWaitlist,
} from "./admin.server";

let db: TestD1;

beforeEach(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
  db.executed.length = 0;
});

describe("ensureAdminAccount", () => {
  test("an admin needs no promotion round-trip", async () => {
    db.raw.run(
      `INSERT INTO "user" (id, name, email, role) VALUES (?, ?, ?, ?)`,
      ["admin-1", "Admin", "admin@example.com", "admin"]
    );
    db.executed.length = 0;

    await ensureAdminAccount("admin@example.com", "admin");

    // The session role is read fresh on every request, so a session that
    // already carries `admin` skips the SELECT: one fewer sequential D1
    // query on every admin action.
    expect(db.executed).toHaveLength(0);
  });

  test("a non-admin anchored address is still promoted", async () => {
    db.raw.run(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`, [
      "user-1",
      "User",
      "anchored@example.com",
    ]);
    db.executed.length = 0;

    await ensureAdminAccount("anchored@example.com", "user");

    // SAFETY: the projection is the single `role` column selected above.
    const rows = db.raw
      .query(`SELECT role FROM "user" WHERE email = ?`)
      .all("anchored@example.com") as { role: string }[];

    expect(rows).toEqual([{ role: "admin" }]);
    expect(db.executed.length).toBeGreaterThan(0);
  });
});

/** Drive a JSON-action handler with a JSON body and an optional session
 * cookie. Real better-auth sessions (minted below through the OTP flow)
 * exercise the production gates, not doubles. */
const authedPost = async (
  handler: TypedHandler,
  path: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the helper forwards whatever JSON body the case needs; the endpoint decodes it through its schema.
  body: unknown,
  cookie?: string
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });

  if (cookie) {
    headers.set("cookie", cookie);
  }

  const request = new Request(`http://localhost:9080${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method: "POST",
  });

  const raw = await handler(testRouteContext(request, ENV));

  if (raw instanceof Response) {
    return raw;
  }

  throw new Error("the handler did not answer a Response");
};

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "admin-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:9080",
} as unknown as KitEnv;

/** A real better-auth session cookie for a row this test inserts. The OTP
 * flow mints it exactly as the login panel does (console delivery on
 * localhost), so the actions below read a production session. */
let mintCount = 0;

const mintCookie = async (
  id: string,
  email: string,
  role: string,
  status = "active"
): Promise<string> => {
  // better-auth budgets OTP sends/sign-ins per client IP (a shared bucket
  // when the address is unknown): one address per mint keeps the file's
  // mints from throttling each other.
  mintCount += 1;
  const ip = `10.200.0.${mintCount}`;
  const headers = { "x-forwarded-for": ip };
  db.raw.run(
    `INSERT INTO "user" (id, name, email, role, emailVerified, status) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, id, email, role, 1, status]
  );

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

describe("waitlist moderation", () => {
  test("approve flips pending to active; a second approval finds nothing waiting", async () => {
    const admin = await mintCookie("admin-1", "admin@example.com", "admin");
    await mintCookie("w-1", "waiting@example.com", "user", "pending");

    const first = await authedPost(
      approveUser,
      "/api/admin/approveUser",
      "w-1",
      admin
    );

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    // SAFETY: the approval above flipped exactly this row.
    const status = db.raw
      .query(`SELECT status FROM "user" WHERE id = 'w-1'`)
      .get() as { status: string };

    expect(status).toEqual({ status: "active" });

    const second = await authedPost(
      approveUser,
      "/api/admin/approveUser",
      "w-1",
      admin
    );

    expect(second.status).toBe(422);
  });

  test("approve and reject refuse the admin's own account and strangers", async () => {
    const admin = await mintCookie("admin-1", "admin@example.com", "admin");
    const plain = await mintCookie("u-1", "user@example.com", "user");
    await mintCookie("w-1", "waiting@example.com", "user", "pending");

    const self = await authedPost(
      approveUser,
      "/api/admin/approveUser",
      "admin-1",
      admin
    );

    expect(self.status).toBe(422);

    const stranger = await authedPost(
      rejectUser,
      "/api/admin/rejectUser",
      "w-1",
      plain
    );

    expect(stranger.status).toBe(422);

    // No session is still "Admin only" (a 422 fail), never a 401: the probe
    // resolves instead of throwing.
    const signedOut = await authedPost(
      rejectUser,
      "/api/admin/rejectUser",
      "w-1"
    );

    expect(signedOut.status).toBe(422);
  });

  test("reject deletes the waiting account, its sessions and its keys", async () => {
    const admin = await mintCookie("admin-1", "admin@example.com", "admin");

    const waiting = await mintCookie(
      "w-1",
      "waiting@example.com",
      "user",
      "pending"
    );

    const rejected = await authedPost(
      rejectUser,
      "/api/admin/rejectUser",
      "w-1",
      admin
    );

    expect(rejected.status).toBe(200);

    // SAFETY: count(*) always returns exactly one `{ n }` row.
    const count = db.raw
      .query(`SELECT count(*) AS n FROM "user" WHERE id = 'w-1'`)
      .get() as {
      n: number;
    };

    expect(count).toEqual({ n: 0 });

    // The rejected session is gone with the account.
    expect(
      db.raw
        .query(`SELECT count(*) AS n FROM session WHERE userId = 'w-1'`)
        .get()
    ).toEqual({ n: 0 });
    expect(waiting.length).toBeGreaterThan(0);
  });

  test("reject and role changes refuse accounts that are not waiting", async () => {
    const admin = await mintCookie("admin-1", "admin@example.com", "admin");
    await mintCookie("u-1", "user@example.com", "user");

    const rejectActive = await authedPost(
      rejectUser,
      "/api/admin/rejectUser",
      "u-1",
      admin
    );

    expect(rejectActive.status).toBe(422);

    await mintCookie("w-1", "waiting@example.com", "user", "pending");

    const promotePending = await authedPost(
      setUserRole,
      "/api/admin/setUserRole",
      { role: "admin", userId: "w-1" },
      admin
    );

    expect(promotePending.status).toBe(422);
  });

  test("a pending account never administers, even at the anchored address", async () => {
    controlEnv.NOITE_ADMIN_EMAIL = "boss@example.com";

    try {
      const waiting = await mintCookie(
        "boss-1",
        "boss@example.com",
        "user",
        "pending"
      );

      const denied = await authedPost(
        getWaitlist,
        "/api/admin/getWaitlist",
        {},
        waiting
      );

      expect(denied.status).toBe(422);

      // The anchor promotion must not fire either: the row keeps its role,
      // so approving it later cannot mint an admin.
      const rows = db.raw
        .query(`SELECT role, status FROM "user" WHERE email = ?`)
        .all("boss@example.com") as { role: string; status: string }[];

      expect(rows).toEqual([{ role: "user", status: "pending" }]);
    } finally {
      delete controlEnv.NOITE_ADMIN_EMAIL;
    }
  });

  test("the waitlist switch round-trips for admins and refuses everyone else", async () => {
    const admin = await mintCookie("admin-1", "admin@example.com", "admin");
    const plain = await mintCookie("u-1", "user@example.com", "user");

    const before = await authedPost(
      getWaitlist,
      "/api/admin/getWaitlist",
      {},
      admin
    );

    expect(await before.json()).toEqual({ enabled: false });

    const saved = await authedPost(
      setWaitlist,
      "/api/admin/setWaitlist",
      { enabled: true },
      admin
    );

    expect(await saved.json()).toEqual({ enabled: true });

    const denied = await authedPost(
      getWaitlist,
      "/api/admin/getWaitlist",
      {},
      plain
    );

    expect(denied.status).toBe(422);
  });

  test("email invites are admin-only and return the one-time link", async () => {
    const admin = await mintCookie("admin-1", "admin@example.com", "admin");
    const plain = await mintCookie("u-1", "user@example.com", "user");

    const created = await authedPost(
      adminCreateEmailInvite,
      "/api/admin/adminCreateEmailInvite",
      { email: "Friend@Example.com" },
      admin
    );

    expect(created.status).toBe(200);

    // SAFETY: the create endpoint answers this exact shape; the link format is asserted below.
    const body = (await created.json()) as {
      emailed: boolean;
      id: string;
      link: string;
    };

    expect(body.link).toMatch(/\/login\?invite=[A-Za-z0-9_-]{22}$/u);

    const listed = await authedPost(
      adminListEmailInvites,
      "/api/admin/adminListEmailInvites",
      {},
      admin
    );

    expect(await listed.json()).toEqual([
      expect.objectContaining({
        email: "friend@example.com",
        state: "available",
      }),
    ]);

    const refused = await authedPost(
      adminCreateEmailInvite,
      "/api/admin/adminCreateEmailInvite",
      { email: "friend@example.com" },
      plain
    );

    expect(refused.status).toBe(422);
  });

  test("registrationStatus answers pending, active, and signed-out", async () => {
    const waiting = await mintCookie(
      "w-1",
      "waiting@example.com",
      "user",
      "pending"
    );

    const active = await mintCookie("u-1", "user@example.com", "user");

    const pending = await authedPost(
      registrationStatus,
      "/api/account/registrationStatus",
      {},
      waiting
    );

    expect(await pending.json()).toEqual({ status: "pending" });

    const admitted = await authedPost(
      registrationStatus,
      "/api/account/registrationStatus",
      {},
      active
    );

    expect(await admitted.json()).toEqual({ status: "active" });

    const signedOut = await authedPost(
      registrationStatus,
      "/api/account/registrationStatus",
      {}
    );

    expect(signedOut.status).toBe(401);
  });
});

/** One grant plus one pending invitation for the app under test. */
const seedGrants = (appId: string, userId: string): void => {
  db.raw.run(
    `INSERT INTO app_collaborator (id, appId, userId, role) VALUES (?, ?, ?, ?)`,
    [`grant-${appId}`, appId, userId, "admin"]
  );
  db.raw.run(
    `INSERT INTO collaborator_invite (id, appId, appName, email, invitedBy, role) VALUES (?, ?, ?, ?, ?, ?)`,
    [`invite-${appId}`, appId, "Gone", "gone@example.com", userId, "view"]
  );
};

/** Grants plus invitations still held for the app. */
const grantsLeft = (appId: string): number => {
  // SAFETY: the seed above holds exactly these rows; the counts below drop to zero with them.
  const rows = db.raw
    .query(`SELECT id FROM app_collaborator WHERE appId = ?`)
    .all(appId) as unknown[];

  const invites = db.raw
    .query(`SELECT id FROM collaborator_invite WHERE appId = ?`)
    .all(appId) as unknown[];

  return rows.length + invites.length;
};

describe("adminDeleteApp", () => {
  let runner: RunnerMock | undefined;

  afterEach(() => {
    runner?.restore();
    runner = undefined;
  });

  test("a runner 404 still drops the grants and answers ok", async () => {
    const cookie = await mintCookie("admin-1", "admin@example.com", "admin");
    seedGrants("app-gone", "admin-1");
    // The app is already gone runner-side: DELETE answers 404.
    runner = installRunnerMock([]);

    const result = await authedPost(
      adminDeleteApp,
      "/api/admin/adminDeleteApp",
      "app-gone",
      cookie
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(runner.calls).toEqual(["DELETE /v1/apps/app-gone"]);
    expect(grantsLeft("app-gone")).toBe(0);
  });

  test("a present app deletes and drops its grants", async () => {
    const cookie = await mintCookie("admin-1", "admin@example.com", "admin");
    seedGrants("app-there", "admin-1");
    runner = installRunnerMock([makeApp({ id: "app-there", slug: "there" })]);

    const result = await authedPost(
      adminDeleteApp,
      "/api/admin/adminDeleteApp",
      "app-there",
      cookie
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(runner.calls).toEqual(["DELETE /v1/apps/app-there"]);
    expect(grantsLeft("app-there")).toBe(0);
  });
});
