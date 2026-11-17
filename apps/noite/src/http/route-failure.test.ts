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
    const response = routeFailure("[test]", new Error("boom"));

    expect(response.status).toBe(500);
  });
});
