// App/controller protocol compatibility: the major rule, the exact refusal,
// and the pin agreement between package.json, the lockfile and meta.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CONTROLLER_PROTOCOL,
  DEFAULT_MAX_CONCURRENT,
  VOID_MAJOR,
  VOID_VERSION,
} from "./src/meta.ts";
import {
  assertCompatibleVoidVersion,
  parseVoidMajor,
  VOID_UPGRADE_MESSAGE,
} from "./src/protocol.ts";

describe("parseVoidMajor", () => {
  test("plain versions and v-prefixes", () => {
    expect(parseVoidMajor("1.5.0")).toBe(1);
    expect(parseVoidMajor("v1.5.0")).toBe(1);
    expect(parseVoidMajor("2.0.0")).toBe(2);
    expect(parseVoidMajor("1")).toBe(1);
  });

  test("ranges resolve to their leading major", () => {
    expect(parseVoidMajor("^1.2.0")).toBe(1);
    expect(parseVoidMajor("~1.2.3")).toBe(1);
    expect(parseVoidMajor(">=1.0.0 <2.0.0")).toBe(1);
    expect(parseVoidMajor(">=2.0.0")).toBe(2);
  });

  test("unreadable specs refuse (null, never a guess)", () => {
    for (const spec of ["", "latest", "*", "github:org/repo", "next"]) {
      expect(parseVoidMajor(spec)).toBeNull();
    }
  });
});

describe("assertCompatibleVoidVersion", () => {
  test("the same major (any minor or range) passes", () => {
    for (const spec of ["1.5.0", "1.0.0", "^1.2.0", ">=1.0.0 <2.0.0"]) {
      expect(() => assertCompatibleVoidVersion(spec)).not.toThrow();
    }
  });

  test("another major refuses with Void's exact wording", () => {
    expect(VOID_UPGRADE_MESSAGE).toBe(
      "Managed Sandboxes require an updated Void runtime. Upgrade void, rebuild the app, and deploy again."
    );

    for (const spec of ["2.0.0", "0.9.0", "^2.1.0"]) {
      expect(() => assertCompatibleVoidVersion(spec)).toThrow(
        VOID_UPGRADE_MESSAGE
      );
    }
  });

  test("a missing or unreadable spec refuses", () => {
    expect(() => assertCompatibleVoidVersion()).toThrow(VOID_UPGRADE_MESSAGE);
    expect(() => assertCompatibleVoidVersion("latest")).toThrow(
      VOID_UPGRADE_MESSAGE
    );
  });

  test("a bundle that misreports its own major fails loudly", () => {
    expect(() => assertCompatibleVoidVersion("1.5.0", "2.0.0")).toThrow(
      /pins major/u
    );
  });
});

describe("bundle identity", () => {
  test("meta is self-consistent", () => {
    expect(parseVoidMajor(VOID_VERSION)).toBe(VOID_MAJOR);
    expect(VOID_MAJOR).toBe(1);
    expect(CONTROLLER_PROTOCOL).toBe(2);
    expect(DEFAULT_MAX_CONCURRENT).toBe(4);
  });

  test("package.json pins the exact void and sandbox versions meta reports", () => {
    const root = import.meta.dir;

    // SAFETY: this package's own manifest; the dependency fields below are
    // asserted key by key.
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf-8")
    ) as {
      dependencies: Record<string, string>;
    };

    expect(pkg.dependencies["void"]).toBe(VOID_VERSION);
    expect(pkg.dependencies["void"]).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(pkg.dependencies["@cloudflare/sandbox"]).toBe("1.0.3");
    // The lockfile freezes both pins for the offline image build.
    const lock = readFileSync(path.join(root, "bun.lock"), "utf-8");
    expect(lock).toContain(`void@${VOID_VERSION}`);
    expect(lock).toContain("@cloudflare/sandbox@1.0.3");
  });
});
