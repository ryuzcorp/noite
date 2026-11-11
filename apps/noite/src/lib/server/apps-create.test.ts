//! The create grant is the only thing that makes an app openable: a grant
//! that fails after the runner row exists must roll the row back, and a
//! create whose runner call outlived the control plane's bound must adopt the
//! detached row the runner lands and grant it (otherwise no one can see it).

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { TIMEOUT_MS } from "../../middleware/01-timeout";
import { createTestD1 } from "../../testing/d1";
import { installRunnerMock, makeApp } from "../../testing/runner-mock";
import type { RunnerMock } from "../../testing/runner-mock";
import { ensureDb, setD1Binding } from "../db";
import { errorMessage } from "../errors";
import { CREATE_TIMEOUT_MS } from "../runner";
import { ActionFailure } from "./api";
import { CREATE_RECOVERY_MS, createAppForUser } from "./apps.server";

interface GrantCall {
  appId: string;
  role: string;
  userId: string;
}

/** Grants requested during the current test; `grantFails` simulates D1 down. */
let grants: GrantCall[] = [];
let grantFails = true;

/** The rows `listCollaboratorRows` reports for the app under test: the
 * adoption rule reads them, so a test can say "removed", "push only" or
 * "still an admin". */
let collaboratorRows: { role: string; userId: string }[] = [];

// Fail the grant the way a D1 outage would (nothing else in that module is
// used here). Bun hoists `mock.module` above the imports.
mock.module("../collaborators", () => ({
  grantCollaborator: (appId: string, userId: string, role: string) => {
    if (grantFails) {
      return Promise.reject(new Error("D1 is down"));
    }

    grants.push({ appId, role, userId });

    return Promise.resolve();
  },
  listCollaboratorRows: () =>
    Promise.resolve(
      collaboratorRows.map((row) => ({
        createdAt: "2026-01-01T00:00:00Z",
        email: `${row.userId}@example.com`,
        name: row.userId,
        role: row.role,
        userId: row.userId,
      }))
    ),
}));

let runner: RunnerMock;

beforeAll(async () => {
  const db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

beforeEach(() => {
  collaboratorRows = [];
  grants = [];
  grantFails = true;
  runner?.restore();
  runner = installRunnerMock([]);
});

afterAll(() => {
  runner.restore();
});

describe("create recovery budget", () => {
  test("create plus its adopt poll fit under the route bound", () => {
    // 2 s left for the grant and the response; the route answers 504 at
    // TIMEOUT_MS, so a recovery that ends later fails a create that is about
    // to succeed (14 s create + 10 s adopt before this budget).
    expect(CREATE_TIMEOUT_MS).toBeLessThan(TIMEOUT_MS);
    expect(CREATE_RECOVERY_MS).toBeLessThanOrEqual(TIMEOUT_MS - 2000);
  });
});

/** A create that answers 409 because the caller's own row already exists
 * (the row landed after a first attempt the caller gave up on). */
const takenRow = (overrides: Parameters<typeof makeApp>[0] = {}) => {
  grantFails = false;
  runner = installRunnerMock([
    makeApp({
      createdAt: new Date().toISOString(),
      id: "app-own",
      slug: "one",
      userId: "u-1",
      ...overrides,
    }),
  ]);
};

describe("createAppForUser", () => {
  test("a failed grant rolls the runner row back and fails the action", async () => {
    try {
      await createAppForUser({
        account: { id: "u-1", name: "One" },
        name: "One",
        slug: "one",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ActionFailure);
      expect(errorMessage(error)).toContain("D1 is down");
      expect(runner.calls).toEqual(["apps.create", "apps.delete"]);
      expect(runner.apps).toEqual([]);

      return;
    }

    throw new Error("expected createAppForUser to reject");
  });

  test("a create that outlived the bound adopts and grants the landed row", async () => {
    grantFails = false;
    runner = installRunnerMock([], {
      onCreate: (runnerMock, params) => {
        runnerMock.apps.push(
          makeApp({
            createdAt: new Date().toISOString(),
            id: "app-late",
            slug: params.slug,
            userId: "u-1",
          })
        );

        return "timeout";
      },
    });

    const app = await createAppForUser({
      account: { id: "u-1", name: "One" },
      name: "One",
      slug: "one",
    });

    expect(app.id).toBe("app-late");
    expect(runner.calls).toEqual(["apps.create", "apps.get_by_slug"]);
    expect(grants).toEqual([
      { appId: "app-late", role: "admin", userId: "u-1" },
    ]);
  });

  test("a timed-out create never adopts another account's row", async () => {
    grantFails = false;
    runner = installRunnerMock([], {
      onCreate: (runnerMock, params) => {
        runnerMock.apps.push(
          makeApp({ id: "app-other", slug: params.slug, userId: "u-2" })
        );

        return "timeout";
      },
    });

    try {
      await createAppForUser({
        account: { id: "u-1", name: "One" },
        name: "One",
        slug: "one",
      });
    } catch (error) {
      if (!(error instanceof DOMException)) {
        throw error;
      }

      expect(error.name).toBe("TimeoutError");
      expect(grants).toEqual([]);

      return;
    }

    throw new Error("expected createAppForUser to reject");
  });

  test("a removed creator is not adopted and keeps nothing", async () => {
    takenRow();
    collaboratorRows = [{ role: "admin", userId: "u-2" }];

    await expect(
      createAppForUser({
        account: { id: "u-1", name: "One" },
        name: "One",
        slug: "one",
      })
    ).rejects.toThrow(/slug already taken/u);

    expect(grants).toEqual([]);
  });

  test("a push-only creator is not raised to admin", async () => {
    takenRow();
    collaboratorRows = [{ role: "push", userId: "u-1" }];

    await expect(
      createAppForUser({
        account: { id: "u-1", name: "One" },
        name: "One",
        slug: "one",
      })
    ).rejects.toThrow(/slug already taken/u);

    expect(grants).toEqual([]);
  });

  test("a creator who is still an admin is adopted without a grant write", async () => {
    takenRow();
    collaboratorRows = [{ role: "admin", userId: "u-1" }];

    const app = await createAppForUser({
      account: { id: "u-1", name: "One" },
      name: "One",
      slug: "one",
    });

    expect(app.id).toBe("app-own");
    expect(grants).toEqual([]);
  });

  test("a stale grant-less row is not adopted", async () => {
    takenRow({ createdAt: "2026-01-01T00:00:00Z" });

    await expect(
      createAppForUser({
        account: { id: "u-1", name: "One" },
        name: "One",
        slug: "one",
      })
    ).rejects.toThrow(/slug already taken/u);

    expect(grants).toEqual([]);
  });
});
