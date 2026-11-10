import { describe, expect, test } from "bun:test";

import type { RunnerEnvironment } from "../runner";
import {
  parseAppRoute,
  parseErrorFilter,
  parseScope,
  scopeId,
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
