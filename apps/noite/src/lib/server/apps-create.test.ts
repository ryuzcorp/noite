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

import { createTestD1 } from "../../testing/d1";
import { installRunnerMock, makeApp } from "../../testing/runner-mock";
import type { RunnerMock } from "../../testing/runner-mock";
import { ensureDb, setD1Binding } from "../db";
import { errorMessage } from "../errors";
import { ActionFailure } from "./api";
import { createAppForUser } from "./apps.server";

interface GrantCall {
  appId: string;
  role: string;
  userId: string;
}

/** Grants requested during the current test; `grantFails` simulates D1 down. */
let grants: GrantCall[] = [];
let grantFails = true;

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
}));

let runner: RunnerMock;

beforeAll(async () => {
  const db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

beforeEach(() => {
  grants = [];
  grantFails = true;
  runner?.restore();
  runner = installRunnerMock([]);
});

afterAll(() => {
  runner.restore();
});

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
          makeApp({ id: "app-late", slug: params.slug, userId: "u-1" })
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
});
