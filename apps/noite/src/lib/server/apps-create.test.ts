//! A grant that fails after the runner row exists must still roll the row
//! back, and the caller must see `fail()` — never the raw error, which the
//! action layer masks as a generic 500 "Internal error".

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import * as Effect from "effect/Effect";

import { createTestD1 } from "../../testing/d1";
import { installRunnerMock } from "../../testing/runner-mock";
import type { RunnerMock } from "../../testing/runner-mock";
import { ensureDbPromise, setD1Binding } from "../db";
import { errorMessage } from "../errors";
import { ActionFailure } from "./api";
import { createAppForUser } from "./apps.server";

// Fail the grant the way a D1 outage would (nothing else in that module is
// used here). Bun hoists `mock.module` above the imports.
mock.module("../collaborators", () => ({
  grantCollaborator: () => Effect.fail(new Error("D1 is down")),
}));

let runner: RunnerMock;

beforeAll(async () => {
  const db = createTestD1();
  setD1Binding(db.d1);
  await ensureDbPromise();
});

beforeEach(() => {
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
});
