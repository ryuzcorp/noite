import { describe, expect, test } from "bun:test";

import {
  isAppLimitReached,
  isSlugTaken,
  RunnerHttpError,
  runnerFailureMessage,
  runnerFailureOf,
} from "./runner";

describe("runner failure text", () => {
  test("an upstream HTML body never reaches the client-facing message", () => {
    const error = new RunnerHttpError(
      "POST /v1/apps",
      502,
      "<html>SECRET upstream body</html>"
    );

    // The body stays on the field; the message (which `failUnknown` turns
    // into a 422 form error) carries only the path and status.
    expect(error.body).toBe("<html>SECRET upstream body</html>");
    expect(error.message).not.toContain("SECRET");
    expect(runnerFailureOf(error)).toEqual({
      kind: "http",
      message: "runner POST /v1/apps: 502",
      path: "POST /v1/apps",
      status: 502,
    });
    expect(runnerFailureMessage(runnerFailureOf(error))).toBe(
      "runner POST /v1/apps: 502"
    );
  });

  test("a runner rejection keeps the runner's own text", () => {
    const error = new RunnerHttpError(
      "POST /v1/apps",
      409,
      "app limit reached"
    );

    const failure = runnerFailureOf(error);

    expect(failure).toEqual({
      kind: "http",
      message: "app limit reached",
      path: "POST /v1/apps",
      status: 409,
    });
    expect(runnerFailureMessage(failure)).toBe("app limit reached");
    expect(isAppLimitReached(failure)).toBe(true);
    expect(isSlugTaken(failure)).toBe(false);
  });
});
