import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  CONTROL_ENV_KEYS,
  controlBaseDomain,
  controlEnv,
  hydrateControlEnv,
} from "../lib/control-env";
import { DB_MIGRATING_BODY } from "../lib/db";
import { signupPolicy } from "../lib/server/email-invites.server";
import { checkFirstAdminProof } from "../lib/server/setup-code.server";
import { testRouteContext } from "../testing/context";
import type { TestD1 } from "../testing/d1";
import { createTestD1 } from "../testing/d1";
import dbMiddleware from "./03-db";

/* oxlint-disable anti-slop/no-unknown-returns -- the doubles below stand in for the platform env and the next middleware */
let db: TestD1;

/** A code that was never supplied (typed `string | undefined`). */
const ABSENT: string | undefined = [""][1];

beforeAll(() => {
  db = createTestD1();
});

beforeEach(() => {
  db.raw.run(`DELETE FROM bootstrap_setup`);
  db.raw.run(`DELETE FROM "user"`);

  // Reset the shared bag between tests over the canonical key list (a static
  // list here would drift from CONTROL_ENV_KEYS).
  for (const key of CONTROL_ENV_KEYS) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- test-only reset iterates the canonical stamp list; every key is a declared KitEnv string.
    delete controlEnv[key];
  }
});

/** The deployed worker's platform env, as the runner deploys it: worker vars
 * (BASE_DOMAIN always, the anchor when set), never dev defaults. `DB` rides
 * along so the middleware stamps the binding exactly like the worker does. */
// SAFETY: every value is a worker-var string or the test D1 binding, matching KitEnv's declared value types.
const platformEnv = (extra: Record<string, string> = {}): KitEnv =>
  ({
    BASE_DOMAIN: "dogfood37.127.0.0.1.nip.io",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
    BETTER_AUTH_URL: "https://app.dogfood37.127.0.0.1.nip.io",
    DB: db.d1,
    RUNNER_TOKEN: "runner-token",
    RUNNER_URL: "http://127.0.0.1:8080",
    ...extra,
  }) as KitEnv;

/** Drive the request through the real middleware, the way the worker does. */
const throughMiddleware = async (env: KitEnv): Promise<void> => {
  let next = false;

  const context = testRouteContext(
    new Request("http://localhost/api/invite/status"),
    env
  );

  await dbMiddleware(context, () => {
    next = true;

    return Promise.resolve();
  });
  expect(next).toBe(true);
};

