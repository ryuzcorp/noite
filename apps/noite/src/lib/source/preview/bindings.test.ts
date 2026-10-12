//! The checkout's bindings as Poder's `BindingsConfig`: every kind lands on
//! its own list, names fall back to the binding when the config names no
//! store, and what Poder cannot serve (secrets, the assets binding) is left
//! out for the harness to handle around it.

import { describe, expect, test } from "bun:test";

import { poderBindings } from "./bindings";

describe("poderBindings", () => {
  test("maps every binding kind", () => {
    expect(
      poderBindings([
        { kind: "d1", name: "DB", resource: "demo" },
        { kind: "r2", name: "FILES", resource: "uploads" },
        { kind: "kv", name: "CACHE", resource: "abc" },
        { kind: "durable-object", name: "COUNTER", resource: "Counter" },
        { kind: "text", name: "GREETING", value: "hello" },
        { kind: "json", name: "LIMITS", value: { retries: 3 } },
      ])
    ).toEqual({
      d1: [{ binding: "DB", databaseName: "demo" }],
      durableObjects: [{ binding: "COUNTER", className: "Counter" }],
      kv: [{ binding: "CACHE", id: "abc" }],
      r2: [{ binding: "FILES", bucketName: "uploads" }],
      vars: { GREETING: "hello", LIMITS: { retries: 3 } },
    });
  });

  test("falls back to the binding name without a store", () => {
    expect(
      poderBindings([
        { kind: "d1", name: "DB" },
        { kind: "r2", name: "FILES" },
        { kind: "kv", name: "CACHE" },
        { kind: "durable-object", name: "Counter" },
      ])
    ).toEqual({
      d1: [{ binding: "DB", databaseName: "DB" }],
      durableObjects: [{ binding: "Counter", className: "Counter" }],
      kv: [{ binding: "CACHE", id: "CACHE" }],
      r2: [{ binding: "FILES", bucketName: "FILES" }],
    });
  });

  test("carries a wrangler migrations_dir", () => {
    expect(
      poderBindings([
        {
          kind: "d1",
          migrationsDir: "migrations",
          name: "DB",
          resource: "demo",
        },
      ])
    ).toEqual({
      d1: [
        { binding: "DB", databaseName: "demo", migrationsDir: "migrations" },
      ],
    });
  });

  test("leaves secrets and the assets binding out", () => {
    expect(
      poderBindings([
        { kind: "secret", name: "TOKEN" },
        { kind: "assets", name: "ASSETS" },
      ])
    ).toEqual({});
  });

  test("skips vars without a plain value", () => {
    expect(
      poderBindings([{ kind: "text", name: "EMPTY", value: null }])
    ).toEqual({});
  });
});
