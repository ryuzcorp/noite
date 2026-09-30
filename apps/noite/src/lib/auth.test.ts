import { beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { createAuth } from "./auth";
import { ensureDbPromise, setD1Binding } from "./db";

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
  await ensureDbPromise();
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
});
