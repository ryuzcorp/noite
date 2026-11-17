import { describe, expect, test } from "bun:test";

import { DB_MIGRATING_BODY, dbUnavailable } from "../lib/db";
import { routeFailure } from "./route-failure";

describe("routeFailure", () => {
  test("a half-migrated database answers 503 with retry-after", async () => {
    const response = routeFailure("[test]", dbUnavailable());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.text()).toBe(DB_MIGRATING_BODY);
  });

  test("anything else stays a flat 500", () => {
    expect(routeFailure("[test]", new Error("boom")).status).toBe(500);
  });

  test("a wrong table name stays a flat 500", () => {
    // The 503 gate only knows the schema's own tables: a code bug naming
    // any other table must 500 here, never "migrating" forever.
    const response = routeFailure(
      "[test]",
      new Error("no such table: typo_table")
    );

    expect(response.status).toBe(500);
  });
});
