import { describe, expect, test } from "bun:test";

import {
  KeyScopes,
  scopeInput,
  scopeSelection,
  toggleScope,
} from "./api-key.machine";

describe("toggleScope", () => {
  test("turning off the last checked scope is a no-op", () => {
    // Two booleans allowed "neither scope": the server rejected it after a
    // round trip while the Create button stayed enabled.
    const appsOnly = toggleScope(KeyScopes.Both(), "events", false);

    expect(appsOnly).toEqual(KeyScopes.Apps());
    expect(toggleScope(appsOnly, "apps", false)).toBe(appsOnly);
  });

  test("turning the other one on yields Both", () => {
    expect(toggleScope(KeyScopes.Apps(), "events", true)).toEqual(
      KeyScopes.Both()
    );
  });

  test("the request fields follow the selection", () => {
    expect(scopeInput(KeyScopes.Events())).toEqual({
      appManagement: false,
      events: true,
    });
    expect(scopeSelection(KeyScopes.Both())).toEqual({
      apps: true,
      events: true,
    });
  });
});
