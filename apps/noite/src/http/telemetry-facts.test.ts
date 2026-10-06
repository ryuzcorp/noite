/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { beforeEach, describe, expect, test } from "bun:test";

import { ensureDbPromise, setD1Binding } from "../lib/db";
import { resetRateLimits } from "../lib/rate-limit";
import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { handleHttp } from "./router";

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "telemetry-facts-test-secret-0123456789",
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

const addUser = (id: string) => {
  db.raw.run(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`, [
    id,
    id,
    `${id}@example.com`,
  ]);
};

const facts = (token?: string) =>
  Promise.resolve(
    handleHttp(
      new Request("http://localhost:9080/internal/telemetry-facts", {
        headers:
          token === undefined ? {} : { authorization: `Bearer ${token}` },
      }),
      ENV as unknown as never
    )
  );

describe("GET /internal/telemetry-facts", () => {
  test("refuses a missing or wrong runner token", async () => {
    const missing = await facts();
    expect(missing?.status).toBe(401);
    const wrong = await facts("wrong");
    expect(wrong?.status).toBe(401);
  });

  test("answers the control user count to the runner token", async () => {
    const empty = await facts(ENV.RUNNER_TOKEN);
    expect(empty?.status).toBe(200);
    expect(empty?.headers.get("cache-control")).toBe("no-store");
    expect(await empty?.json()).toEqual({ users: 0 });

    addUser("owner");
    addUser("member");
    const counted = await facts(ENV.RUNNER_TOKEN);
    expect(await counted?.json()).toEqual({ users: 2 });
  });

  test("serves GET only", async () => {
    const response = await Promise.resolve(
      handleHttp(
        new Request("http://localhost:9080/internal/telemetry-facts", {
          headers: { authorization: `Bearer ${ENV.RUNNER_TOKEN}` },
          method: "POST",
        }),
        ENV as unknown as never
      )
    );
    expect(response).toBeUndefined();
  });
});
