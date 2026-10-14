//! The `.gitignore` matcher's own tests: every case here was checked against
//! `git check-ignore -v` in a throwaway repository, so the expectations are
//! git's answers and not this implementation's. A path is written without a
//! trailing slash — `isDir` is the separate question git answers by looking at
//! the path on disk — because a trailing slash of its own means something else
//! to a pattern's glob (`a/*` matches `a/`).

import { describe, expect, test } from "bun:test";

import { addIgnoreFile, isIgnored, NO_RULES } from "./gitignore";
import type { Committed, IgnoreRules } from "./gitignore";

/** The rules one `.gitignore` at the checkout root holds. */
const rules = (text: string): IgnoreRules => addIgnoreFile(NO_RULES, text, "");

/** Whether one root `.gitignore` excludes `path`. */
const excluded = (text: string, path: string, isDir = false): boolean =>
  isIgnored(rules(text), path, isDir);

/** The commit the last test's `.gitignore` faces: a file under `dist/`, and
 * the folder that holds it. */
const COMMITTED: Committed = (path, isDir) =>
  isDir ? path === "dist" : path === "dist/tracked.js";

describe("the .gitignore matcher", () => {
  test("a blank line and a comment are no patterns", () => {
    expect(excluded("# a comment\n\n   \ndist", "dist", true)).toBe(true);
    expect(excluded("# a comment\n#dist", "dist", true)).toBe(false);
  });

  test("a separator anchors a pattern to its own directory, and nothing else does", () => {
    const text = "/dist\nsrc/build";
    expect(excluded(text, "dist", true)).toBe(true);
    expect(excluded(text, "nested/dist", true)).toBe(false);
    expect(excluded(text, "src/build", true)).toBe(true);
    expect(excluded(text, "nested/src/build", true)).toBe(false);
  });

  test("an unanchored pattern matches at any depth", () => {
    const text = "dist\nc";
    expect(excluded(text, "a/b/dist", true)).toBe(true);
    expect(excluded(text, "c")).toBe(true);
    expect(excluded(text, "x/c")).toBe(true);
  });

  test("a trailing slash only matches a directory, at any depth", () => {
    const text = "build/";
    expect(excluded(text, "build", true)).toBe(true);
    expect(excluded(text, "a/build", true)).toBe(true);
    expect(excluded(text, "build")).toBe(false);
    expect(excluded(text, "a/build/x.txt")).toBe(true);
  });

  test("a rule on a folder takes everything under it with it", () => {
    const text = "a/*\nfoo";
    expect(excluded(text, "a/one.txt")).toBe(true);
    expect(excluded(text, "a/one/two.txt")).toBe(true);
    expect(excluded(text, "foo/bar")).toBe(true);
    expect(excluded(text, "foo/x")).toBe(true);
  });

  test("* and ? never reach across a separator, a class keeps git's !", () => {
    expect(excluded("*.log", "x.log")).toBe(true);
    expect(excluded("*.log", "a/b/x.log")).toBe(true);
    expect(excluded("?.md", "a.md")).toBe(true);
    expect(excluded("?.md", "ab.md")).toBe(false);
    expect(excluded("[ab].txt", "a.txt")).toBe(true);
    expect(excluded("[ab].txt", "c.txt")).toBe(false);
    expect(excluded("[!ab].txt", "c.txt")).toBe(true);
    expect(excluded("[!ab].txt", "a.txt")).toBe(false);
    expect(excluded("[[:alpha:]].md", "a.md")).toBe(true);
    expect(excluded("[[:alpha:]].md", "1.md")).toBe(false);
  });

  test("** is the one pattern that reaches across directories", () => {
    expect(excluded("**/foo", "foo", true)).toBe(true);
    expect(excluded("**/foo", "a/b/foo", true)).toBe(true);
    expect(excluded("a/**/b", "a/b", true)).toBe(true);
    expect(excluded("a/**/b", "a/x/y/b", true)).toBe(true);
    expect(excluded("a/**", "a/x", true)).toBe(true);
    expect(excluded("a/**", "a/x/y.txt")).toBe(true);
    expect(excluded("a/**", "a", true)).toBe(false);
    expect(excluded("a/**", "b/x", true)).toBe(false);
    // On its own git reads it as everything, like a leading `**/` with no rest.
    expect(excluded("**", "a")).toBe(true);
    expect(excluded("**", "a/b")).toBe(true);
  });

  test("the last rule that matches decides, and ! re-includes", () => {
    const text = "*.log\n!keep.log";
    expect(excluded(text, "x.log")).toBe(true);
    expect(excluded(text, "keep.log")).toBe(false);
    expect(excluded(text, "a/keep.log")).toBe(false);
    // The same two rules the other way around: the plain one wins.
    expect(excluded("!keep.log\n*.log", "keep.log")).toBe(true);
  });

  test("a file under an excluded directory cannot be re-included", () => {
    const text = "dist/\n!dist/keep.js";
    expect(excluded(text, "dist", true)).toBe(true);
    expect(excluded(text, "dist/keep.js")).toBe(true);
    expect(excluded(text, "dist/other.js")).toBe(true);
    // A folder is only what a rule of its own makes it: `dist/*` leaves `dist`
    // itself alone, so a `!` under it still lands.
    const inside = "dist/*\n!dist/keep.js";
    expect(excluded(inside, "dist", true)).toBe(false);
    expect(excluded(inside, "dist/keep.js")).toBe(false);
    expect(excluded(inside, "dist/other.js")).toBe(true);
  });

  test("a class no regex can carry hides nothing rather than throwing", () => {
    expect(excluded("[z-a]", "a")).toBe(false);
  });

  test("a backslash escapes a #, a !, a space and a glob", () => {
    expect(excluded("\\#file", "#file")).toBe(true);
    expect(excluded("\\!file", "!file")).toBe(true);
    expect(excluded("trailing ", "trailing")).toBe(true);
    expect(excluded("space\\ ", "space ")).toBe(true);
    expect(excluded("\\*.md", "*.md")).toBe(true);
    expect(excluded("\\*.md", "a.md")).toBe(false);
  });

  test("the dependency folder is excluded whatever the rules say", () => {
    expect(excluded("", "node_modules", true)).toBe(true);
    expect(excluded("", "packages/app/node_modules", true)).toBe(true);
    expect(excluded("", "node_modules/react/index.js")).toBe(true);
    expect(excluded("!node_modules", "node_modules", true)).toBe(true);
    expect(excluded("!node_modules/react", "node_modules/react/index.js")).toBe(
      true
    );
    // …and a commit that really holds files there wins over the folder's own
    // rule, because git tracks what it has committed.
    expect(
      isIgnored(
        rules(""),
        "node_modules/react/index.js",
        false,
        (path) => path === "node_modules/react/index.js"
      )
    ).toBe(false);
  });

  test("a nested .gitignore layers over its parents', and only reaches its own directory", () => {
    const root = rules("*.log");
    const nested = addIgnoreFile(root, "!keep.log", "src");
    expect(isIgnored(nested, "src/a.log", false)).toBe(true);
    expect(isIgnored(nested, "src/keep.log", false)).toBe(false);
    expect(isIgnored(nested, "keep.log", false)).toBe(true);
    expect(isIgnored(nested, "other/keep.log", false)).toBe(true);
    const deeper = addIgnoreFile(root, "*.bak\n/a.md", "src");
    expect(isIgnored(deeper, "src/a.bak", false)).toBe(true);
    expect(isIgnored(deeper, "a.bak", false)).toBe(false);
    expect(isIgnored(deeper, "src/a.md", false)).toBe(true);
    expect(isIgnored(deeper, "a.md", false)).toBe(false);
  });

  test("a committed path is never excluded, nor is a folder holding one", () => {
    // `.gitignore` holds `dist/`, and the commit holds files under it: git
    // keeps the folder and those files, and still ignores what is new there.
    const text = "dist/\n";
    const committed = COMMITTED;
    expect(isIgnored(rules(text), "dist", true, committed)).toBe(false);
    expect(isIgnored(rules(text), "dist/tracked.js", false, committed)).toBe(
      false
    );
    expect(isIgnored(rules(text), "dist/new.js", false, committed)).toBe(true);
    expect(isIgnored(rules(text), "dist/deep/new.js", false, committed)).toBe(
      true
    );
    // A committed file whose own path is in the rules: git still tracks it.
    expect(
      isIgnored(rules("dist/*"), "dist/tracked.js", false, committed)
    ).toBe(false);
  });
});
