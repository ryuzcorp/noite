/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, no-console -- test doubles: a minimal KitEnv stands in for the Worker env; row reads mirror the better-auth tables; the OTP travels through the test's own console, never a real inbox */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createTestD1, gateD1 } from "../../testing/d1";
import type { TestD1 } from "../../testing/d1";
import { authFromEnv } from "../auth";
import { ensureDbPromise, setD1Binding } from "../db";
import { getSessionOrNull } from "./session.server";

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "session-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:9080",
};

let db: TestD1;

beforeEach(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDbPromise();
});

/** A real better-auth session cookie: the OTP flow mints it exactly as the
 * login panel does (console delivery on localhost), so the read below
 * exercises the production D1 round trip, not a double. The code travels
 * through this test's own console spy — the delivery channel the product
 * itself uses on localhost. */
const mintSessionCookie = async (email: string): Promise<string> => {
  db.raw.run(
    `INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, ?)`,
    [`user-${email}`, email, email, 1]
  );

  const lines: unknown[][] = [];

  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args);
  });

  try {
    const auth = authFromEnv(ENV as unknown as KitEnv, ENV.BETTER_AUTH_URL);
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
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
      headers: { "content-type": "application/json" },
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

const authedRequest = (cookie: string): Request =>
  new Request(`${ENV.BETTER_AUTH_URL}/api/apps/get`, {
    headers: { cookie },
    method: "POST",
  });

describe("getSessionOrNull", () => {
  test("a wedged session store fails fast instead of riding to the route timeout", async () => {
    const cookie = await mintSessionCookie("wedged@example.com");

    // A store that never answers: models the celld-D1 stall behind flake
    // H's 15.01 s pair. Assigned in place (not rebound) so the binding keeps
    // its identity: the setup pass settled before the stall, exactly like a
    // mid-lane wedge on a warm isolate. Methods are snapshotted first — the
    // gate closes over the snapshot, or the wrapper recurses into itself.
    // The bound (not a sleep) is the signal under test.
    // oxlint-disable-next-line promise/avoid-new -- the test never releases the gate: a pending D1 models the wedged store
    const gate = new Promise<void>(() => {});
    const inner = { ...db.d1 };
    Object.assign(db.d1, gateD1(inner as typeof db.d1, { gate }));

    await expect(
      getSessionOrNull(authedRequest(cookie), ENV as unknown as KitEnv, {
        timeoutMs: 20,
      })
    ).rejects.toThrow(/did not answer/u);
  });

  test("a healthy store still resolves the session", async () => {
    const cookie = await mintSessionCookie("healthy@example.com");

    const session = await getSessionOrNull(
      authedRequest(cookie),
      ENV as unknown as KitEnv
    );

    expect(session?.user.email).toBe("healthy@example.com");
  });

  test("a missing session is still null, not a throw", async () => {
    const session = await getSessionOrNull(
      authedRequest("better-auth.session_token=absent"),
      ENV as unknown as KitEnv
    );

    expect(session).toBeNull();
  });
});
