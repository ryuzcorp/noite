import { describe, expect, test } from "bun:test";

import { varsGetArgs, varsSetArgs, varsUnsetArgs } from "./environments.js";

describe("vars arg mapping", () => {
  test("get passes the environment through", () => {
    expect(varsGetArgs({ environment: "staging" })).toEqual({
      environment: "staging",
    });
  });

  test("set renames name to the tool's key", () => {
    expect(
      varsSetArgs({
        environment: "staging",
        name: "API_URL",
        value: "https://api.example.com",
      })
    ).toEqual({
      environment: "staging",
      key: "API_URL",
      value: "https://api.example.com",
    });
  });

  test("unset renames name to the tool's key, with no value", () => {
    expect(varsUnsetArgs({ environment: "staging", name: "API_URL" })).toEqual({
      environment: "staging",
      key: "API_URL",
    });
  });
});
