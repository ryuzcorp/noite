import { describe, expect, test } from "bun:test";

import { folderNameOf, r2Crumbs, r2Href, toR2View } from "./state";

describe("view", () => {
  test("defaults to the list and only accepts columns", () => {
    expect(toR2View("columns")).toBe("columns");
    expect(toR2View("list")).toBe("list");
    expect(toR2View("nope")).toBe("list");
    expect(toR2View("")).toBe("list");
  });
});

describe("crumbs", () => {
  test("the bucket root links the bucket to itself only when nested", () => {
    const root = r2Crumbs("app-1", "My App", "files", "");
    expect(root.map((crumb) => crumb.label)).toEqual([
      "My App",
      "Buckets",
      "files",
    ]);
    expect(root[0].href).toBe("/apps/app-1");
    expect(root[2].href).toBeUndefined();
  });

  test("each folder segment links to its own prefix", () => {
    const crumbs = r2Crumbs("app-1", "My App", "files", "photos/2026/");
    expect(crumbs.map((crumb) => crumb.label)).toEqual([
      "My App",
      "Buckets",
      "files",
      "photos",
      "2026",
    ]);
    expect(crumbs[2].href).toBe(r2Href("app-1", "files", ""));
    expect(crumbs[3].href).toBe(r2Href("app-1", "files", "photos/"));
    expect(crumbs[4].href).toBeUndefined();
  });

  test("an empty key segment stays visible in the path", () => {
    const crumbs = r2Crumbs("app-1", "My App", "files", "a//");
    expect(crumbs.map((crumb) => crumb.label)).toEqual([
      "My App",
      "Buckets",
      "files",
      "a",
      "(empty)",
    ]);
  });

  test("encodes the resource id in the deep link", () => {
    expect(r2Href("app/1", "my bucket", "dir/")).toContain(
      encodeURIComponent("r2:my bucket")
    );
  });
});

describe("folder name", () => {
  test("classifies empty, invalid and valid names", () => {
    expect(folderNameOf("  ")._tag).toBe("Empty");
    expect(folderNameOf("a/b")._tag).toBe("Invalid");
    expect(folderNameOf("..")).toEqual({
      _tag: "Invalid",
      reason: "Pick a real folder name.",
    });
    expect(folderNameOf(" photos ")).toEqual({
      _tag: "Valid",
      name: "photos",
    });
  });
});
