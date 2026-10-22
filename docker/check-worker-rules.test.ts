import { describe, expect, test } from "bun:test";

import { checkSharedInflight, checkStoreReads } from "./check-worker-rules";

describe("checkSharedInflight", () => {
  test("a module-level in-flight promise map is a violation", () => {
    const violations = checkSharedInflight(
      "apps/noite/src/lib/server/x.ts",
      ["const inflight = new Map<string, Promise<void>>();", ""].join("\n")
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("no-shared-inflight");
    expect(violations[0]?.line).toBe(1);
  });

  test("the waitUntil-registered setup pass is allowed", () => {
    const violations = checkSharedInflight(
      "apps/noite/src/lib/db.ts",
      ["const setupPasses = new WeakMap<D1Database, SetupPass>();", ""].join(
        "\n"
      )
    );

    expect(violations).toEqual([]);
  });

  test("the same shape anywhere else is not allowed", () => {
    const violations = checkSharedInflight(
      "apps/noite/src/lib/server/other.ts",
      ["const setupPasses = new Map<string, Promise<void>>();", ""].join("\n")
    );

    expect(violations).toHaveLength(1);
  });

  test("constants and per-request maps are not violations", () => {
    const source = [
      'const FLAG_VALUES = new Set(["0", "1"]);',
      "export const run = async (): Promise<void> => {",
      "  const inflight = new Map<string, Promise<void>>();",
      "  await inflight.get(key);",
      "};",
      "",
    ].join("\n");

    expect(
      checkSharedInflight("apps/noite/src/lib/server/x.ts", source)
    ).toEqual([]);
  });

  test("an action handler passed to a factory is not a stored promise", () => {
    const source = [
      "export const get = apiAction(",
      "  AppId,",
      "  async (appId, { env, request }): Promise<AppDetail> => {",
      "    return detail;",
      "  }",
      ");",
      "",
    ].join("\n");

    expect(
      checkSharedInflight("apps/noite/src/lib/server/x.ts", source)
    ).toEqual([]);
  });

  test("commented-out shared state is not code", () => {
    const source = [
      "// const inflight = new Map<string, Promise<void>>();",
      "const ok = 1;",
      "",
    ].join("\n");

    expect(
      checkSharedInflight("apps/noite/src/lib/server/x.ts", source)
    ).toEqual([]);
  });
});

describe("checkStoreReads", () => {
  test("the bounded wrapper may read the session", () => {
    expect(
      checkStoreReads(
        "apps/noite/src/lib/server/session.server.ts",
        "    session = await auth.api.getSession({ headers });\n"
      )
    ).toEqual([]);
  });

  test("any other server file may not", () => {
    const violations = checkStoreReads(
      "apps/noite/src/lib/server/other.server.ts",
      "    session = await auth.api.getSession({ headers });\n"
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("no-unbounded-store-read");
  });
});
