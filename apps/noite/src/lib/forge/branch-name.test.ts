import { describe, expect, test } from "bun:test";

import { branchNameError } from "./branch-name";

describe("branchNameError", () => {
  test("accepts ordinary branch names, including nested and dotted ones", () => {
    expect(branchNameError("main")).toBeNull();
    expect(branchNameError("feature/login")).toBeNull();
    expect(branchNameError("release/0.1.0")).toBeNull();
    expect(branchNameError("fix.v2")).toBeNull();
  });

  test("refuses an empty name and the reserved names", () => {
    expect(branchNameError("")).not.toBeNull();
    expect(branchNameError("HEAD")).not.toBeNull();
    expect(branchNameError("@")).not.toBeNull();
  });

  test("refuses the length cap and a leading dash", () => {
    expect(branchNameError("a".repeat(200))).toBeNull();
    expect(branchNameError("a".repeat(201))).not.toBeNull();
    // The cap is bytes, as the runner counts them: a 100-char name of 2-byte
    // characters is exactly 200 bytes (accepted), one more character is over.
    expect(branchNameError("é".repeat(100))).toBeNull();
    expect(branchNameError("é".repeat(101))).not.toBeNull();
    expect(branchNameError("-wip")).not.toBeNull();
  });

  test("refuses the separator and suffix cases", () => {
    for (const name of ["a/", "a.", "a..b", "a@{b", "a//b", "/a"]) {
      expect(branchNameError(name)).not.toBeNull();
    }
  });

  test("refuses spaces, controls and git's special characters", () => {
    for (const name of [
      "a b",
      "a\tb",
      "a~b",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
    ]) {
      expect(branchNameError(name)).not.toBeNull();
    }
    expect(branchNameError("a\u007Fb")).not.toBeNull();
  });

  test("refuses hidden and lock parts", () => {
    expect(branchNameError(".hidden")).not.toBeNull();
    expect(branchNameError("a/.hidden")).not.toBeNull();
    expect(branchNameError("a/b.lock")).not.toBeNull();
    expect(branchNameError("a.lock/b")).not.toBeNull();
    expect(branchNameError("a.lockfile/b")).toBeNull();
  });
});
