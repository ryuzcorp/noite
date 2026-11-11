import { describe, expect, test } from "bun:test";

import {
  createKeyBody,
  draftProblem,
  KeyScopes,
  newKeyDraft,
  scopeInput,
  scopeSelection,
  toggleApp,
  toggleScope,
  withCeiling,
  withExpiry,
  withScope,
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

describe("the key draft", () => {
  const APPS = ["app-1", "app-2"];

  test("a fresh draft changes nothing about yesterday's key", () => {
    expect(newKeyDraft()).toEqual({
      appIds: null,
      ceiling: "admin",
      expiry: "never",
      scope: KeyScopes.Both(),
    });
  });

  test("unchecking one app narrows the set; re-checking it goes back to all", () => {
    const narrowed = toggleApp(newKeyDraft(), "app-1", false, APPS);
    expect(narrowed.appIds).toEqual(["app-2"]);

    const restored = toggleApp(narrowed, "app-1", true, APPS);
    expect(restored.appIds).toBeNull();
  });

  test("unchecking every app is an invalid draft, not an empty restriction", () => {
    let draft = newKeyDraft();

    for (const id of APPS) {
      draft = toggleApp(draft, id, false, APPS);
    }

    expect(draft.appIds).toEqual([]);
    expect(draftProblem(draft)).toBe(
      "Pick at least one app, or leave the key account-wide"
    );
  });

  test("an ingest key cannot have a view ceiling", () => {
    const viewOnly = withCeiling(
      withScope(newKeyDraft(), KeyScopes.Events()),
      "view"
    );

    expect(draftProblem(viewOnly)).toBe(
      "Event ingest needs the push role or a higher ceiling"
    );
    // A read-only key with no ingest scope is fine at `view`.
    expect(
      draftProblem(
        withCeiling(withScope(newKeyDraft(), KeyScopes.Apps()), "view")
      )
    ).toBeNull();
  });

  test("the request body carries the scope, ceiling and expiry", () => {
    const draft = withExpiry(
      withCeiling(toggleApp(newKeyDraft(), "app-1", false, APPS), "push"),
      "7d"
    );

    expect(createKeyBody(draft, "  ci  ")).toEqual({
      appIds: ["app-2"],
      appManagement: true,
      events: true,
      expirySeconds: 604_800,
      name: "ci",
      roleCeiling: "push",
    });

    expect(createKeyBody(newKeyDraft(), "bot").expirySeconds).toBeNull();
  });
});
