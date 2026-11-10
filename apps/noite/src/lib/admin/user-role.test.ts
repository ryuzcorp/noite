import { describe, expect, test } from "bun:test";

import { adminRoleOf } from "./user-role";

describe("adminRoleOf", () => {
  test("the two real roles pass through", () => {
    expect(adminRoleOf("admin")).toEqual({ known: true, role: "admin" });
    expect(adminRoleOf("user")).toEqual({ known: true, role: "user" });
  });

  test("a null role is the column default, not corruption", () => {
    expect(adminRoleOf(null)).toEqual({ known: true, role: "user" });
  });

  test("an unexpected value is flagged so the UI can say so", () => {
    // The old coercion mapped this to "user" with no signal: a corrupted row
    // looked exactly like a normal account.
    expect(adminRoleOf("superuser")).toEqual({ known: false, role: "user" });
    expect(adminRoleOf(42)).toEqual({ known: false, role: "user" });
  });
});
