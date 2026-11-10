import { describe, expect, test } from "bun:test";

import type { RunnerEnvironment } from "../runner";
import {
  DEFAULT_SETTINGS_SECTION,
  legacySettingsHref,
  parseAppRoute,
  parseErrorFilter,
  parseScope,
  parseSettingsSection,
  scopeId,
  settingsSectionsFor,
} from "./route.machine";

// SAFETY: the parser reads only `id`; the rest of the runner row is
// irrelevant to this unit test.
const env = (id: string): RunnerEnvironment =>
  ({
    id,
    label: id,
  }) as RunnerEnvironment;

describe("parseAppRoute", () => {
  test("a stale ?env= is a notice on production, not a silent switch", () => {
    const route = parseAppRoute({ env: "env_gone", panel: "", t: "metrics" }, [
      env("env_1"),
    ]);

    expect(route.scope._tag).toBe("Production");
    expect(route.notice).toEqual({ _tag: "StaleEnvironment", id: "env_gone" });
  });

  test("a known environment is selected with no notice", () => {
    const route = parseAppRoute(
      { env: "env_1", panel: "settings", t: "deployments" },
      [env("env_1")]
    );

    expect(scopeId(route.scope)).toBe("env_1");
    expect(route.notice._tag).toBe("None");
    expect(route.panel).toBe("settings");
    expect(route.tab).toBe("deployments");
  });

  test("an unloaded environment list never invents a stale notice", () => {
    const route = parseAppRoute({ env: "env_1", panel: "", t: "metrics" });

    expect(route.notice._tag).toBe("None");
    expect(route.scope._tag).toBe("Production");
  });

  test("an unknown tab still falls back quietly for old links", () => {
    expect(parseAppRoute({ env: "", panel: "", t: "nope" }, []).tab).toBe(
      "overview"
    );
  });
});

describe("parseScope", () => {
  test("the empty wire value is production", () => {
    expect(parseScope("", []).scope._tag).toBe("Production");
  });
});

describe("parseErrorFilter", () => {
  test("unknown statuses read as open", () => {
    expect(parseErrorFilter("resolved")).toBe("resolved");
    expect(parseErrorFilter("bogus")).toBe("open");
  });
});

describe("parseSettingsSection", () => {
  test("a known section is the section", () => {
    expect(parseSettingsSection("domains", true)).toBe("domains");
  });

  test("an unknown section is the default, never an empty view", () => {
    expect(parseSettingsSection("", true)).toBe(DEFAULT_SETTINGS_SECTION);
    expect(parseSettingsSection("nope", true)).toBe(DEFAULT_SETTINGS_SECTION);
  });

  test("an admin-only section is refused for a non-admin", () => {
    for (const section of ["branch-protection", "danger"] as const) {
      expect(parseSettingsSection(section, true)).toBe(section);
      expect(parseSettingsSection(section, false)).toBe(
        DEFAULT_SETTINGS_SECTION
      );
    }
  });
});

describe("settingsSectionsFor", () => {
  test("the admin-only sections leave a non-admin's tab row", () => {
    expect(settingsSectionsFor(true)).toContain("branch-protection");
    expect(settingsSectionsFor(true)).toContain("danger");
    expect(settingsSectionsFor(false)).not.toContain("branch-protection");
    expect(settingsSectionsFor(false)).not.toContain("danger");
    expect(settingsSectionsFor(false)[0]).toBe(DEFAULT_SETTINGS_SECTION);
  });
});

describe("legacySettingsHref", () => {
  test("the old ?panel=settings link becomes the view's path", () => {
    expect(legacySettingsHref("app_1", "")).toBe("/apps/app_1/settings");
  });

  test("a known ?section= deep link rides along", () => {
    expect(legacySettingsHref("app_1", "domains")).toBe(
      "/apps/app_1/settings?section=domains"
    );
  });

  test("an unknown ?section= is dropped, not forwarded", () => {
    expect(legacySettingsHref("app_1", "nope")).toBe("/apps/app_1/settings");
  });
});