describe("control env stamp (dogfood D1)", () => {
  test("a deployed public base reports the setup-code gate", async () => {
    await throughMiddleware(platformEnv());
    expect(controlBaseDomain()).toBe("dogfood37.127.0.0.1.nip.io");

    const policy = await signupPolicy();

    expect(policy.setupMode).toBe("code");
    expect(policy.adminExists).toBe(false);
    expect(
      await checkFirstAdminProof("stranger@example.com", ABSENT, policy)
    ).toEqual({ _tag: "Refused", reason: "missing" });
    expect(db.raw.query(`SELECT count(*) AS n FROM "user"`).get()).toEqual({
      n: 0,
    });
  });

  test("a deployed anchor reserves by address and still needs the code", async () => {
    await throughMiddleware(
      platformEnv({ NOITE_ADMIN_EMAIL: "op@example.com" })
    );

    const policy = await signupPolicy();

    expect(policy.setupMode).toBe("email");
    expect(
      await checkFirstAdminProof("stranger@example.com", ABSENT, policy)
    ).toEqual({ _tag: "Refused", reason: "reserved" });
    expect(
      await checkFirstAdminProof("op@example.com", ABSENT, policy)
    ).toEqual({ _tag: "Refused", reason: "missing" });
  });

  test("a localhost base keeps legacy behaviour", async () => {
    await throughMiddleware(platformEnv({ BASE_DOMAIN: "noite.localhost" }));

    const policy = await signupPolicy();

    expect(policy.setupMode).toBe("off");
    expect(
      await checkFirstAdminProof("anyone@example.com", ABSENT, policy)
    ).toEqual({ _tag: "Admitted" });
  });

  test("a missing base fails closed, never localhost", async () => {
    const { BASE_DOMAIN: _dropped, ...withoutBase } = platformEnv();

    // SAFETY: the rest spread keeps every other platform value (strings plus the D1 binding), exactly what a worker env missing one var looks like.
    await throughMiddleware(withoutBase as KitEnv);
    expect(controlBaseDomain()).toBe("");

    const policy = await signupPolicy();

    expect(policy.setupMode).toBe("code");
  });

  test("the stamp carries every declared key, including the rate limit", async () => {
    await throughMiddleware(
      platformEnv({
        BETTER_AUTH_URL: "https://app.example.com",
        NOITE_AUTH_RATE_LIMIT: "1200",
      })
    );

    expect(controlEnv.BETTER_AUTH_URL).toBe("https://app.example.com");
    expect(controlEnv.NOITE_AUTH_RATE_LIMIT).toBe("1200");
    expect(controlEnv.RUNNER_TOKEN).toBe("runner-token");
  });

  test("worker hydrate fills nothing, even with process present", async () => {
    // The deployed worker has `process` (nodejs_compat, enabled with auth)
    // but must never hydrate from it or fall back to dev defaults: emulate
    // the built bundle by defining the marker hydrate gates on.
    // SAFETY: the test defines and restores the same marker the built bundle carries; nothing else reads this global.
    const globals = globalThis as typeof globalThis & {
      __CONTROL_BUILD__?: string;
    };

    const previous = globals.__CONTROL_BUILD__;

    globals.__CONTROL_BUILD__ = "test-build";

    try {
      hydrateControlEnv({});
      expect(controlBaseDomain()).toBe("");

      const policy = await signupPolicy();

      expect(policy.setupMode).toBe("code");
    } finally {
      if (previous === undefined) {
        delete globals.__CONTROL_BUILD__;
      } else {
        globals.__CONTROL_BUILD__ = previous;
      }
    }
  });

  test("a half-migrated database answers 503 so the visitor waits", async () => {
    // A database whose migrations have not applied yet: the bootstrap reads
    // a missing table, and the request must wait (503) instead of seeing a
    // broken UI. The unmigrated binding is stamped by the middleware itself,
    // exactly like the worker's; the next test re-stamps the good one.
    const unmigrated = createTestD1();

    unmigrated.raw.run(`DROP TABLE "user"`);

    // SAFETY: platform values plus the unmigrated test binding, the same shape the worker injects.
    const env = {
      ...platformEnv(),
      DB: unmigrated.d1,
      NOITE_ADMIN_EMAIL: "unmigrated@example.com",
    } as KitEnv;

    let next = false;

    const answered: unknown = await dbMiddleware(
      testRouteContext(new Request("http://localhost/app"), env),
      () => {
        next = true;

        return Promise.resolve();
      }
    );

    expect(next).toBe(false);

    if (!(answered instanceof Response)) {
      throw new TypeError(
        "the middleware did not answer the unmigrated request"
      );
    }

    expect(answered.status).toBe(503);
    expect(answered.headers.get("retry-after")).toBe("5");
    expect(await answered.text()).toBe(DB_MIGRATING_BODY);
  });

  test("a downstream missing-table failure answers 503 too", async () => {
    let next = false;

    const answered: unknown = await dbMiddleware(
      testRouteContext(new Request("http://localhost/app"), platformEnv()),
      () => {
        next = true;

        return Promise.reject(new Error("no such table: email_invite"));
      }
    );

    expect(next).toBe(true);

    if (!(answered instanceof Response)) {
      throw new TypeError(
        "the middleware did not answer the downstream failure"
      );
    }

    expect(answered.status).toBe(503);
    expect(answered.headers.get("retry-after")).toBe("5");
  });

  test("a wrong table name downstream still throws", async () => {
    // A table the schema never declares is a code bug, not a pending
    // migration: it propagates to the 500 path instead of 503 "migrating".
    await expect(
      dbMiddleware(
        testRouteContext(new Request("http://localhost/app"), platformEnv()),
        () => Promise.reject(new Error("no such table: typo_table"))
      )
    ).rejects.toThrow("no such table: typo_table");
  });
});
