//! The server generated for the pod: Poder wired to the Worker's bindings,
//! assets first, Cloudflare's fallback order, and nothing the pod's type
//! stripper can mistake for an annotation.

import { describe, expect, test } from "bun:test";

import { HARNESS_STATE_DIR, serverSource } from "./server";

const plan = {
  assets: "/home/project/dist",
  bindings: [
    { kind: "d1", name: "DB", resource: "demo" },
    { kind: "secret", name: "TOKEN" },
  ],
  entry: "/home/.noite/preview/.cache/worker/index.js",
  notFoundHandling: "single-page-application",
  port: 4444,
} as const;

describe("serverSource", () => {
  test("serves the Worker through Poder with its bindings", () => {
    const source = serverSource({
      ...plan,
      bindings: [...plan.bindings],
    });
    expect(source).toContain(
      'const { createPoder, defaultSqliteDriver } = await import("./poder/index.mjs");'
    );
    expect(source).toContain(
      'const workerModule = await import("/home/.noite/preview/.cache/worker/index.js");'
    );
    expect(source).toContain(`"databaseName":"demo"`);
    expect(source).toContain(`stateDir: "${HARNESS_STATE_DIR}"`);
    expect(source).toContain("await sqlite.preloadSqlite");
    expect(source).toContain("options.sqlite = sqliteDriver");
    expect(source).toContain("SQLITE_PATH_CAP = 56");
    expect(source).toContain("await poder.fetch(request)");
    expect(source).toContain('const MISSING = ["TOKEN"]');
  });

  test("a static checkout serves assets with no Worker", () => {
    const source = serverSource({
      assets: "/home/project/public",
      bindings: [],
      entry: null,
      notFoundHandling: "404-page",
      port: 4445,
    });
    expect(source).toContain("const workerModule = null;");
    expect(source).toContain("if (poder === null)");
    expect(source).toContain("port: 4445");
  });
});
