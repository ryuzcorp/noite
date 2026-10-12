import { describe, expect, it } from "bun:test";

import { readBindings } from "../src/bindings.ts";

describe("readBindings", () => {
  // oxlint-disable-next-line eslint/require-await -- bun:test it callbacks stay async by contract.
  it("parses a wrangler-style config", async () => {
    const config = {
      d1_databases: [
        { binding: "DB", database_name: "demo", migrations_dir: "migrations" },
      ],
      durable_objects: {
        bindings: [{ class_name: "Counter", name: "COUNTER" }],
      },
      kv_namespaces: [{ binding: "CACHE", id: "cache-id" }],
      r2_buckets: [{ binding: "FILES", bucket_name: "uploads" }],
      vars: { DEBUG: "1" },
    };
    expect(readBindings(config)).toEqual({
      d1: [
        { binding: "DB", databaseName: "demo", migrationsDir: "migrations" },
      ],
      durableObjects: [{ binding: "COUNTER", className: "Counter" }],
      kv: [{ binding: "CACHE", id: "cache-id" }],
      r2: [{ binding: "FILES", bucketName: "uploads" }],
      vars: { DEBUG: "1" },
    });
  });

  // oxlint-disable-next-line eslint/require-await -- bun:test it callbacks stay async by contract.
  it("ignores unknown shapes and empty input", async () => {
    expect(readBindings(null)).toEqual({});
    expect(
      readBindings({ not_found_handling: "single-page-application" })
    ).toEqual({});
  });
});
