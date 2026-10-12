import { describe, expect, test } from "bun:test";

import { PROJECT_ROOT, projectPath, relPath } from "./types";

describe("projectPath", () => {
  test("maps checkout paths into the project root and back", () => {
    expect(projectPath("")).toBe(PROJECT_ROOT);
    expect(projectPath("/src/index.ts")).toBe(`${PROJECT_ROOT}/src/index.ts`);
    expect(relPath(projectPath("src/index.ts"))).toBe("src/index.ts");
  });

  test("refuses a path that would leave the checkout", () => {
    for (const rel of ["../.noite/base.json", "src/../../x", "./a", "a/./b"]) {
      expect(() => projectPath(rel)).toThrow("leaves the checkout");
    }
  });
});
