// Bundle: the fixed single-file build keeps platform imports external,
// ships both DO classes, leaks no test code, and records an integral meta.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { buildControllerBundle, writeControllerBundle } from "./build.ts";
import type { BundleMeta } from "./build.ts";
import { CONTROLLER_PROTOCOL, VOID_VERSION } from "./src/meta.ts";

describe("buildControllerBundle", () => {
  test("emits one file with platform imports external and npm bundled", async () => {
    const bundle = await buildControllerBundle();
    expect(bundle.source.length).toBeGreaterThan(0);
    // Provided by the deploy bundler and the runtime, never bundled in.
    expect(bundle.source).toContain("cloudflare:workers");
    expect(bundle.source).toContain("node:os");
    // Bundled away: no bare npm import may survive.
    expect(bundle.source).not.toContain("void/_sandbox-container");
    expect(bundle.source).not.toContain("@cloudflare/sandbox");
    expect(bundle.source).not.toContain('from"zod');
    // Both DO classes ship in the bundle.
    expect(bundle.source).toContain("SandboxController");
    expect(bundle.source).toContain("NoiteSandboxAdmission");
    expect(bundle.source).toContain("__VOID_SANDBOX_MAX_CONCURRENT");
    // No test code leaks in.
    expect(bundle.source).not.toContain("FakeStorage");
    expect(bundle.source).not.toContain("test-setup");
    expect(bundle.source).not.toContain("storage boom");
  });

  test("the build is byte-deterministic", async () => {
    const first = await buildControllerBundle();
    const second = await buildControllerBundle();
    expect(second.source).toBe(first.source);
    expect(second.sha256).toBe(first.sha256);
  });
});

describe("writeControllerBundle", () => {
  test("writes worker.js and an integral meta.json", async () => {
    // Test I/O stays on the repo filesystem (`dist/` is gitignored and never
    // enters the image context): the shared tmpfs is quota-tight.
    const outdir = path.join(import.meta.dir, "dist", `test-${process.pid}`);
    rmSync(outdir, { force: true, recursive: true });

    try {
      const { metaPath, workerPath } = await writeControllerBundle(outdir);
      expect(workerPath).toBe(path.join(outdir, "worker.js"));
      expect(metaPath).toBe(path.join(outdir, "meta.json"));

      // SAFETY: `writeControllerBundle` wrote this file above; the shape is
      // asserted field by field below.
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as BundleMeta;

      expect(meta).toEqual({
        bundleSha256: expect.any(String),
        controllerProtocol: CONTROLLER_PROTOCOL,
        void: VOID_VERSION,
      });
      expect(meta.bundleSha256).toMatch(/^[0-9a-f]{64}$/u);
      const bytes = readFileSync(workerPath, "utf-8");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        meta.bundleSha256
      );
    } finally {
      rmSync(outdir, { force: true, recursive: true });
    }
  });
});
