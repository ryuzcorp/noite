import { describe, expect, test } from "bun:test";

import {
  operationFailure,
  PushOps,
  resetOperations,
  settlePush,
  startPush,
} from "./operations";

describe("the commit operation's transition table", () => {
  test("Idle starts a push", () => {
    expect(startPush(PushOps.Idle(), "main")).toEqual(
      PushOps.Pushing({ branch: "main" })
    );
  });

  test("a push in flight refuses a second one", () => {
    const pushing = PushOps.Pushing({ branch: "main" });

    expect(startPush(pushing, "main")).toBeNull();
  });

  test("a landed push records where it went", () => {
    const pushing = PushOps.Pushing({ branch: "feature" });

    const settled = settlePush(pushing, {
      ok: true,
      to: { branch: "feature", newBranch: true },
    });

    expect(settled).toEqual(
      PushOps.Done({ to: { branch: "feature", newBranch: true } })
    );
  });

  test("a failed push records its reason", () => {
    const settled = settlePush(PushOps.Pushing({ branch: "main" }), {
      failure: { message: "409 tip moved" },
      ok: false,
    });

    expect(settled).toEqual(
      PushOps.Failed({ failure: { message: "409 tip moved" } })
    );
  });

  test("an outcome only lands on a push in flight", () => {
    const done = PushOps.Done({ to: { branch: "main", newBranch: false } });

    expect(
      settlePush(done, { ok: true, to: { branch: "other", newBranch: false } })
    ).toBe(done);
  });

  test("a change landed resets the form", () => {
    expect(resetOperations()._tag).toBe("Idle");
  });

  test("a caught error becomes its message", () => {
    expect(operationFailure(new Error("boom"))).toEqual({ message: "boom" });
  });
});
