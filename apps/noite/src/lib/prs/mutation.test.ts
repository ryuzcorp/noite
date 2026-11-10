import { describe, expect, test } from "bun:test";

import {
  mutationProblem,
  mutationRunning,
  Mutation,
  nextMutation,
} from "./mutation";

describe("PR mutation", () => {
  test("one mutation at a time across every control", () => {
    // P2 fail-before: Close, Merge and a review each had their own busy flag,
    // so two writes could be in flight and the runner's 409 surfaced as an
    // unrelated error.
    const closing = nextMutation(Mutation.Idle(), {
      kind: "start",
      mutation: "close",
    });

    expect(mutationRunning(closing)).toBe(true);
    expect(nextMutation(closing, { kind: "start", mutation: "merge" })).toEqual(
      closing
    );
  });

  test("a failure names its control and is cleared by the next start", () => {
    const failed = nextMutation(
      nextMutation(Mutation.Idle(), { kind: "start", mutation: "merge" }),
      { kind: "failed", message: "the base branch moved; retry" }
    );

    expect(mutationProblem(failed, ["merge"])).toBe(
      "the base branch moved; retry"
    );
    expect(mutationProblem(failed, ["close", "reopen"])).toBeNull();
    expect(
      nextMutation(failed, { kind: "start", mutation: "close" })._tag
    ).toBe("Running");
  });

  test("done returns to Idle", () => {
    const running = nextMutation(Mutation.Idle(), {
      kind: "start",
      mutation: "review",
    });

    expect(nextMutation(running, { kind: "done" })).toEqual(Mutation.Idle());
  });
});
