import { describe, expect, test } from "bun:test";

import { sidebarPlace } from "./sidebar";

describe("sidebarPlace", () => {
  test("the list and the create page keep the Apps item active", () => {
    for (const path of ["/apps", "/apps/new"]) {
      expect(sidebarPlace(path)).toEqual({
        activeAppId: null,
        activeView: null,
        onAppsPages: true,
      });
    }
  });

  test("every page of an app selects that app and its App, Code or Pulls item", () => {
    for (const [path, view] of [
      ["/apps/a1", "app"],
      ["/apps/a1/source", "code"],
      ["/apps/a1/source/compare", "code"],
      ["/apps/a1/pulls", "pulls"],
      ["/apps/a1/pulls/3", "pulls"],
      ["/apps/a1/constructor", "app"],
      ["/storage/a1/r2%3Auploads", "app"],
      ["/storage/a1/source", "app"],
    ] as const) {
      expect(sidebarPlace(path)).toEqual({
        activeAppId: "a1",
        activeView: view,
        onAppsPages: true,
      });
    }
    expect(sidebarPlace("/apps/_control").activeAppId).toBe("_control");
  });

  test("pages outside the apps area are not apps pages", () => {
    for (const path of ["/account", "/"]) {
      expect(sidebarPlace(path)).toEqual({
        activeAppId: null,
        activeView: null,
        onAppsPages: false,
      });
    }
  });
});
