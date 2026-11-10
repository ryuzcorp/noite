import { describe, expect, test } from "bun:test";

import {
  RunnerHttpError,
  RunnerRpcError,
  runnerFailureMessage,
  runnerFailureOf,
} from "./runner";

describe("runner failure text", () => {
  test("an upstream HTTP body never reaches the client-facing message", () => {
    const error = new RunnerHttpError("POST /rpc", 502, "SECRET upstream body");

    // The body stays on the field; the message (which `failUnknown` turns
    // into a 422 form error) carries only the path and status.
    expect(error.body).toBe("SECRET upstream body");
    expect(error.message).not.toContain("SECRET");
    expect(runnerFailureOf(error)).toEqual({
      kind: "http",
      path: "POST /rpc",
      status: 502,
    });
    expect(runnerFailureMessage(runnerFailureOf(error))).toBe(
      "runner POST /rpc: 502"
    );
  });

  test("an RPC rejection keeps the runner's own text", () => {
    const error = new RunnerRpcError("apps.create", 409, "app limit reached");

    expect(runnerFailureOf(error)).toEqual({
      code: 409,
      kind: "rpc",
      message: "runner rpc apps.create: 409 app limit reached",
    });
    expect(runnerFailureMessage(runnerFailureOf(error))).toContain(
      "app limit reached"
    );
  });
});
