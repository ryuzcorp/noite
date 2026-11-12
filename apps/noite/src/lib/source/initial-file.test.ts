import { describe, expect, test } from "bun:test";

import { initialFile } from "./initial-file";

describe("the browse's initial file", () => {
  test("an empty checkout is the only 'no files' answer", () => {
    expect(initialFile([], "")).toEqual({ _tag: "Empty" });
  });

  test("the URL's file wins when the checkout holds it", () => {
    expect(initialFile(["package.json", "src/app.ts"], "src/app.ts")).toEqual({
      _tag: "Opened",
      path: "src/app.ts",
    });
  });

  test("a URL naming a path the checkout does not hold falls back", () => {
    expect(initialFile(["package.json", "src/app.ts"], "gone.ts")).toEqual({
      _tag: "Opened",
      path: "package.json",
    });
  });

  test("package.json is the front door", () => {
    expect(initialFile(["README.md", "package.json", "src/a.ts"], "")).toEqual({
      _tag: "Opened",
      path: "package.json",
    });
  });

  test("README.md comes before the first file", () => {
    expect(initialFile(["a.ts", "README.md", "z.ts"], "")).toEqual({
      _tag: "Opened",
      path: "README.md",
    });
  });

  test("otherwise the first file in tree order (folders first)", () => {
    expect(initialFile(["z.ts", "src/a.ts", "b.ts"], "")).toEqual({
      _tag: "Opened",
      path: "src/a.ts",
    });
  });

  test("only the root's package.json is the front door", () => {
    expect(initialFile(["nested/package.json", "README.md"], "")).toEqual({
      _tag: "Opened",
      path: "README.md",
    });
  });
});
