import { describe, expect, test } from "bun:test";

import { dbUnavailable } from "../lib/db";
import { routeFailure } from "./route-failure";

describe("routeFailure", () => {
  test("a database outage stays a flat 500 with no retry", async () => {
    // The half-migrated 503 is gone with the pre-reset lineages: a database
    // failure retries nothing, so the visitor never waits on a database that
    // refuses to migrate.
    const response = routeFailure("[test]", dbUnavailable());

    expect(response.status).toBe(500);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.text()).toBe("");
  });

  test("anything else stays a flat 500", () => {
    expect(routeFailure("[test]", new Error("boom")).status).toBe(500);
  });

  test("a wrong table name stays a flat 500", () => {
    const response = routeFailure(
      "[test]",
      new Error("no such table: typo_table")
    );

    expect(response.status).toBe(500);
  });
});
