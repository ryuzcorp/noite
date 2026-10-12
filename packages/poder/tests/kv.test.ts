import { describe, expect, it } from "bun:test";

import { createPoder } from "../src/index.ts";
import type { PoderKV } from "../src/kv.ts";
import { bunDriver, makeProjectDir, makeStateDir } from "./driver.ts";

const makeKV = async (): Promise<{
  kv: PoderKV;
  dispose: () => Promise<void>;
}> => {
  const poder = await createPoder({
    bindings: { kv: [{ binding: "CACHE", id: "cache-id" }] },
    projectDir: makeProjectDir(),
    sqlite: bunDriver,
    stateDir: makeStateDir(),
    workerModule: {},
  });
  // SAFETY: env.CACHE is the PoderKV this test bound; asserted once at the test boundary.
  const kv = poder.env["CACHE"] as PoderKV;
  return { dispose: () => poder.dispose(), kv };
};

describe("KV", () => {
  it("gets values as text, json, bytes and stream", async () => {
    const { kv, dispose } = await makeKV();
    try {
      await kv.put("greeting", "hello");
      expect(await kv.get("greeting")).toBe("hello");
      expect(await kv.get("greeting", "text")).toBe("hello");

      await kv.put("doc", JSON.stringify({ n: 1 }));
      expect(await kv.get("doc", "json")).toEqual({ n: 1 });

      await kv.put("raw", new TextEncoder().encode("bytes"));
      // SAFETY: raw was put as bytes; arrayBuffer get returns an ArrayBuffer.
      const buffer = (await kv.get("raw", "arrayBuffer")) as ArrayBuffer;
      expect(new TextDecoder().decode(buffer)).toBe("bytes");

      // SAFETY: raw was put as bytes; stream get returns a byte stream.
      const stream = (await kv.get(
        "raw",
        "stream"
      )) as ReadableStream<Uint8Array>;
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- stream reads are sequential by protocol.
        const next = await reader.read();
        if (next.done) {
          break;
        }
        chunks.push(next.value);
      }
      expect(
        chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")
      ).toBe("bytes");

      expect(await kv.get("missing")).toBeNull();
    } finally {
      await dispose();
    }
  });

  it("returns metadata and expires entries", async () => {
    const { kv, dispose } = await makeKV();
    try {
      await kv.put("with-meta", "v", { metadata: { tag: "t" } });
      const seen = await kv.getWithMetadata("with-meta");
      expect(seen.value).toBe("v");
      expect(seen.metadata).toEqual({ tag: "t" });

      await kv.put("already-gone", "v", {
        expiration: Math.floor(Date.now() / 1000) - 10,
      });
      expect(await kv.get("already-gone")).toBeNull();

      await kv.put("short-lived", "v", { expirationTtl: 60 });
      expect(await kv.get("short-lived")).toBe("v");

      await expect(
        kv.put("too-short", "v", { expirationTtl: 10 })
      ).rejects.toThrow();
    } finally {
      await dispose();
    }
  });

  it("deletes and lists with prefix, limit and cursor", async () => {
    const { kv, dispose } = await makeKV();
    try {
      await kv.put("user:1", "a", { metadata: { n: 1 } });
      await kv.put("user:2", "b");
      await kv.put("session:1", "c");
      await kv.delete("session:1");
      expect(await kv.get("session:1")).toBeNull();

      const first = await kv.list({ limit: 1, prefix: "user:" });
      expect(first.keys.map((key) => key.name)).toEqual(["user:1"]);
      expect(first.keys[0]?.metadata).toEqual({ n: 1 });
      expect(first.list_complete).toBe(false);
      expect(first.cursor).toBeString();

      const second = await kv.list({
        cursor: first.cursor,
        limit: 1,
        prefix: "user:",
      });
      expect(second.keys.map((key) => key.name)).toEqual(["user:2"]);
      expect(second.list_complete).toBe(true);
    } finally {
      await dispose();
    }
  });
});
