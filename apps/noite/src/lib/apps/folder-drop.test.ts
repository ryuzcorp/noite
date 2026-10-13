import { describe, expect, test } from "bun:test";

import { projectSkip, projectUpload } from "./folder-drop";

// SAFETY: `projectSkip` reads only `isDirectory` and `name` off an entry.
const dir = (name: string) =>
  ({ isDirectory: true, isFile: false, name }) as FileSystemEntry;
// SAFETY: as above — only `isDirectory` and `name` are read.
const file = (name: string) =>
  ({ isDirectory: false, isFile: true, name }) as FileSystemEntry;

describe("project folder drops", () => {
  test("the dropped root is never skipped, whatever it is called", () => {
    expect(projectSkip(dir("build"), "build")).toBe(false);
    expect(projectSkip(dir("node_modules"), "node_modules")).toBe(false);
  });

  test("dependencies, build output and git metadata stay behind", () => {
    for (const name of ["node_modules", ".git", "dist", ".wrangler"]) {
      expect(projectSkip(dir(name), `app/${name}`)).toBe(true);
    }
    expect(projectSkip(dir("src"), "app/src")).toBe(false);
    // A file named like a skipped directory is ordinary source.
    expect(projectSkip(file("dist"), "app/dist")).toBe(false);
  });

  test("local env files are left out, their templates are not", () => {
    for (const name of [".env", ".env.local", ".env.production", ".dev.vars"]) {
      expect(projectSkip(file(name), `app/${name}`)).toBe(true);
    }
    for (const name of [".env.example", ".env.sample", ".env.template"]) {
      expect(projectSkip(file(name), `app/${name}`)).toBe(false);
    }
  });

  test("paths lose the dropped folder's name", () => {
    const result = projectUpload("app", [
      { kind: "text", path: "app/package.json", text: "{}" },
      { base64: "AAE=", bytes: 2, kind: "binary", path: "app/public/a.png" },
    ]);
    expect(result).toEqual({
      upload: {
        bytes: 4,
        files: [
          { content: "{}", path: "package.json" },
          { content: "AAE=", encoding: "base64", path: "public/a.png" },
        ],
        name: "app",
      },
    });
  });

  test("an empty, unreadable or oversized folder is refused", () => {
    expect(projectUpload("app", [])).toHaveProperty("error");
    expect(
      projectUpload("app", [{ kind: "error", path: "app/x", reason: "denied" }])
    ).toEqual({ error: "app/x could not be read." });
    const many = Array.from({ length: 101 }, (_, i) => ({
      kind: "text" as const,
      path: `app/f${i}.txt`,
      text: "x",
    }));
    expect(projectUpload("app", many)).toHaveProperty("error");
  });
});
