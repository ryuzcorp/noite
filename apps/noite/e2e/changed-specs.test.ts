import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import { changedSpecPatterns } from "./changed-specs";

describe("changedSpecPatterns", () => {
  test("create does not select delete-recreate (the #359 collision)", () => {
    const [pattern] = changedSpecPatterns(["create.spec.ts"]);

    expect(pattern?.test("e2e/create.spec.ts")).toBe(true);
    expect(pattern?.test("e2e/delete-recreate.spec.ts")).toBe(false);
  });

  test("a changed file still selects itself", () => {
    const [pattern] = changedSpecPatterns(["delete-recreate.spec.ts"]);

    expect(pattern?.test("e2e/delete-recreate.spec.ts")).toBe(true);
    expect(pattern?.test("e2e/create.spec.ts")).toBe(false);
  });

  test("regex characters in names stay literal", () => {
    const [pattern] = changedSpecPatterns(["a+b.spec.ts"]);

    expect(pattern?.test("e2e/a+b.spec.ts")).toBe(true);
    expect(pattern?.test("e2e/aXb.spec.ts")).toBe(false);
  });

  test("nested paths match their own directory only", () => {
    const [pattern] = changedSpecPatterns(["sub/foo.spec.ts"]);

    expect(pattern?.test("e2e/sub/foo.spec.ts")).toBe(true);
    expect(pattern?.test("e2e/other/foo.spec.ts")).toBe(false);
  });

  test("every spec's pattern selects exactly its own file", () => {
    const files = readdirSync(new URL(".", import.meta.url)).filter((entry) =>
      entry.endsWith(".spec.ts")
    );

    for (const file of files) {
      const [pattern] = changedSpecPatterns([file]);

      const matched = files.filter((entry) => pattern?.test(`e2e/${entry}`));

      expect(matched).toEqual([file]);
    }
  });
});
