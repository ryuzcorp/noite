import { describe, expect, test } from "bun:test";

import { runnerTokenOk, tokenEquals } from "./config";

const request = (headers: Record<string, string>) =>
  new Request("http://noite.localhost:9080/internal/recovery", { headers });

describe("tokenEquals", () => {
  test("matches only the exact token", () => {
    expect(tokenEquals("s3cret-token", "s3cret-token")).toBe(true);
    expect(tokenEquals("s3cret-tokem", "s3cret-token")).toBe(false);
    expect(tokenEquals("s3cret", "s3cret-token")).toBe(false);
    expect(tokenEquals("s3cret-token-and-more", "s3cret-token")).toBe(false);
    expect(tokenEquals("", "s3cret-token")).toBe(false);
  });

  test("compares bytes, not UTF-16 units", () => {
    expect(tokenEquals("tökén", "tökén")).toBe(true);
    expect(tokenEquals("tökén", "tokén")).toBe(false);
  });
});

describe("runnerTokenOk", () => {
  // SAFETY: runnerTokenOk reads only RUNNER_TOKEN from the env.
  const env = { RUNNER_TOKEN: "s3cret-token" } as KitEnv;

  test("accepts the token as a bearer or a runner header", () => {
    expect(
      runnerTokenOk(request({ authorization: "Bearer s3cret-token" }), env)
    ).toBe(true);
    expect(
      runnerTokenOk(request({ "x-runner-token": "s3cret-token" }), env)
    ).toBe(true);
    expect(
      runnerTokenOk(request({ "x-host-token": "s3cret-token" }), env)
    ).toBe(true);
  });

  test("refuses a wrong, missing or unconfigured token", () => {
    expect(
      runnerTokenOk(request({ authorization: "Bearer s3cret-tokem" }), env)
    ).toBe(false);
    expect(runnerTokenOk(request({}), env)).toBe(false);

    // SAFETY: an env without RUNNER_TOKEN is the unconfigured case under test.
    const unconfigured = {} as KitEnv;

    expect(
      runnerTokenOk(request({ authorization: "Bearer " }), unconfigured)
    ).toBe(false);
  });
});
