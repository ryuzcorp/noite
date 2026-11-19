//! The browser bundle resolves `node:async_hooks` to a stub whose
//! `AsyncLocalStorage` cannot be constructed (the merge-queue storage-page
//! outage: the island chunk died at module load and no table fetch ever
//! fired). This module carries no `node:` imports, so it loads and passes
//! through with no backend — the interruption contract stays loadable and
//! passive without one. A static source walk (`check-client-node-imports`)
//! pins the no-builtin shape; this test pins the runtime pass-through.
import { describe, expect, test } from "bun:test";

describe("request-timeout without an AsyncLocalStorage backend", () => {
  test("loads and passes through with no bound", async () => {
    const mod = await import("./request-timeout");

    expect(mod.getRequestTimeoutSignal()).toBeUndefined();

    let ran = false;

    const result = mod.runWithRequestTimeout(
      new AbortController().signal,
      () => {
        ran = true;

        return 7;
      }
    );

    expect(ran).toBe(true);
    expect(result).toBe(7);
    expect(mod.withRequestTimeout(AbortSignal.timeout(1000))).toBeDefined();
  });
});
