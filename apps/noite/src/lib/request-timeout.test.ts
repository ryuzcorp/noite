//! The browser bundle resolves `node:async_hooks` to a stub whose
//! `AsyncLocalStorage` cannot be constructed (the merge-queue storage-page
//! outage: the island chunk died at module load and no table fetch ever
//! fired). This file mocks the builtin to that shape before the module
//! loads, proving the interruption contract stays loadable and passive
//! without a backend.
import { describe, expect, mock, test } from "bun:test";

// Bun hoists `mock.module` above the imports, so the dynamic import below
// resolves the stub — exactly the browser bundle's condition. A static
// import cannot work here: the module must load after the mock is
// installed, which is the loading boundary under test.
mock.module("node:async_hooks", () => ({
  AsyncLocalStorage: undefined,
}));

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
