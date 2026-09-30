import { expect, test } from "bun:test";

import { parseAppRole, roleAtLeast } from "./roles";

test("roles are ordered view < push < admin", () => {
  expect(roleAtLeast("admin", "push")).toBe(true);
  expect(roleAtLeast("push", "push")).toBe(true);
  expect(roleAtLeast("view", "push")).toBe(false);
  expect(roleAtLeast("push", "admin")).toBe(false);
  expect(roleAtLeast("view", "view")).toBe(true);
});

test("parseAppRole accepts exactly the three roles", () => {
  expect(parseAppRole("view")).toBe("view");
  expect(parseAppRole("push")).toBe("push");
  expect(parseAppRole("admin")).toBe("admin");
  expect(parseAppRole("owner")).toBeNull();
  expect(parseAppRole("")).toBeNull();
});
