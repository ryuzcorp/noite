import { describe, expect, test } from "bun:test";

import { activeControlTab, visibleControlTabs } from "./control-panel";

const ids = (admin: boolean, telemetry: boolean): string[] =>
  visibleControlTabs(admin, telemetry).map((tab) => tab.id);

describe("visibleControlTabs", () => {
  test("admins see every tab when the control fleet is managed", () => {
    expect(ids(true, true)).toEqual([
      "overview",
      "metrics",
      "errors",
      "logs",
      "users",
      "apps",
      "settings",
      "account",
    ]);
  });

  test("admins lose the telemetry tabs without the control fleet, and keep account", () => {
    expect(ids(true, false)).toEqual([
      "overview",
      "users",
      "apps",
      "settings",
      "account",
    ]);
  });

  test("non-admins see only their Account tab, fleet or not", () => {
    expect(ids(false, true)).toEqual(["account"]);
    expect(ids(false, false)).toEqual(["account"]);
  });
});

describe("activeControlTab", () => {
  test("non-admins land on account whatever the URL says", () => {
    expect(activeControlTab(false, "users", true)).toBe("account");
    expect(activeControlTab(false, "settings", false)).toBe("account");
    expect(activeControlTab(false, "account", true)).toBe("account");
  });

  test("admins keep the requested tab when the fleet allows it", () => {
    expect(activeControlTab(true, "metrics", true)).toBe("metrics");
    expect(activeControlTab(true, "users", false)).toBe("users");
    expect(activeControlTab(true, "account", true)).toBe("account");
  });

  test("admins fall back to overview for a stale fleet tab", () => {
    expect(activeControlTab(true, "metrics", false)).toBe("overview");
    expect(activeControlTab(true, "logs", false)).toBe("overview");
  });
});
