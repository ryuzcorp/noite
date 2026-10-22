import { describe, expect, test } from "bun:test";

import type { RunnerDeploy } from "../runner";
import { leanDeployRows } from "./apps.server";

const row = (overrides: Partial<RunnerDeploy>): RunnerDeploy => ({
  appId: "a",
  createdAt: "2026-10-22T00:00:00Z",
  environmentId: null,
  id: "d",
  log: "",
  sha: "abc1234",
  status: "success",
  updatedAt: "2026-10-22T00:00:00Z",
  ...overrides,
});

describe("leanDeployRows", () => {
  test("blanks finished rows' build logs", () => {
    const rows = leanDeployRows([
      row({ id: "new", log: "full log", status: "success" }),
      row({ id: "old", log: "older log", status: "failed" }),
    ]);

    expect(rows.map((entry) => entry.log)).toEqual(["", ""]);
  });

  test("keeps the newest row's live log while in flight", () => {
    const rows = leanDeployRows([
      row({ id: "live", log: "live log", status: "building" }),
      row({ id: "old", log: "older log", status: "success" }),
    ]);

    expect(rows.map((entry) => entry.log)).toEqual(["live log", ""]);
  });
});
