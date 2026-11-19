import { describe, expect, test } from "bun:test";

import {
  activeControlTab,
  toControlRoute,
  versionLabel,
  visibleControlTabs,
} from "./control-panel";

const ids = (admin: boolean, telemetry: boolean): string[] =>
  visibleControlTabs(admin, telemetry).map((tab) => tab.id);

describe("visibleControlTabs", () => {
  test("admins see every tab when the control fleet is managed", () => {
    expect(ids(true, true)).toEqual([
      "overview",
      "metrics",
      "analytics",
      "errors",
      "logs",
      "admin",
    ]);
  });

  test("admins lose the telemetry tabs without the control fleet", () => {
    expect(ids(true, false)).toEqual(["overview", "admin"]);
  });

  test("non-admins see no tabs: the page redirects them to /account", () => {
    expect(ids(false, true)).toEqual([]);
    expect(ids(false, false)).toEqual([]);
  });
});

describe("toControlRoute", () => {
  test("retired admin tabs fall back to overview", () => {
    for (const raw of ["users", "apps", "settings", "invites"]) {
      expect(toControlRoute(raw)).toBe("overview");
    }
  });

  test("the retired Account tab keeps its route so the page can redirect it", () => {
    expect(toControlRoute("account")).toBe("account");
  });

  test("unknown tabs fall back to overview", () => {
    expect(toControlRoute("nope")).toBe("overview");
  });
});

describe("activeControlTab", () => {
  test("non-admins land on the account route whatever the URL says", () => {
    expect(activeControlTab(false, toControlRoute("users"), true)).toBe(
      "account"
    );
    expect(activeControlTab(false, toControlRoute("settings"), false)).toBe(
      "account"
    );
    expect(activeControlTab(false, "overview", true)).toBe("account");
  });

  test("the account route stays put so the page redirects it to /account", () => {
    expect(activeControlTab(true, "account", true)).toBe("account");
  });

  test("admins keep the requested tab when the fleet allows it", () => {
    expect(activeControlTab(true, "metrics", true)).toBe("metrics");
    expect(activeControlTab(true, "analytics", true)).toBe("analytics");
    expect(activeControlTab(true, toControlRoute("admin"), false)).toBe(
      "admin"
    );
  });

  test("admins fall back to overview for a stale fleet tab", () => {
    expect(activeControlTab(true, "metrics", false)).toBe("overview");
    expect(activeControlTab(true, "logs", false)).toBe("overview");
  });
});

describe("versionLabel", () => {
  test("release tags render with the v prefix", () => {
    expect(versionLabel("0.2.0-beta.1")).toBe("v0.2.0-beta.1");
  });

  test("a tag that already carries v and a dev checkout pass through", () => {
    expect(versionLabel("v1.2.3")).toBe("v1.2.3");
    expect(versionLabel("dev")).toBe("dev");
  });

  test("a missing or empty version renders nothing", () => {
    expect(versionLabel(undefined)).toBeNull();
    expect(versionLabel("")).toBeNull();
  });
});
