import { describe, expect, it } from "bun:test";

import { createPoder } from "../src/index.ts";
import type { PoderR2, PoderR2Object } from "../src/r2.ts";
import { bunDriver, makeProjectDir, makeStateDir } from "./driver.ts";

const makeBucket = async (): Promise<{
  bucket: PoderR2;
  dispose: () => Promise<void>;
}> => {
  const poder = await createPoder({
    bindings: { r2: [{ binding: "FILES", bucketName: "uploads" }] },
    projectDir: makeProjectDir(),
    sqlite: bunDriver,
    stateDir: makeStateDir(),
    workerModule: {},
  });
  // SAFETY: env.FILES is the PoderR2 this test bound; asserted once at the test boundary.
  const bucket = poder.env["FILES"] as PoderR2;
  return { bucket, dispose: () => poder.dispose() };
};

describe("R2", () => {
  it("puts and gets objects with metadata", async () => {
    const { bucket, dispose } = await makeBucket();
    try {
      const put = await bucket.put("hello.txt", "hello world", {
        customMetadata: { author: "poder" },
        httpMetadata: { contentType: "text/plain" },
      });
      expect(put.size).toBe(11);
      expect(put.etag).toMatch(/^[0-9a-f]{32}$/u);
      expect(put.version).toBeString();
      expect(put.checksums.sha256).toBeString();

      const got = await bucket.get("hello.txt");
      expect(await got?.text()).toBe("hello world");
      if (got === null) {
        throw new Error("test setup failed: missing object");
      }
      expect(new TextDecoder().decode(await got.arrayBuffer())).toBe(
        "hello world"
      );
      const blob = await got.blob();
      expect(await blob.text()).toBe("hello world");
      expect(got?.httpMetadata.contentType).toBe("text/plain");
      expect(got?.customMetadata["author"]).toBe("poder");

      const head = await bucket.head("hello.txt");
      expect(head?.size).toBe(11);
      expect(head?.body).toBeNull();

      expect(await bucket.get("missing")).toBeNull();
    } finally {
      await dispose();
    }
  });

  it("serves ranges including suffix ranges", async () => {
    const { bucket, dispose } = await makeBucket();
    try {
      await bucket.put("data.bin", "0123456789");
      const head = await bucket.get("data.bin", {
        range: { length: 3, offset: 2 },
      });
      expect(await head?.text()).toBe("234");
      const tail = await bucket.get("data.bin", { range: { suffix: 4 } });
      expect(await tail?.text()).toBe("6789");
      const rest = await bucket.get("data.bin", { range: { offset: 8 } });
      expect(await rest?.text()).toBe("89");
    } finally {
      await dispose();
    }
  });

  it("applies conditional onlyIf (bodyless object on mismatch)", async () => {
    const { bucket, dispose } = await makeBucket();
    try {
      const put = await bucket.put("cond.txt", "v1");
      const matched = await bucket.get("cond.txt", {
        onlyIf: { etagMatches: put.etag },
      });
      expect(await matched?.text()).toBe("v1");
      // SAFETY: conditional get returns a bodyless PoderR2Object on etag mismatch, null only when missing.
      const mismatched = (await bucket.get("cond.txt", {
        onlyIf: { etagMatches: "deadbeefdeadbeefdeadbeefdeadbeef" },
      })) as PoderR2Object | null;
      expect(mismatched).not.toBeNull();
      expect(mismatched?.body).toBeNull();
      expect(mismatched?.etag).toBe(put.etag);
      const excluded = await bucket.get("cond.txt", {
        onlyIf: { etagDoesNotMatch: put.etag },
      });
      expect(excluded?.body).toBeNull();
    } finally {
      await dispose();
    }
  });

  it("deletes one or many keys", async () => {
    const { bucket, dispose } = await makeBucket();
    try {
      await bucket.put("a", "1");
      await bucket.put("b", "2");
      await bucket.delete("a");
      expect(await bucket.get("a")).toBeNull();
      await bucket.delete(["b", "never-existed"]);
      expect(await bucket.get("b")).toBeNull();
    } finally {
      await dispose();
    }
  });

  it("lists with prefix, delimiter, cursor and limit", async () => {
    const { bucket, dispose } = await makeBucket();
    try {
      await bucket.put("docs/a.txt", "a");
      await bucket.put("docs/b.txt", "b");
      await bucket.put("docs/sub/c.txt", "c");
      await bucket.put("other.txt", "o");

      const prefixed = await bucket.list({ prefix: "docs/" });
      expect(prefixed.objects.map((object) => object.key).toSorted()).toEqual([
        "docs/a.txt",
        "docs/b.txt",
        "docs/sub/c.txt",
      ]);

      const delimited = await bucket.list({ delimiter: "/", prefix: "docs/" });
      expect(delimited.objects.map((object) => object.key).toSorted()).toEqual([
        "docs/a.txt",
        "docs/b.txt",
      ]);
      expect(delimited.delimitedPrefixes).toEqual(["docs/sub/"]);

      const first = await bucket.list({ limit: 2, prefix: "docs/" });
      expect(first.truncated).toBe(true);
      expect(first.objects).toHaveLength(2);
      expect(first.cursor).toBeString();
      const second = await bucket.list({
        cursor: first.cursor,
        limit: 2,
        prefix: "docs/",
      });
      expect(second.truncated).toBe(false);
      expect(second.objects).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it("round-trips multipart uploads and aborts", async () => {
    const { bucket, dispose } = await makeBucket();
    try {
      const upload = await bucket.createMultipartUpload("big.bin");
      await upload.uploadPart(2, "world");
      await upload.uploadPart(1, "hello ");
      const resumed = await bucket.resumeMultipartUpload(
        "big.bin",
        upload.uploadId
      );
      const done = await resumed.complete([
        { partNumber: 1 },
        { partNumber: 2 },
      ]);
      expect(await done.text()).toBe("hello world");
      const finished = await bucket.get("big.bin");
      expect(await finished?.text()).toBe("hello world");

      const doomed = await bucket.createMultipartUpload("gone.bin");
      await doomed.uploadPart(1, "x");
      await doomed.abort();
      await expect(
        bucket.resumeMultipartUpload("gone.bin", doomed.uploadId)
      ).rejects.toThrow();
    } finally {
      await dispose();
    }
  });

  it("verifies content checksums on put", async () => {
    const { bucket, dispose } = await makeBucket();
    try {
      const good = await bucket.put("checked.txt", "abc");
      expect(good.checksums.md5).toBe("900150983cd24fb0d6963f7d28e17f72");
      await expect(
        bucket.put("checked.txt", "abc", {
          md5: "00000000000000000000000000000000",
        })
      ).rejects.toThrow("checksum mismatch");
      const fromHex = await bucket.put("checked.txt", "abc", {
        sha256: good.checksums.sha256,
      });
      expect(fromHex.etag).toBe(good.etag);
    } finally {
      await dispose();
    }
  });

  it("rejects keys that escape the bucket", async () => {
    const { bucket, dispose } = await makeBucket();
    try {
      await expect(bucket.put("../escape.txt", "x")).rejects.toThrow(
        "escapes its bucket"
      );
    } finally {
      await dispose();
    }
  });
});
