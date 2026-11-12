import { beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { handleAuth } from "../http/routes/auth";
import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { createAuth } from "./auth";
import { ensureDb, setD1Binding } from "./db";

let db: TestD1;

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
  BETTER_AUTH_URL: "http://localhost:8090",
} as const;

const auth = () => createAuth(ENV, ENV.BETTER_AUTH_URL);

beforeAll(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

beforeEach(() => {
  db.raw.run(`DELETE FROM verification`);
  db.raw.run(`DELETE FROM session`);
  db.raw.run(`DELETE FROM account`);
  db.raw.run(`DELETE FROM "user"`);
});

/** Send a sign-in code and read it back from the dev delivery channel
 * (localhost prints it instead of calling the email webhook). */
const requestCode = async (email: string): Promise<string> => {
  const log = spyOn(console, "log").mockImplementation(() => {});

  try {
    await auth().api.sendVerificationOTP({ body: { email, type: "sign-in" } });

    const line = log.mock.calls
      .map((args) => String(args[0]))
      .find((text) => text.includes("[noite:otp]"));

    return /: (?<code>\d{6})$/u.exec(line ?? "")?.groups?.code ?? "";
  } finally {
    log.mockRestore();
  }
};

// SAFETY: a COUNT query always yields one { n } row.
const userCount = (email: string): number =>
  (
    db.raw
      .query(`SELECT count(*) AS n FROM "user" WHERE email = ?`)
      .get(email) as { n: number }
  ).n;

describe("email-code sign-in", () => {
  test("an unknown address cannot mint an account (the invite gate stays shut)", async () => {
    const code = await requestCode("newcomer@example.com");
    let signedIn = false;

    try {
      await auth().api.signInEmailOTP({
        body: { email: "newcomer@example.com", otp: code || "000000" },
      });
      signedIn = true;
    } catch {
      signedIn = false;
    }

    expect(signedIn).toBe(false);
    expect(userCount("newcomer@example.com")).toBe(0);
  });

  test("an existing account still signs in with its emailed code", async () => {
    db.raw.run(
      `INSERT INTO "user" (id, name, email, emailVerified) VALUES ('u1', 'Known', 'known@example.com', 1)`
    );
    const code = await requestCode("known@example.com");
    expect(code).toMatch(/^\d{6}$/u);

    const result = await auth().api.signInEmailOTP({
      body: { email: "known@example.com", otp: code },
    });

    expect(result.user.email).toBe("known@example.com");
    expect(userCount("known@example.com")).toBe(1);
  });

  test("a session user carries the server-set onboardedAt field", async () => {
    // A value written only where completeOnboarding writes it.
    db.raw.run(
      `INSERT INTO "user" (id, name, email, emailVerified, onboardedAt) VALUES ('u2', 'Done', 'done@example.com', 1, '2026-01-02T03:04:05.000Z')`
    );
    const code = await requestCode("done@example.com");

    const result = await auth().api.signInEmailOTP({
      body: { email: "done@example.com", otp: code },
    });

    // SAFETY: the field is an additional-field addition to the user output; the generated type may not surface it.
    const { onboardedAt } = result.user as { onboardedAt?: unknown };
    // The `type: "date"` field is parsed into a Date server-side (and
    // serialized as an ISO string over HTTP).
    expect(onboardedAt).toBeInstanceOf(Date);
  });

  test("a fresh session user has a null onboardedAt", async () => {
    db.raw.run(
      `INSERT INTO "user" (id, name, email, emailVerified) VALUES ('u3', 'New', 'new@example.com', 1)`
    );
    const code = await requestCode("new@example.com");

    const result = await auth().api.signInEmailOTP({
      body: { email: "new@example.com", otp: code },
    });

    // SAFETY: same additional-field probe as above.
    const { onboardedAt } = result.user as { onboardedAt?: unknown };
    expect(onboardedAt ?? null).toBeNull();
  });
});

describe("dev-only shortcuts key on the localhost family", () => {
  test("a *.localhost base still delivers the code on the console", async () => {
    db.raw.run(
      `INSERT INTO "user" (id, name, email, emailVerified) VALUES ('u4', 'Dev', 'dev@example.com', 1)`
    );
    const env = { ...ENV, BASE_DOMAIN: "noite.localhost" };
    const log = spyOn(console, "log").mockImplementation(() => {});

    try {
      await createAuth(env, env.BETTER_AUTH_URL).api.sendVerificationOTP({
        body: { email: "dev@example.com", type: "sign-in" },
      });

      const printed = log.mock.calls
        .map((args) => String(args[0]))
        .some((text) => text.includes("[noite:otp]"));

      expect(printed).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

type D1Binding = Parameters<typeof setD1Binding>[0];

type Prepared = ReturnType<D1Binding["prepare"]>;

/** A D1 binding whose every statement rejects: how a driver failure reaches
 * better-auth, which drizzle wraps with the statement and its parameters. */
const failingD1 = (failure: Error): D1Binding => {
  // SAFETY: every member mirrors the wrapped statement's surface; each one
  // rejects with the driver failure the test wants better-auth to see.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for a platform binding (same pattern as testing/d1.ts).
  const statement = {
    all: () => Promise.reject(failure),
    bind: () => statement,
    first: () => Promise.reject(failure),
    raw: () => Promise.reject(failure),
    run: () => Promise.reject(failure),
  } as unknown as Prepared;

  // SAFETY: every member is the real binding's own; only prepare, batch and
  // the session wrapper are replaced so every statement fails.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for a platform binding (same pattern as testing/d1.ts).
  const wrapped = {
    ...db.d1,
    batch: () => Promise.reject(failure),
    prepare: () => statement,
    withSession: () => wrapped,
  } as unknown as D1Binding;

  return wrapped;
};

describe("a failing auth database write never logs its SQL or parameters", () => {
  test("the endpoint's failure is logged through the cause chain only", async () => {
    const failure = new Error("D1_ERROR: unavailable");
    setD1Binding(failingD1(failure));
    const logged: string[] = [];

    const error = spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args.map(String).join(" "));
    });

    let status = 0;

    try {
      // better-auth rethrows a non-API failure (`onAPIError.throw`) so
      // better-call's raw `# SERVER_ERROR` log never runs; `handleAuth` logs
      // the cause chain and answers a generic 500.
      const response = await handleAuth(
        new Request(
          `${ENV.BETTER_AUTH_URL}/api/auth/email-otp/send-verification-otp`,
          {
            body: JSON.stringify({ email: "a@example.com", type: "sign-in" }),
            headers: {
              "content-type": "application/json",
              origin: ENV.BETTER_AUTH_URL,
            },
            method: "POST",
          }
        ),
        // SAFETY: the test env carries the auth keys this path reads.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test env stands in for the platform binding.
        ENV as unknown as KitEnv
      );

      if (!response) {
        throw new Error("handleAuth answered no response");
      }

      ({ status } = response);
    } finally {
      error.mockRestore();
      setD1Binding(db.d1);
    }

    expect(status).toBe(500);

    const text = logged.join("\n");

    expect(text).toContain("[auth]");
    expect(text).toContain("query failed");
    expect(text).toContain("D1_ERROR: unavailable");

    // The statement, its table and every bound value stay out of the log: the
    // verification row binds the one-time code.
    for (const leak of ["Failed query", "params:", "insert into"]) {
      expect(text).not.toContain(leak);
    }
  });
});
